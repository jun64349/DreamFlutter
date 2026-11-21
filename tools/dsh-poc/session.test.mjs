import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

// Only the model endpoint is simulated. The SDK, Cordis profile and JSONL writer
// run in the official CLI subprocess, including Windows file locking.
function streamReply(response, text) {
  const events = [
    { type: 'message_start', message: { id: 'local-reply', model: 'deepseek-v4-pro', usage: { input_tokens: 8, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const event of events) {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  }
  response.end()
}

function childEnvironment(root, port) {
  const env = {}
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'SYSTEMDRIVE']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return {
    ...env,
    HOME: root, USERPROFILE: root, LOCALAPPDATA: root, APPDATA: root,
    AGENTS_HOME: join(root, 'agents'), DSH_TELEMETRY_DISABLED: '1',
    TEMP: root, TMP: root, TMPDIR: root,
    DEEPSEEK_API_KEY: 'local-poc-only',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}`,
  }
}

function hasMessage(messages, role, text) {
  return messages.some(message => message.role === role && (
    message.content === text || (
      Array.isArray(message.content) && message.content.some(block => block.type === 'text' && block.text === text)
    )
  ))
}

async function readSessionLog(home) {
  const sessions = join(home, 'sessions')
  const logs = (await readdir(sessions, { recursive: true })).filter(path => path.endsWith('.jsonl'))
  assert.equal(logs.length, 1, 'expected one uncompressed DSH session log')
  const raw = await readFile(join(sessions, logs[0]), 'utf8')
  return raw.trimEnd().split('\n').map(line => JSON.parse(line))
}

test('sdk-minimal restores the first turn from disk in a fresh DSH process', { timeout: 180_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dreamflutter-dsh-'))
  const home = join(root, 'harness')
  const workspace = join(root, '工作区 with spaces')
  const requests = []
  const replies = ['第一轮已记录。', '第二轮已记录。']
  const prompts = ['请记下：纸蝶七号。', '继续上一轮。']
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url.split('?')[0].endsWith('/messages') || requests.length >= replies.length) {
      response.writeHead(400).end()
      return
    }
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const { messages } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      requests.push(messages)
      streamReply(response, replies[requests.length - 1])
    } catch {
      response.writeHead(400).end()
    }
  })
  try {
    await mkdir(workspace)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const options = {
      profile: 'sdk-minimal', model: 'deepseek-v4-pro', provider: 'deepseek-official',
      dshHome: home, processCwd: workspace, cwd: workspace,
      env: childEnvironment(root, server.address().port),
      initializeTimeoutMs: 60_000, requestTimeoutMs: 30_000, shutdownTimeoutMs: 10_000,
    }
    const first = new DeepSeekHarness(options)
    let sessionId
    try {
      const result = await first.run(prompts[0])
      assert.equal(result.finalResponse, replies[0])
      sessionId = result.sessionId
      assert.ok(sessionId)
    } finally {
      await first.close()
    }
    const firstLog = await readSessionLog(home)
    assert.ok(firstLog.some(row => row.type === 'user/message' && JSON.stringify(row).includes(prompts[0])))

    const second = new DeepSeekHarness(options)
    try {
      const session = await second.resumeSession(sessionId)
      const result = await session.run(prompts[1])
      assert.equal(result.sessionId, sessionId)
      assert.equal(result.finalResponse, replies[1])
    } finally {
      await second.close()
    }
    assert.equal(requests.length, 2)
    assert.ok(hasMessage(requests[0], 'user', prompts[0]))
    assert.ok(hasMessage(requests[1], 'user', prompts[0]), 'lost prior user message on resume')
    assert.ok(hasMessage(requests[1], 'assistant', replies[0]), 'lost prior assistant message on resume')
    assert.ok(hasMessage(requests[1], 'user', prompts[1]))
    const finalLog = await readSessionLog(home)
    assert.deepEqual(finalLog.slice(0, firstLog.length), firstLog)
    assert.ok(finalLog.slice(firstLog.length).some(row => row.type === 'user/message' && JSON.stringify(row).includes(prompts[1])))
    t.diagnostic(`Node ${process.version} ${process.platform}/${process.arch}, ${requests.length} loopback requests, JSONL ${firstLog.length} -> ${finalLog.length} rows`)
  } finally {
    if (server.listening) {
      const closed = once(server, 'close')
      server.close()
      server.closeAllConnections()
      await closed
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
})
