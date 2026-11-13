# 技能、模板与 MCP

字段后缀 `?` 表示可省略。通用传输及错误格式见[调用约定](README.md)，类型见[数据结构](types.md)。

## mcp.acceptProposal
<!-- api:method -->

- **用途** 批准一条 MCP 登记提议。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）
- **返回** `{ path: string; name: string }`。
- **错误** `bad_request`（缺提议 ID）；`gone`（找不到待处理的 MCP 提议）；`conflict`（提议所针对的配置已变化）。
- **事件** 成功时先发 `mcp.changed`，再发 `proposals.changed`。登记信息变更也可发 `library.changed`。
- **开放范围** 仅内部。
- **源码** [modules/mcp.ts:325](../../core/src/modules/mcp.ts#L325)

## mcp.list
<!-- api:method -->

- **用途** 列出工作区可见的 MCP 登记项。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `cwd?: string`（工作目录）
- **返回** `{ file: string; servers: (McpServerForm & EntryMetadata & { scope: "user" | "project"; source: string; })[]; }`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/mcp.ts:323](../../core/src/modules/mcp.ts#L323)

## mcp.register
<!-- api:method -->

- **用途** 登记 MCP 配置或发起登记提议。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `server: McpServerForm`（必填）；`sourceUrl?: string`；`cwd?: string`。
- **返回** `{id:string,status:'pending',enabled:false,trust:'untrusted'}`。
- **错误** `bad_request`（名称或连接配置无效）；`conflict`（名称或工具命名空间冲突）。
- **事件** 登记提议后发 `proposals.changed`，登记信息更新还可能发 `library.changed`。
- **开放范围** 仅内部。
- **源码** [modules/mcp.ts:324](../../core/src/modules/mcp.ts#L324)

## mcp.remove
<!-- api:method -->

- **用途** 移除 MCP 登记项。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `source?: string`（来源）；`name: string`（名称）
- **返回** `{ ok: boolean; }`。
- **错误** `read_only`（项目里的服务由项目配置管理）；`bad_request`（必需字段缺失或不合法）。
- **事件** [`mcp.changed`](events.md#mcpchanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/mcp.ts:364](../../core/src/modules/mcp.ts#L364)

## mcp.save
<!-- api:method -->

- **用途** 保存已登记的 MCP 配置。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `server: McpServerForm`（必填）；`previousName?: string`；`sourceKind?: string`；`sourceUrl?: string`。
- **返回** 直接保存为 `{ok:true}`；按来源需要确认时为 `{id:string,status:'pending',enabled:false,trust:'untrusted'}`。
- **错误** `bad_request`（名称或连接配置无效）；`conflict`（名称或工具命名空间冲突）。
- **事件** 直接保存时发 `mcp.changed`，需确认的保存发 `proposals.changed`。登记信息变更也可发 `library.changed`。
- **开放范围** 仅内部。
- **源码** [modules/mcp.ts:337](../../core/src/modules/mcp.ts#L337)

## mcp.setButterflyAllowed
<!-- api:method -->

- **用途** 设置 MCP 条目是否允许蝶君使用。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `name: string`（名称）；`source?: string`（来源）；`cwd?: string`（工作目录）；`allowed?: boolean`
- **返回** `{ ok: boolean; }`。
- **错误** `not_found`（没有这个服务，或项目未获信任）；`untrusted`（请先在待确认里确认服务，再单独授权给蝶君）；`bad_request`（必需字段缺失或不合法）。
- **事件** [`mcp.changed`](events.md#mcpchanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/mcp.ts:327](../../core/src/modules/mcp.ts#L327)

## mcp.setEnabled
<!-- api:method -->

- **用途** 设置 MCP 服务启用状态。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `source?: string`（来源）；`name: string`（名称）；`enabled?: boolean`（启用开关）
- **返回** `{ ok: boolean; }`。
- **错误** `read_only`（项目里的服务由项目配置管理）；`bad_request`（缺名称）；`not_found`（服务不存在）；`untrusted`（启用的服务未经确认）。
- **事件** [`mcp.changed`](events.md#mcpchanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/mcp.ts:358](../../core/src/modules/mcp.ts#L358)

## mcp.setToolEnabled
<!-- api:method -->

- **用途** 设置服务中一个工具的启用状态。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `name: string`（名称）；`source?: string`（来源）；`tool: string`（工具名）；`enabled?: boolean`（启用开关）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（字段缺失或工具名不合法）；`read_only`（项目服务）；`not_found`（服务不存在）；`untrusted`（服务未经确认）。
- **事件** [`mcp.changed`](events.md#mcpchanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/mcp.ts:363](../../core/src/modules/mcp.ts#L363)

## mcp.status
<!-- api:method -->

- **用途** 读取 MCP 运行状态与错误。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `cwd: string`（工作目录）
- **返回** `{ servers: Json[]; errors: unknown[]; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/mcp.ts:369](../../core/src/modules/mcp.ts#L369)

## mcp.test
<!-- api:method -->

- **用途** 启动或连接 MCP 并检查工具列表。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `name: string`（名称）；`cwd: string`（工作目录）；`source?: string`（来源）
- **返回** 服务检查报告，含 `name`、`state`、`ok`、`durationMs`、`tools`、`errors` 和 `toolStates`，以及经脱敏的表单字段和库登记字段。连接失败可通过报告中的状态和错误字段读取。
- **错误** `bad_request`（缺名称或工作区路径）；`not_found`（找不到服务，或项目未获信任）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/mcp.ts:326](../../core/src/modules/mcp.ts#L326)

## proposals.accept
<!-- api:method -->

- **用途** 批准提议，可提交修改。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）；`edited?: Partial<SkillProposal> 或 undefined`（修改后的提议）
- **返回** 技能为 `{path:string}`，MCP 为 `{path:string,name:string}`。
- **错误** `bad_request`（缺参数或技能校验失败），`gone`（已处理），`read_only`（内置资源），`untrusted`（项目未信任），`conflict`（待批期间文件或配置已变化）。
- **事件** [`proposals.changed`](events.md#proposalschanged)、[`skills.changed`](events.md#skillschanged)、[`mcp.changed`](events.md#mcpchanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/skills.ts:599](../../core/src/modules/skills.ts#L599)

## proposals.list
<!-- api:method -->

- **用途** 列出技能和 MCP 等提议。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `status?: string`（状态过滤或目标状态）
- **返回** `Proposal[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/skills.ts:598](../../core/src/modules/skills.ts#L598)

## proposals.reject
<!-- api:method -->

- **用途** 驳回提议。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `id: string`（对象标识）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`proposals.changed`](events.md#proposalschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/skills.ts:600](../../core/src/modules/skills.ts#L600)

## skills.copyBuiltin
<!-- api:method -->

- **用途** 把内置技能复制为可编辑用户技能。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `filePath: string`（文件路径）；`name: string`（名称）
- **返回** `{ path: string; name: string; }`。
- **错误** `bad_request`（请选择一个内置技能）；`conflict`（此用户技能已存在）；`read_only`（用户技能目录不能位于应用内置技能目录内）。
- **事件** [`skills.changed`](events.md#skillschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/skills.ts:542](../../core/src/modules/skills.ts#L542)

## skills.draftFromSession
<!-- api:method -->

- **用途** 从会话内容起草技能提议。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `slotId: string`（活动会话槽 ID）
- **返回** `Proposal`。
- **错误** `bad_request`（缺会话编号或会话没有内容）；`not_found`（会话不存在）；`model`（模型没有返回可整理的技能正文）。
- **事件** [`proposals.changed`](events.md#proposalschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/skills.ts:597](../../core/src/modules/skills.ts#L597)

## skills.import
<!-- api:method -->

- **用途** 从本地目录导入技能。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `folder: string`；`sourceUrl?: string`（来源链接）
- **返回** `SkillInfo`。
- **错误** `bad_request`（目录、名称或技能校验失败）；`read_only`（名称或目标属于内置技能）；`conflict`（同名技能已存在）。
- **事件** 成功时发 `skills.changed`、`proposals.changed`、`skills.changed`。登记信息变更也可发 `library.changed`。
- **开放范围** 仅内部。
- **源码** [modules/skills.ts:565](../../core/src/modules/skills.ts#L565)

## skills.importUrl
<!-- api:method -->

- **用途** 从支持的来源导入技能。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `url: string`（URL）
- **返回** `SkillInfo`。
- **错误** `busy`（正在维护）；`bad_request`（链接、内容或输入无效）；`download`（下载失败或重定向超限）；`too_large`（下载或解包超限）；导入时还可能返回 `read_only` 或 `conflict`。
- **事件** 下载并导入成功时，推送顺序与 `skills.import` 相同。
- **开放范围** 仅内部。
- **源码** [modules/skills.ts:566](../../core/src/modules/skills.ts#L566)

## skills.list
<!-- api:method -->

- **用途** 列出指定工作区可见的技能。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `cwd: string`（工作目录）
- **返回** `SkillInfo[]`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 将来可开放给模块。
- **源码** [modules/skills.ts:555](../../core/src/modules/skills.ts#L555)

## skills.read
<!-- api:method -->

- **用途** 读取技能文件的正文。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `filePath: string`（文件路径）
- **返回** `string`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/skills.ts:556](../../core/src/modules/skills.ts#L556)

## skills.register
<!-- api:method -->

- **用途** 登记一条技能提议。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `name: string`（名称）；`description: string`（说明）；`content: string`（正文）；`scope?: string`（范围）；`files?: Record<string, string> 或 undefined`；`sourceKind?: string`；`sourceUrl?: string`（来源链接）；`cwd?: string`（工作目录）
- **返回** `Proposal`。
- **错误** `bad_request`（缺字段或技能校验失败）；`read_only`（尝试修改内置技能）；`untrusted`（项目未获信任）。
- **事件** [`proposals.changed`](events.md#proposalschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/skills.ts:571](../../core/src/modules/skills.ts#L571)

## skills.remove
<!-- api:method -->

- **用途** 移除可删除的技能。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `filePath: string`（文件路径）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（文件参数无效）；`read_only`（内置技能）。
- **事件** [`skills.changed`](events.md#skillschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/skills.ts:561](../../core/src/modules/skills.ts#L561)

## skills.routingStatus
<!-- api:method -->

- **用途** 读取某会话的技能候选与路由状态。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `slotId: string`（活动会话槽 ID）
- **返回** `RouteSelection | null`。
- **错误** `bad_request`（缺会话编号）；`not_found`（会话不存在）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/skills.ts:541](../../core/src/modules/skills.ts#L541)

## skills.scriptTrial
<!-- api:method -->

- **用途** 在隔离目录试运行技能脚本。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `proposalId?: string`（提议 ID）；`filePath: string`（文件路径）；`script?: string`；`args?: string[] 或 undefined`；`timeoutMs?: number`；`maxOutputBytes?: number`
- **返回** `TrialResult`。
- **错误** `not_found`（没有这个技能建议）；`bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/skills.ts:583](../../core/src/modules/skills.ts#L583)

## skills.setEnabled
<!-- api:method -->

- **用途** 设置一条技能的启用状态。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `filePath: string`（文件路径）；`enabled?: boolean`（启用开关）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（文件参数无效）；`untrusted`（启用的技能或模板尚未获信任或已经变化）。
- **事件** [`skills.changed`](events.md#skillschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/skills.ts:557](../../core/src/modules/skills.ts#L557)

## skills.test
<!-- api:method -->

- **用途** 检查指定技能或提议。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `proposalId?: string`（提议 ID）；`filePath: string`（文件路径）
- **返回** `SkillCheck`。
- **错误** `not_found`（没有这个技能建议）；`bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/skills.ts:573](../../core/src/modules/skills.ts#L573)

## templates.command
<!-- api:method -->

- **用途** 用传入参数构造模板命令文本。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `name?: JSON`（名称）；`values?: Record<string, string>`
- **返回** `{ command: string; }`。
- **错误** `not_found`（没有这个模板）；`untrusted`（模板已停用或未获信任）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/skills.ts:624](../../core/src/modules/skills.ts#L624)

## templates.draft
<!-- api:method -->

- **用途** 从自然语言起草模板。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `text: string`
- **返回** `{ name: string; description: string; body: string; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [modules/skills.ts:630](../../core/src/modules/skills.ts#L630)

## templates.list
<!-- api:method -->

- **用途** 列出任务模板。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** 无。
- **返回** `TemplateInfo[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 将来可开放给模块。
- **源码** [modules/skills.ts:604](../../core/src/modules/skills.ts#L604)

## templates.remove
<!-- api:method -->

- **用途** 删除指定模板。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `name: string`（名称）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`templates.changed`](events.md#templateschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/skills.ts:620](../../core/src/modules/skills.ts#L620)

## templates.save
<!-- api:method -->

- **用途** 新建或修改任务模板。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `name: string`（名称）；`description?: string`（说明）；`body: string`；`params?: TemplateParam[]`；`previousName?: string`
- **返回** `TemplateInfo`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`templates.changed`](events.md#templateschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/skills.ts:611](../../core/src/modules/skills.ts#L611)

## templates.setEnabled
<!-- api:method -->

- **用途** 启用或停用指定模板。
- **调用方** 窗口，工作台和蝶君共用。
- **参数** `name?: JSON`（名称）；`enabled?: boolean`（启用开关）
- **返回** `{ ok: boolean; }`。
- **错误** `not_found`（没有这个模板）。
- **事件** [`templates.changed`](events.md#templateschanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [modules/skills.ts:605](../../core/src/modules/skills.ts#L605)
