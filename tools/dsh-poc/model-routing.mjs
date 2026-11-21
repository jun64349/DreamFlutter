import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { parseJson } from '../../core/src/db.ts'
import { channelProvider, GROUP_PROVIDER } from '../../core/src/gateway/gateway.ts'
import { pickEntry } from '../../core/src/gateway/router.ts'

function modelGroups(db) {
  return db.all('SELECT id,name,entries,allow_paid_overflow FROM gateway_groups ORDER BY sort,created_at').map(row => ({
    id: row.id, name: row.name, entries: parseJson(row.entries, []), allowPaidOverflow: row.allow_paid_overflow === 1,
  }))
}

export function channelModel(db, channelId, modelId) {
  const channel = db.get('SELECT id,name,kind,api,base_url,models,enabled FROM gateway_channels WHERE id=?', channelId)
  return { channel, model: parseJson(channel?.models, []).find(model => model.id === modelId) }
}

class GroupAdapter extends LlmAdapter {
  constructor(db) {
    super()
    this.db = db
  }

  async listModels(provider) {
    return modelGroups(this.db).map(({ id, name }) => ({ provider, id, name }))
  }

  async * stream() {
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'DF_MODEL_GROUP_UNROUTED', message: '模型组尚未选定渠道' } },
    }
  }
}

export function installRouting(ctx, db) {
  // The SDK checks that its initial provider is registered. The group adapter is
  // only a selector, so any accidental direct dispatch fails before transport.
  ctx.llm.registerAdapter([GROUP_PROVIDER], new GroupAdapter(db))
  ctx.on('agent/created', ({ agent }) => {
    const requested = agent.model.current()
    if (requested?.provider !== GROUP_PROVIDER) return
    const group = modelGroups(db).find(group => group.id === requested.model)
    if (!group) throw new Error(`找不到模型组「${requested.model}」`)

    const providers = new Set(ctx.llm.listProviders().map(provider => provider.id))
    const decision = pickEntry(group, entry => {
      const { channel, model } = channelModel(db, entry.channel, entry.model)
      const unavailable = channel && !channel.enabled
        ? { kind: 'disabled', message: '已停用' }
        : channel && model && providers.has(channelProvider(entry.channel))
          ? null
          : { kind: 'missing', message: '找不到这个渠道或模型' }
      return { kind: channel?.kind ?? 'payg', name: channel?.name ?? entry.channel, unavailable }
    }, undefined, undefined)

    if (!decision.ok) throw new Error(decision.message)
    agent.model.select({
      provider: channelProvider(decision.entry.channel),
      model: decision.entry.model,
      reasoningEffort: requested.reasoningEffort,
    })
  })
}
