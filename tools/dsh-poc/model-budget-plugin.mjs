import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { Db } from '../../core/src/db.ts'
import { Ledger } from '../../core/src/ledger/ledger.ts'
import { estimate } from '../../core/src/ledger/rules.ts'
import { finite } from '../../core/src/ledger/types.ts'
import { AutonomyBudget } from '../../core/src/modules/autonomy/budget.ts'
import { channelModel, installRouting } from './model-routing.mjs'

export const name = 'dreamflutter-model-budget'
export const inject = ['llm', 'agents']

const channelPrefix = 'df-'
const source = 'chat'
const stopReasons = { stop: 'stop', 'max-tokens': 'length', 'tool-calls': 'toolUse', error: 'error', aborted: 'aborted' }

function failure(code, message) {
  return { type: 'finish', reason: { kind: 'error', failure: { code, message } } }
}

function metering(options, usage, finish, startedAt) {
  const stopReason = stopReasons[finish?.kind]
  if (!usage || !stopReason) return undefined
  const counts = {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens ?? 0,
    cacheWrite: usage.cacheWriteTokens ?? 0,
  }
  // Some wire adapters surface a default zero counter when the response omits usage.
  if (Object.values(counts).some(count => finite(count) === null) || Object.values(counts).every(count => count === 0)) {
    return undefined
  }
  return {
    provider: options.provider, model: options.model, timestamp: startedAt, stopReason,
    usage: { ...counts, reasoning: usage.reasoningTokens, totalTokens: usage.totalTokens },
  }
}

function reservation(model, options) {
  const prices = [model.cost?.input, model.cost?.output, model.cost?.cacheRead, model.cost?.cacheWrite]
  if (prices.some(price => finite(price) === null) || prices.every(price => price === 0)) return null
  if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0) return null

  // A text-only POC estimate. Charge every serialized byte at the highest
  // input-side rate and cover the complete output cap. Provider-added overhead
  // and image tokenization require their own measurement before production use.
  const input = Buffer.byteLength(JSON.stringify({ messages: options.messages, system: options.system, tools: options.tools }))
  const maxInput = Math.max(model.cost.input, model.cost.cacheRead, model.cost.cacheWrite)
  return estimate({ ...model, cost: { ...model.cost, input: maxInput } }, {
    input, output: options.maxTokens, cacheRead: 0, cacheWrite: 0,
  })
}

export function apply(ctx, config) {
  if (typeof config?.database !== 'string' || !isAbsolute(config.database) || finite(config.dailyUsd) === null) {
    throw new Error('模型预算插件需要独立数据库的绝对路径和有效的每日美元额度')
  }

  const db = new Db(config.database)
  ctx.effect(() => () => db.close())
  // The real Ledger only needs the database and these two Core registration
  // surfaces. Its 1.0 RPC and backup registration are outside the POC host.
  const ledger = new Ledger({ db, declareBackup() {}, register() {} })
  ctx.effect(() => () => ledger.stop())
  const budget = new AutonomyBudget(db, () => config.dailyUsd)
  installRouting(ctx, db)

  ctx.on('llm/stream', async function* (options, next) {
    if (!options.provider.startsWith(channelPrefix)) {
      yield* next()
      return
    }
    options.signal?.throwIfAborted()
    const { channel, model } = channelModel(db, options.provider.slice(channelPrefix.length), options.model)
    if (!channel?.enabled || !model) {
      yield failure('DF_MODEL_UNAVAILABLE', '找不到已启用的渠道模型')
      return
    }
    const pricedModel = { ...model, provider: options.provider, api: channel.api, baseUrl: channel.base_url }
    const held = reservation(pricedModel, options)
    if (held === null) {
      yield failure('DF_MODEL_PRICE_UNAVAILABLE', '缺少模型价格或输出上限，无法预留预算')
      return
    }

    const id = randomUUID()
    if (!budget.reserve(held, source, id)) {
      yield failure('DF_DAILY_BUDGET_EXCEEDED', '本次请求预计花费超过今日剩余预算')
      return
    }

    const startedAt = Date.now()
    try {
      ledger.begin(pricedModel, {
        purpose: options.purpose === undefined ? 'conversation' : 'auxiliary', sessionId: options.sessionId,
      }, startedAt, id)
    } catch (error) {
      budget.settle(source, id, null)
      throw error
    }

    let usage, finish, firstTokenAt
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') usage = chunk.usage
        if (chunk.type === 'finish') finish = chunk.reason
        if (firstTokenAt === undefined && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')) {
          firstTokenAt = Date.now()
        }
        yield chunk
      }
    } finally {
      const message = metering(options, usage, finish ?? { kind: options.signal?.aborted ? 'aborted' : 'error' }, startedAt)
      const errorCode = finish?.failure?.code ?? (finish === undefined ? 'stream_closed_without_final_usage' : undefined)
      try {
        ledger.timing(id, firstTokenAt)
        // For a failed stream, persist only counts actually surfaced by DSH.
        // RawUsage.final allows Ledger to retain these facts with success=0.
        ledger.finish(id, pricedModel, message, message && { final: true }, Date.now(), errorCode)
      } finally {
        const receipt = db.get('SELECT currency,amount FROM request_ledger WHERE id=?', id)
        const amount = receipt?.currency === 'USD' ? finite(receipt.amount) : null
        // DSH's failed usage chunk has no completeness marker. Keep at least
        // the hold for a failed stream, while preserving observed counts above.
        const failed = !finish || finish.kind === 'error' || finish.kind === 'aborted'
        budget.settle(source, id, amount === null ? 'estimated' : failed ? Math.max(amount, held) : amount)
      }
    }
  })
}
