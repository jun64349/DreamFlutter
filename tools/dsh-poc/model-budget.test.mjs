import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { Db } from '../../core/src/db.ts'
import { AutonomyBudget } from '../../core/src/modules/autonomy/budget.ts'

const groupId = 'poc-group'
const primary = { id: 'primary', model: 'poc-primary', api: 'anthropic-messages' }
const secondary = { id: 'secondary', model: 'poc-secondary', api: 'openai-responses' }
const primaryText = '主渠道已回复。'
const secondaryText = '备用渠道已回复。'
const prices = { input: 1, output: 4, cacheRead: 0.2, cacheWrite: 2 }
const dailyCap = 0.025

function messagesEvents(model, text) {
  return [
    { type: 'message_start', message: { id: 'poc-a', model, usage: { input_tokens: 20, cache_read_input_tokens: 7, cache_creation_input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
    { type: 'message_stop' },
  ]
}

function responsesEvents(model, text) {
  const item = { id: 'msg_poc', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
  return [
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: {
      id: 'resp_poc', model, status: 'completed', output: [item],
      usage: {
        input_tokens: 50, input_tokens_details: { cached_tokens: 20 }, output_tokens: 10,
        output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 60,
      },
    } },
  ]
}

function reply(response, events) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  response.end()
}

function environment(root) {
  const env = {}
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'SYSTEMDRIVE']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return {
    ...env,
    HOME: root, USERPROFILE: root, LOCALAPPDATA: root, APPDATA: root, TEMP: root, TMP: root, TMPDIR: root,
    AGENTS_HOME: join(root, 'agents'), DSH_TELEMETRY_DISABLED: '1',
    DSH_POC_LOOPBACK_KEY: 'local-poc-only',
  }
}

test('DSH selects two physical routes, guards concurrent spending and settles real usage counters', { timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dreamflutter-dsh-model-'))
  const dbPath = join(root, 'dreamflutter.sqlite')
  const requests = []
  const failureHolds = []
  const secondaryArrived = Promise.withResolvers()
  const releaseSecondary = Promise.withResolvers()
  const secondaryBodies = []
  const server = createServer(async (request, response) => {
    try {
      const parts = []
      for await (const part of request) parts.push(part)
      const body = JSON.parse(Buffer.concat(parts).toString('utf8'))
      const path = request.url.split('?')[0]
      requests.push({ method: request.method, path, model: body.model, maxTokens: body.max_tokens ?? body.max_output_tokens })
      if (request.method === 'POST' && path === '/primary/v1/messages' && body.model === primary.model) {
        const events = messagesEvents(body.model, primaryText)
        const messages = JSON.stringify(body.messages)
        if (messages.includes('故障')) {
          failureHolds.push(db.get('SELECT ref_id,estimate_usd FROM autonomy_budget_holds'))
          if (messages.includes('故障不返回用量')) response.writeHead(400).end()
          else reply(response, events.slice(0, 4))
        } else reply(response, events)
      } else if (request.method === 'POST' && path === '/secondary/v1/responses' && body.model === secondary.model) {
        secondaryBodies.push(body)
        secondaryArrived.resolve()
        await releaseSecondary.promise
        reply(response, responsesEvents(body.model, secondaryText))
      } else {
        response.writeHead(400).end()
      }
    } catch {
      response.destroy()
    }
  })
  let db, harness
  try {
    const workspace = join(root, '工作区 with spaces')
    const patch = join(root, 'cordis.patch.yml')
    await mkdir(workspace)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const endpoint = `http://127.0.0.1:${server.address().port}`
    db = new Db(dbPath)
    const providers = {}
    db.transaction(() => {
      for (const channel of [primary, secondary]) {
        const baseURL = `${endpoint}/${channel.id}${channel.api === 'openai-responses' ? '/v1' : ''}`
        const model = { id: channel.model, contextWindow: 16_384, maxTokens: 256, cost: prices }
        // Use the 1.0 persisted channel/group shape. No real gateway keys are loaded.
        db.run(`INSERT INTO gateway_channels(id,name,kind,api,base_url,models,created_at) VALUES (?,?,?,?,?,?,?)`,
          channel.id, channel.id, 'payg', channel.api, baseURL, JSON.stringify([model]), Date.now())
        providers[`df-${channel.id}`] = {
          api: channel.api, baseURL, apiKeyEnv: 'DSH_POC_LOOPBACK_KEY',
          models: [{ id: model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens }],
          retryPolicy: { mode: 'normal', maxRetries: 0 },
        }
      }
      const entries = [
        { channel: secondary.id, model: secondary.model, priority: 1, weight: 0 },
        { channel: primary.id, model: primary.model, priority: 0, weight: 0 },
      ]
      db.run('INSERT INTO gateway_groups (id,name,entries,created_at) VALUES (?,?,?,?)', groupId, '验证用模型组', JSON.stringify(entries), Date.now())
    })
    await writeFile(patch, JSON.stringify([
      { id: 'llm-deepseek', disabled: true },
      { insert: [
        { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers } },
        { id: 'df-model-budget', name: new URL('./model-budget-plugin.mjs', import.meta.url).href, config: { database: dbPath, dailyUsd: dailyCap } },
      ] },
    ]))
    harness = new DeepSeekHarness({
      profile: 'sdk-minimal', patches: [patch], provider: 'dreamflutter', model: groupId, maxTokens: 256,
      dshHome: join(root, 'dsh'), processCwd: workspace, cwd: workspace, env: environment(root),
      initializeTimeoutMs: 30_000, requestTimeoutMs: 20_000, shutdownTimeoutMs: 10_000,
    })

    const first = await harness.run('验证首选模型。')
    assert.equal(first.finalResponse, primaryText, JSON.stringify({ requests, reason: first.finishReason, events: first.events.slice(-3) }))
    assert.equal(first.events.find(event => event.type === 'request/header')?.data.header.config.provider, 'df-primary')
    db.run('UPDATE gateway_channels SET enabled=0 WHERE id=?', primary.id)
    const samePrompt = '验证备用模型。'
    const budget = new AutonomyBudget(db, () => dailyCap)
    let spendAtRejection
    const pending = harness.run(samePrompt, { sessionId: 'poc-allowed' })
    try {
      const earlyResult = await Promise.race([secondaryArrived.promise, pending])
      assert.equal(earlyResult, undefined, `备用请求未到达回环端点：${earlyResult?.finalResponse ?? ''}`)
      const hold = db.get('SELECT ref_id,estimate_usd FROM autonomy_budget_holds')
      assert.ok(hold?.estimate_usd > 0)
      const seed = dailyCap - budget.spentToday() - 1.5 * hold.estimate_usd
      assert.ok(seed > 0)
      budget.record(seed, 'chat', 'prior-usage-fixture')
      spendAtRejection = budget.spentToday()
      assert.ok(dailyCap - budget.spentToday() > hold.estimate_usd)
      assert.equal(budget.check(hold.estimate_usd, 'chat').ok, false)

      const blocked = await harness.run(samePrompt, { sessionId: 'poc-blocked' })
      assert.equal(blocked.finishReason, 'error')
      assert.equal(blocked.events.find(event => event.type === 'request/header')?.data.header.config.provider, 'df-secondary')
      const rejection = blocked.events.find(event => event.type === 'turn/end')?.data.reason.error
      assert.deepEqual(rejection, { code: 'DF_DAILY_BUDGET_EXCEEDED', message: '本次请求预计花费超过今日剩余预算' })
      assert.equal(requests.length, 2, 'blocked request reached HTTP endpoint')
      assert.equal(db.get('SELECT COUNT(*) AS count FROM request_ledger WHERE session_id=?', blocked.sessionId).count, 0)
      assert.equal(db.get('SELECT COUNT(*) AS count FROM autonomy_budget_holds').count, 1)
      assert.equal(db.get('SELECT state FROM request_ledger WHERE id=?', hold.ref_id).state, 'pending')
    } finally {
      releaseSecondary.resolve()
      await pending.catch(() => {})
    }
    const second = await pending
    assert.equal(second.finalResponse, secondaryText)
    assert.equal(second.events.find(event => event.type === 'request/header')?.data.header.config.provider, 'df-secondary')
    const responseCost = db.get('SELECT amount FROM request_ledger WHERE session_id=?', second.sessionId).amount
    // Restore the same settled spending by adjusting only the synthetic prior
    // receipt. The positive control now runs at the rejected call's exact
    // pre-request spend and route, with no outstanding hold.
    db.run("UPDATE autonomy_spending SET cost_usd=cost_usd-? WHERE ref_id='prior-usage-fixture'", responseCost)
    assert.ok(Math.abs(budget.spentToday() - spendAtRejection) < 1e-12)
    assert.equal(db.get('SELECT COUNT(*) AS count FROM autonomy_budget_holds').count, 0)
    const control = await harness.run(samePrompt, { sessionId: 'poc-control' })
    assert.equal(control.finalResponse, secondaryText)
    const [{ prompt_cache_key: pendingKey, ...pendingBody }, { prompt_cache_key: controlKey, ...controlBody }] = secondaryBodies
    assert.deepEqual([pendingKey, controlKey], [second.sessionId, control.sessionId])
    assert.deepEqual(pendingBody, controlBody)
    assert.deepEqual(requests, [
      { method: 'POST', path: '/primary/v1/messages', model: primary.model, maxTokens: 256 },
      { method: 'POST', path: '/secondary/v1/responses', model: secondary.model, maxTokens: 256 },
      { method: 'POST', path: '/secondary/v1/responses', model: secondary.model, maxTokens: 256 },
    ])

    const rows = db.all(`SELECT id,session_id,channel,provider,model,state,success,input,output,cache_read,cache_write,reasoning,amount,currency,amount_source FROM request_ledger ORDER BY requested_at`)
    assert.equal(rows.length, 3)
    const expected = [
      { session: first.sessionId, channel: primary, counts: [20, 8, 7, 3], amount: 0.0000594 },
      { session: second.sessionId, channel: secondary, counts: [30, 10, 20, 0], amount: 0.000074 },
      { session: control.sessionId, channel: secondary, counts: [30, 10, 20, 0], amount: 0.000074 },
    ]
    for (const [index, row] of rows.entries()) {
      const { session, channel, counts, amount } = expected[index]
      assert.deepEqual([row.session_id, row.channel, row.provider, row.model], [session, channel.id, `df-${channel.id}`, channel.model])
      assert.deepEqual([row.input, row.output, row.cache_read, row.cache_write], counts)
      assert.deepEqual([row.state, row.success, row.currency, row.amount_source], ['complete', 1, 'USD', 'price_estimate'])
      assert.ok(Math.abs(row.amount - amount) < 1e-12, `expected USD ${amount}, got ${row.amount}`)
      assert.equal(db.get('SELECT cost_usd FROM autonomy_spending WHERE ref_id=?', row.id).cost_usd, row.amount)
    }
    assert.equal(rows[1].reasoning, null, 'the official Pi-AI adapter reports reasoning only in total output')
    assert.equal(db.get('SELECT COUNT(*) AS count FROM autonomy_budget_holds').count, 0)
    assert.equal(db.get('SELECT COUNT(*) AS count FROM autonomy_spending').count, 4)

    db.run("DELETE FROM autonomy_spending WHERE ref_id='prior-usage-fixture'")
    db.run('UPDATE gateway_channels SET enabled=1 WHERE id=?', primary.id)
    const failedWithUsage = await harness.run('故障保留部分用量')
    const failedWithoutUsage = await harness.run('故障不返回用量')
    assert.equal(failedWithUsage.finishReason, 'error')
    assert.equal(failedWithoutUsage.finishReason, 'error')
    const partial = db.get('SELECT * FROM request_ledger WHERE session_id=?', failedWithUsage.sessionId)
    const missing = db.get('SELECT * FROM request_ledger WHERE session_id=?', failedWithoutUsage.sessionId)
    assert.deepEqual([partial.state, partial.success, partial.input, partial.output, partial.cache_read, partial.cache_write], ['complete', 0, 20, 0, 7, 3])
    assert.deepEqual([partial.amount_source, partial.error_code], ['price_estimate', 'error'])
    assert.equal(failedWithUsage.events.find(event => event.type === 'turn/end')?.data.reason.error.code, 'TRANSPORT')
    assert.ok(Math.abs(partial.amount - 0.0000274) < 1e-12)
    assert.deepEqual([missing.state, missing.success, missing.input, missing.output, missing.amount, missing.error_code], ['missing', 0, null, null, null, 'INVALID_REQUEST'])
    assert.equal(failureHolds[0].ref_id, partial.id)
    assert.equal(failureHolds[1].ref_id, missing.id)
    for (const hold of failureHolds) {
      assert.ok(hold.estimate_usd > partial.amount)
      assert.equal(db.get('SELECT cost_usd FROM autonomy_spending WHERE ref_id=?', hold.ref_id).cost_usd, hold.estimate_usd)
    }
    assert.equal(db.get('SELECT COUNT(*) AS count FROM autonomy_budget_holds').count, 0)
    assert.equal(requests.length, 5)
    t.diagnostic(`Node ${process.version} ${process.platform}/${process.arch}, 5 HTTP calls (3 completed, 2 failed), one blocked before HTTP, successful USD ${rows.map(row => row.amount.toFixed(7)).join(' + ')}`)
  } finally {
    releaseSecondary.resolve()
    try {
      await harness?.close()
    } finally {
      db?.close()
      if (server.listening) {
        const closed = once(server, 'close')
        server.close()
        server.closeAllConnections()
        await closed
      }
      await rm(root, { recursive: true, force: true, maxRetries: 5 })
    }
  }
})
