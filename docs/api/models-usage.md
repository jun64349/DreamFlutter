# 渠道、模型、OAuth 与用量

字段后缀 `?` 表示可省略。通用传输及错误格式见[调用约定](README.md)，类型见[数据结构](types.md)。

## gateway.channels
<!-- api:method -->

- **用途** 列出渠道配置和遮蔽后的凭据概况。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `ChannelInfo[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [gateway/gateway.ts:1018](../../core/src/gateway/gateway.ts#L1018)

## gateway.fetchModels
<!-- api:method -->

- **用途** 获取现有渠道或未保存配置的模型目录。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** channel?: string；或提供未保存配置的 platform、baseUrl、api、apiKey（string，按平台所需填写）
- **返回** `DescribedModel[]`。
- **错误** `bad_request`（缺接口地址）；`network`（连接失败）；`http`（接口返回非成功状态）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [gateway/gateway.ts:1051](../../core/src/gateway/gateway.ts#L1051)

## gateway.groups
<!-- api:method -->

- **用途** 列出模型组、成员和排序。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `ModelGroup[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [gateway/gateway.ts:1036](../../core/src/gateway/gateway.ts#L1036)

## gateway.modelWindow
<!-- api:method -->

- **用途** 查询指定提供方和模型的有效上下文窗口。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `provider: string`（提供方 ID）；`model: string`（模型 ID）
- **返回** `{ value: number | null; source: string; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [gateway/gateway.ts:1025](../../core/src/gateway/gateway.ts#L1025)

## gateway.platforms
<!-- api:method -->

- **用途** 列出渠道平台预设和内置模型。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `({ modelDetails: DescribedModel[]; id: string; name: string; kind: ChannelKind; endpoints: { api: ChannelApi; baseUrl: string; }[]; quota?: QuotaSource; windows?: ("5h" | "week" | "month")[]; sharedEndpoints?: boolean; models?: string[]; modelsUrl?: string; catalog?: string; compat?: Record<string, unknown>; } | (Platform & { modelDetails: Record<string, unknown>[]; }))[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [gateway/gateway.ts:1015](../../core/src/gateway/gateway.ts#L1015)

## gateway.refreshQuota
<!-- api:method -->

- **用途** 刷新单个或全部渠道的额度。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `channel?: string`（渠道 ID）
- **返回** `ChannelStatus[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** [`gateway.changed`](events.md#gatewaychanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [gateway/gateway.ts:1066](../../core/src/gateway/gateway.ts#L1066)

## gateway.removeChannel
<!-- api:method -->

- **用途** 删除指定渠道。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（缺渠道 ID）；`busy`（Pi 迁移中）。
- **事件** [`gateway.changed`](events.md#gatewaychanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [gateway/gateway.ts:1032](../../core/src/gateway/gateway.ts#L1032)

## gateway.removeGroup
<!-- api:method -->

- **用途** 移除模型组。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（缺模型组 ID）；`busy`（Pi 迁移中）。
- **事件** [`gateway.changed`](events.md#gatewaychanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [gateway/gateway.ts:1042](../../core/src/gateway/gateway.ts#L1042)

## gateway.reorderGroups
<!-- api:method -->

- **用途** 调整模型组顺序。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** ids: string[]（必填，有序的模型组 ID）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（排序列表无效）；`busy`（Pi 迁移中）。
- **事件** [`gateway.changed`](events.md#gatewaychanged)；按实际状态变化推送，次数与顺序见事件和本节说明。 更新模型组顺序并推送 gateway.changed；顺序用于窗口模型选择。
- **开放范围** 仅内部。
- **源码** [gateway/gateway.ts:1037](../../core/src/gateway/gateway.ts#L1037)

## gateway.requests
<!-- api:method -->

- **用途** 读取近期请求记录。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `since?: number`（起始时间（毫秒））；`channel?: string`（渠道 ID）
- **返回** `unknown[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [gateway/gateway.ts:1070](../../core/src/gateway/gateway.ts#L1070)

## gateway.resetHealth
<!-- api:method -->

- **用途** 清除渠道健康状态。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `channel: string`（渠道 ID）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`gateway.changed`](events.md#gatewaychanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [gateway/gateway.ts:1046](../../core/src/gateway/gateway.ts#L1046)

## gateway.saveChannel
<!-- api:method -->

- **用途** 创建或更新渠道配置与凭据。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** ChannelInput，字段见数据结构。更新时 keys 是完整的保留/新增凭据列表
- **返回** `{id: string}`（保存后的渠道 ID）。
- **错误** `busy`（Pi 迁移中），`bad_request`（名称、地址、接口、模型、思考档位或可用 Key 无效），`not_found`（更新的渠道不存在）。加密或保存异常按 `internal` 返回。
- **事件** [`gateway.changed`](events.md#gatewaychanged)；按实际状态变化推送，次数与顺序见事件和本节说明。 保存后更新渠道和模型选择，推送 gateway.changed。普通读取只暴露凭据提示。
- **开放范围** 仅内部。
- **源码** [gateway/gateway.ts:1031](../../core/src/gateway/gateway.ts#L1031)

## gateway.saveGroup
<!-- api:method -->

- **用途** 创建或更新模型组。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** GroupInput，字段见数据结构
- **返回** `{ id: string; }`。
- **错误** `bad_request`（模型组无效）；`busy`（Pi 迁移中）。
- **事件** [`gateway.changed`](events.md#gatewaychanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [gateway/gateway.ts:1041](../../core/src/gateway/gateway.ts#L1041)

## gateway.setCommonModels
<!-- api:method -->

- **用途** 保存渠道的常用模型。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** channel: string（必填）；models: string[] 或 null
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（models 要是模型 ID 列表，或 null 恢复默认）。
- **事件** [`gateway.changed`](events.md#gatewaychanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [gateway/gateway.ts:1019](../../core/src/gateway/gateway.ts#L1019)

## gateway.status
<!-- api:method -->

- **用途** 读取渠道可用性、额度和健康状态。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `ChannelStatus[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [gateway/gateway.ts:1065](../../core/src/gateway/gateway.ts#L1065)

## gateway.testChannel
<!-- api:method -->

- **用途** 使用指定渠道进行一次最小对话测试。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `channel: string`（渠道 ID）；`model?: string`（模型 ID）
- **返回** `{ ok: boolean; latencyMs: number; model: string | null; reply?: string; error?: string; }`。
- **错误** `not_found`（找不到这个渠道）；`bad_request`（必需字段缺失或不合法）。
- **事件** [`gateway.changed`](events.md#gatewaychanged)；按实际状态变化推送，次数与顺序见事件和本节说明。 请求失败时通常返回 ok:false 和 error 文本；成功给出延迟、模型及可选答复。
- **开放范围** 仅内部。
- **源码** [gateway/gateway.ts:1057](../../core/src/gateway/gateway.ts#L1057)

## ledger.entries
<!-- api:method -->

- **用途** 按条件分页读取花费流水。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `QueryOptions & { limit?: number; before?: number }`（整体请求对象，参见数据结构或源码定义）
- **返回** `LedgerRow[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [ledger/ledger.ts:25](../../core/src/ledger/ledger.ts#L25)

## ledger.importHistory
<!-- api:method -->

- **用途** 把已有会话历史导入花费账本。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ imported: number; linked: number; web: number; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [ledger/ledger.ts:27](../../core/src/ledger/ledger.ts#L27)

## ledger.rules
<!-- api:method -->

- **用途** 列出渠道计费规则。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `unknown[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [ledger/ledger.ts:26](../../core/src/ledger/ledger.ts#L26)

## ledger.summary
<!-- api:method -->

- **用途** 按时间与分组聚合花费账本。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `QueryOptions`（整体请求对象，参见数据结构或源码定义）
- **返回** `{ since: number; until: number; period: "month" | "day" | "all"; groupBy: "session" | "channel" | "all" | "model" | "purpose" | "workspace"; timeZone: string; rows: any[]; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [ledger/ledger.ts:24](../../core/src/ledger/ledger.ts#L24)

## piMigration.generate
<!-- api:method -->

- **用途** 重新生成给 Pi 使用的配置。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** 与 `piMigration.status` 相同的迁移状态快照。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** [`piMigration.changed`](events.md#pimigrationchanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [gateway/pi-migration.ts:60](../../core/src/gateway/pi-migration.ts#L60)

## piMigration.import
<!-- api:method -->

- **用途** 从选定的 Pi 目录导入配置。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `folder: string`
- **返回** 与 `piMigration.status` 相同的迁移状态快照。
- **错误** `bad_request`（未指定有效来源文件夹）；`not_ready`（尚未完成本应用配置迁移）；`busy`（已有迁移、对话或 Pi 登录正在进行）。
- **事件** [`piMigration.changed`](events.md#pimigrationchanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [gateway/pi-migration.ts:59](../../core/src/gateway/pi-migration.ts#L59)

## piMigration.oauthAnswer
<!-- api:method -->

- **用途** 给等待输入的登录提交回答。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）；`value: string`
- **返回** `{ ok: boolean; }`。
- **错误** `not_ready`（登录步骤已变化，请刷新重试。）；`bad_request`（必需字段缺失或不合法）。
- **事件** [`piMigration.oauth`](events.md#pimigrationoauth)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [gateway/pi-migration.ts:63](../../core/src/gateway/pi-migration.ts#L63)

## piMigration.oauthCancel
<!-- api:method -->

- **用途** 取消指定登录流程。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`piMigration.oauth`](events.md#pimigrationoauth)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [gateway/pi-migration.ts:64](../../core/src/gateway/pi-migration.ts#L64)

## piMigration.oauthLogout
<!-- api:method -->

- **用途** 移除指定提供方的 OAuth 凭据。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `provider: string`（提供方 ID）
- **返回** `{ ok: boolean; }`。
- **错误** `busy`（请在迁移完成后管理登录。）；`bad_request`（此项没有已保存的 OAuth 登录。）。
- **事件** [`piMigration.changed`](events.md#pimigrationchanged)、[`gateway.changed`](events.md#gatewaychanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [gateway/pi-migration.ts:65](../../core/src/gateway/pi-migration.ts#L65)

## piMigration.oauthStart
<!-- api:method -->

- **用途** 发起指定提供方的 OAuth 登录。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `provider: string`（提供方 ID）
- **返回** `{ id: '${string}-${string}-${string}-${string}-${string}'; provider: string; status: string; }`。
- **错误** `bad_request`（缺服务商）；`oauth_login_disabled`（当前服务商不允许在渠道页发起订阅登录）；`busy`（迁移或登录正在进行）。
- **事件** [`piMigration.oauth`](events.md#pimigrationoauth)；按实际状态变化推送，次数与顺序见事件和本节说明。 返回登录 ID 后跟踪 piMigration.oauth。弹浏览器、请求输入和结束的顺序由实际 OAuth 流程决定。
- **开放范围** 仅内部。
- **源码** [gateway/pi-migration.ts:61](../../core/src/gateway/pi-migration.ts#L61)

## piMigration.oauthStatus
<!-- api:method -->

- **用途** 读取一次 OAuth 登录的当前状态。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）
- **返回** OAuth 登录对象，含 id、provider、status，流程中可附 event、prompt 等；ID 不存在时返回 `{status:'missing'}`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [gateway/pi-migration.ts:62](../../core/src/gateway/pi-migration.ts#L62)

## piMigration.retry
<!-- api:method -->

- **用途** 重试 Pi 配置迁移。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** 与 `piMigration.status` 相同的迁移状态快照。
- **错误** `busy`（已有迁移、对话或 Pi 登录正在进行）。
- **事件** [`piMigration.changed`](events.md#pimigrationchanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [gateway/pi-migration.ts:58](../../core/src/gateway/pi-migration.ts#L58)

## piMigration.status
<!-- api:method -->

- **用途** 读取 Pi 配置迁移状态。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ status: string; path: string; folder: string; busy: boolean; oauthConfigs: undefined; rollbackState: undefined; externalModified: boolean; defaultImportFolder: string; command: string; mappings: unknown[]; attempts?: number; version?: number; at?: number; backup?: string; error?: string; hashes?: PiJson; generatedHash?: string; generatedAt?: number; externalBackup?: string; unresolved?: string[]; oauthProviders?: string[]; results?: { provider: string; status: string; }[]; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [gateway/pi-migration.ts:57](../../core/src/gateway/pi-migration.ts#L57)

## providers.available
<!-- api:method -->

旧，0.12 换掉。渠道迁移后用 gateway.channels 和会话的 get_available_models。

- **用途** 列出 Pi 已配置的可用模型。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `ModelInfo[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/providers.ts:288](../../core/src/modules/providers.ts#L288)

## providers.fetchModels
<!-- api:method -->

旧，0.12 换掉。渠道迁移后用 gateway.fetchModels。

- **用途** 通过提供方配置获取模型列表。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `baseUrl?: string`（服务根 URL）；`api?: string`（API 类型）；`apiKey?: string`（凭据）；`provider?: string`（提供方 ID）
- **返回** `DescribedModel[]`。
- **错误** `bad_request`（缺接口地址）；`network`（连接失败）；`http`（接口返回非成功状态）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/providers.ts:306](../../core/src/modules/providers.ts#L306)

## providers.list
<!-- api:method -->

旧，0.12 换掉。渠道迁移后用 gateway.channels。

- **用途** 读取 Pi 提供方及其凭据状态。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `ProviderInfo[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/providers.ts:287](../../core/src/modules/providers.ts#L287)

## providers.removeCustom
<!-- api:method -->

旧，0.12 换掉。渠道迁移后用 gateway.removeChannel。

- **用途** 移除自定义 Pi 提供方。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（必需字段缺失或不合法）；`migrated`（迁移完成后改用渠道页）。
- **事件** [`providers.changed`](events.md#providerschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/providers.ts:293](../../core/src/modules/providers.ts#L293)

## providers.removeKey
<!-- api:method -->

旧，0.12 换掉。渠道迁移后用 gateway.saveChannel（按渠道凭据列表更新）。

- **用途** 删除指定提供方的凭据。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `provider: string`（提供方 ID）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（必需字段缺失或不合法）；`migrated`（迁移完成后改用渠道页）。
- **事件** [`providers.changed`](events.md#providerschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/providers.ts:301](../../core/src/modules/providers.ts#L301)

## providers.saveCustom
<!-- api:method -->

旧，0.12 换掉。渠道迁移后用 gateway.saveChannel。

- **用途** 保存自定义 Pi 提供方。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `CustomProviderInput`（整体请求对象，参见数据结构或源码定义）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（必需字段缺失或不合法）；`migrated`（迁移完成后改用渠道页）。
- **事件** [`providers.changed`](events.md#providerschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/providers.ts:289](../../core/src/modules/providers.ts#L289)

## providers.setKey
<!-- api:method -->

旧，0.12 换掉。渠道迁移后用 gateway.saveChannel（按渠道凭据列表更新）。

- **用途** 保存指定提供方的凭据。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `provider: string`（提供方 ID）；`apiKey: string`（凭据）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（必需字段缺失或不合法）；`migrated`（迁移完成后改用渠道页）。
- **事件** [`providers.changed`](events.md#providerschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/providers.ts:297](../../core/src/modules/providers.ts#L297)

## providers.test
<!-- api:method -->

旧，0.12 换掉。渠道迁移后用 gateway.testChannel。

- **用途** 使用提供方进行一次最小对话测试。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `provider: string`（提供方 ID）；`model?: string`（模型 ID）
- **返回** `{ ok: boolean; latencyMs: number; model: string | null; reply?: string; error?: string; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。 请求失败时通常返回 ok:false 和 error 文本；成功给出延迟、模型及可选答复。
- **开放范围** 仅内部。
- **源码** [modules/providers.ts:305](../../core/src/modules/providers.ts#L305)

## usage.summary
<!-- api:method -->

- **用途** 用兼容接口汇总历史用量。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `groupBy?: JSON`；`since?: number`（起始时间（毫秒））；`until?: number`（截止时间（毫秒））
- **返回** `UsageRow[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/session-index.ts:537](../../core/src/modules/session-index.ts#L537)

## webSearch.deleteKey
<!-- api:method -->

- **用途** 删除 DeepSeek 搜索凭据。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ configured: boolean; state: string; lastError: string | null; backend: "local" | "deepseek"; keyMasked: string; pendingToolRefresh: number; month: string; usage: { estimatedCostCny: number; currency: string; estimated: boolean; priceSource: string; calls: number; requests: number; billableCalls: number; uncertainCalls: number; deepseekCalls: number; }; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** [`webSearch.changed`](events.md#websearchchanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/search.ts:54](../../core/src/modules/search.ts#L54)

## webSearch.fetch
<!-- api:method -->

- **用途** 读取一个网页并提取正文。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `url: string`（URL）
- **返回** `{ content: { type: "text"; text: string; }[]; details: { provider: string; url: string; status: number; title: string; retrievedAt: string; estimated: boolean; }; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/search.ts:68](../../core/src/modules/search.ts#L68)

## webSearch.saveKey
<!-- api:method -->

- **用途** 保存 DeepSeek 搜索凭据。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `key: string`
- **返回** `{ configured: boolean; state: string; lastError: string | null; backend: "local" | "deepseek"; keyMasked: string; pendingToolRefresh: number; month: string; usage: { estimatedCostCny: number; currency: string; estimated: boolean; priceSource: string; calls: number; requests: number; billableCalls: number; uncertainCalls: number; deepseekCalls: number; }; }`。
- **错误** `bad_request`（请填写有效的 DeepSeek 官方密钥。）。
- **事件** [`webSearch.changed`](events.md#websearchchanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/search.ts:48](../../core/src/modules/search.ts#L48)

## webSearch.search
<!-- api:method -->

- **用途** 搜索网页并返回结果及时间。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `query: string`（搜索词）；`count?: number 或 undefined`；`need_content?: boolean 或 undefined`
- **返回** `{ results: SearchResult[]; retrievedAt: string; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/search.ts:67](../../core/src/modules/search.ts#L67)

## webSearch.setBackend
<!-- api:method -->

- **用途** 切换网页搜索的本地或云端后端。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `backend?: string`（搜索后端）
- **返回** `{ configured: boolean; state: string; lastError: string | null; backend: "local" | "deepseek"; keyMasked: string; pendingToolRefresh: number; month: string; usage: { estimatedCostCny: number; currency: string; estimated: boolean; priceSource: string; calls: number; requests: number; billableCalls: number; uncertainCalls: number; deepseekCalls: number; }; }`。
- **错误** `bad_request`（请选择网页抓取方式。）；`not_configured`（请先保存独立的 DeepSeek 官方密钥。）。
- **事件** [`webSearch.changed`](events.md#websearchchanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/search.ts:58](../../core/src/modules/search.ts#L58)

## webSearch.status
<!-- api:method -->

- **用途** 读取网页搜索后端和配置状态。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ configured: boolean; state: string; lastError: string | null; backend: "local" | "deepseek"; keyMasked: string; pendingToolRefresh: number; month: string; usage: { estimatedCostCny: number; currency: string; estimated: boolean; priceSource: string; calls: number; requests: number; billableCalls: number; uncertainCalls: number; deepseekCalls: number; }; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/search.ts:47](../../core/src/modules/search.ts#L47)

## webSearch.test
<!-- api:method -->

- **用途** 测试当前搜索配置。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `{ ok: boolean; count: number; retrievedAt: string; estimated: boolean; estimatedCostCny: number; }`。
- **错误** `not_configured`（未配置独立 DeepSeek 密钥）；服务请求失败返回具体的联网错误码。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/search.ts:63](../../core/src/modules/search.ts#L63)

## webSearch.usage
<!-- api:method -->

- **用途** 分页读取网页搜索用量。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `before?: number`（向更早的数据翻页）；`limit?: number`（最多返回条数）
- **返回** `unknown[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/search.ts:69](../../core/src/modules/search.ts#L69)
