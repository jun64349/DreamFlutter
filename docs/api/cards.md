# 卡片与本机 HTTP

字段后缀 `?` 表示可省略。通用传输及错误格式见[调用约定](README.md)，类型见[数据结构](types.md)。

## /cards/
<!-- api:http -->

- **用途** 提供卡片的隔离页面及其资源。
- **调用方** 窗口内卡片 WebView，按卡片归属供工作台和蝶君。
- **参数** GET/HEAD，路径 `/cards/{cardId}/t/{ticket}/{relativePath}`。卡片 ID、由 `cards.open` 签发的票据必填；空相对路径按 `index.html`。
- **返回** 200，渲染后的 HTML 或卡片的 assets 资源。页面响应包含 CSP 和 `Cache-Control: no-store`。
- **错误** HTTP 400（相对路径无效）；404（票据、卡片或资源不存在或不匹配）；通用 HTTP 错误见总览。
- **事件** 无后台推送。
- **开放范围** 仅内部。
- **源码** [cards.ts](../../core/src/cards/cards.ts#L684)

## /shell/
<!-- api:http -->

- **用途** 提供承载卡片 iframe 的外壳页面。
- **调用方** 窗口卡片 WebView，工作台和蝶君。
- **参数** GET/HEAD，路径 `/shell/{ticket}`。票据必填。
- **返回** 200 HTML，页面加载该票据绑定的卡片。响应带 CSP 与 `Cache-Control: no-store`。
- **错误** HTTP 404（票据不存在或格式无效）；通用 HTTP 错误见总览。
- **事件** 无后台推送。
- **开放范围** 仅内部。
- **源码** [cards.ts](../../core/src/cards/cards.ts#L669)

## /render/
<!-- api:http -->

- **用途** 为隐藏 WebView 提供图表、Mermaid 和 SVG 渲染页及库。
- **调用方** 窗口的渲染 WebView，工作台和蝶君。
- **参数** GET/HEAD，路径为 `/render/renderer.html`、`/render/mermaid.min.js` 或 `/render/chart.umd.js`。
- **返回** 200 HTML 或 JavaScript。页面用 WebView 消息交换 `id, kind, source, css?, width?, scale?, dark?` 与 `{id,ok,png?,svg?,width?,height?,error?}`。
- **错误** HTTP 404（资源名不在清单）；资源读取失败可为 HTTP 500。页面内渲染失败由 `ok:false` 和 `error` 报告。
- **事件** HTTP 不触发后台推送。渲染页初始化可发 `{ready:true}` 的 WebView 消息。
- **开放范围** 仅内部。
- **源码** [renderer.ts](../../core/src/render/renderer.ts#L13)

## cards.delete
<!-- api:method -->

- **用途** 删除卡片及其持久化内容。
- **调用方** 窗口和卡片宿主，按卡片归属。
- **参数** `id: string`（对象标识）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（必需字段缺失或不合法）；`not_found`（找不到这张卡片）。
- **事件** [`card.removed`](events.md#cardremoved)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [cards/cards.ts:900](../../core/src/cards/cards.ts#L900)

## cards.events
<!-- api:method -->

- **用途** 列出该卡片最近的应用事件。
- **调用方** 窗口和卡片宿主，按卡片归属。
- **参数** `id: string`（对象标识）
- **返回** `{id: number, name: string, payload: JSON | null, at: number}[]`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。 返回最多 50 条；payload 解析 JSON，解析失败用 null。
- **开放范围** 仅内部。
- **源码** [cards/cards.ts:925](../../core/src/cards/cards.ts#L925)

## cards.export
<!-- api:method -->

- **用途** 将卡片导出到用户指定文件。
- **调用方** 窗口和卡片宿主，按卡片归属。
- **参数** `id: string`（对象标识）；`path: string`（文件或目录路径）；`theme?: JSON`（卡片主题）
- **返回** `{ path: string; }`。
- **错误** `bad_request`（必需字段缺失或不合法）；`not_found`（找不到这张卡片）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [cards/cards.ts:919](../../core/src/cards/cards.ts#L919)

## cards.exportName
<!-- api:method -->

- **用途** 计算卡片建议导出文件名。
- **调用方** 窗口和卡片宿主，按卡片归属。
- **参数** `id: string`（对象标识）
- **返回** `{ name: string; }`。
- **错误** `bad_request`（必需字段缺失或不合法）；`not_found`（找不到这张卡片）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [cards/cards.ts:918](../../core/src/cards/cards.ts#L918)

## cards.forgetSession
<!-- api:method -->

- **用途** 清除某会话关联的卡片。
- **调用方** 窗口和卡片宿主，按卡片归属。
- **参数** `sessionFile: string`（会话文件路径）
- **返回** `{ removed: number; }`。
- **错误** `bad_request`（必需字段缺失或不合法）。
- **事件** [`card.removed`](events.md#cardremoved)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [cards/cards.ts:904](../../core/src/cards/cards.ts#L904)

## cards.get
<!-- api:method -->

- **用途** 读取单张卡片及元数据。
- **调用方** 窗口和卡片宿主，按卡片归属。
- **参数** `id: string`（对象标识）
- **返回** `Card`。
- **错误** `not_found`（找不到这张卡片）；`bad_request`（必需字段缺失或不合法）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 将来可开放给模块。
- **源码** [cards/cards.ts:872](../../core/src/cards/cards.ts#L872)

## cards.grant
<!-- api:method -->

- **用途** 授予卡片指定的能力和范围。
- **调用方** 窗口和卡片宿主，按卡片归属。
- **参数** id: string、kind: string、subject: string（必填）；scope?: once 或 session 或 always
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（必需字段缺失或不合法）；`not_found`（找不到这张卡片）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [cards/cards.ts:888](../../core/src/cards/cards.ts#L888)

## cards.grants
<!-- api:method -->

- **用途** 列出卡片已保存的授权。
- **调用方** 窗口和卡片宿主，按卡片归属。
- **参数** `id: string`（对象标识）
- **返回** `Grant[]`。
- **错误** `bad_request`（必需字段缺失或不合法）；`not_found`（找不到这张卡片）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [cards/cards.ts:887](../../core/src/cards/cards.ts#L887)

## cards.import
<!-- api:method -->

- **用途** 从指定文件导入卡片。
- **调用方** 窗口和卡片宿主，按卡片归属。
- **参数** `path: string`（文件或目录路径）；`cwd?: string`（工作目录）
- **返回** `Card`。
- **错误** `bad_request`（缺文件路径）；`not_found`（文件不存在）；`invalid_card`（缺少入口或卡片校验失败）；`too_large`（卡片状态超过 64 KiB）。
- **事件** [`card.changed`](events.md#cardchanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [cards/cards.ts:920](../../core/src/cards/cards.ts#L920)

## cards.list
<!-- api:method -->

- **用途** 按工作区、会话或常驻状态列卡片。
- **调用方** 窗口和卡片宿主，按卡片归属。
- **参数** `cwd?: string`（工作目录）；`resident?: boolean`（常驻过滤）；`sessionFile?: string`（会话文件路径）
- **返回** `Card[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 将来可开放给模块。
- **源码** [cards/cards.ts:877](../../core/src/cards/cards.ts#L877)

## cards.open
<!-- api:method -->

- **用途** 签发卡片查看票据并返回 WebView URL。
- **调用方** 窗口和卡片宿主，按卡片归属。
- **参数** id: string（必填）；theme?: 主题对象；sizing?: viewport 或 content（默认 content）
- **返回** `{ url: string; ticket: string; }`。
- **错误** `bad_request`（必需字段缺失或不合法）；`not_found`（找不到这张卡片）。
- **事件** 无后台推送。返回的票据绑定本次卡片实例，保存在后台进程内并受票据数量限制。
- **开放范围** 仅内部。
- **源码** [cards/cards.ts:878](../../core/src/cards/cards.ts#L878)

## cards.pin
<!-- api:method -->

- **用途** 把卡片固定为独立的副本。
- **调用方** 窗口和卡片宿主，按卡片归属。
- **参数** `id: string`（对象标识）；`cwd?: string`（工作目录）
- **返回** `Card`。
- **错误** `bad_request`（必需字段缺失或不合法）；`not_found`（找不到这张卡片）。
- **事件** [`card.changed`](events.md#cardchanged)；按实际状态变化推送，次数与顺序见事件和本节说明。
- **开放范围** 仅内部。
- **源码** [cards/cards.ts:899](../../core/src/cards/cards.ts#L899)

## cards.request
<!-- api:method -->

- **用途** 处理一次卡片能力请求及可选授权回答。
- **调用方** 窗口和卡片宿主，按卡片归属。
- **参数** `id: string`（必填，卡片 ID）；`capability: string`（必填，能力名）；`payload?: JSON`；`armed?: boolean`；`answer?: {grant:'once'|'session'|'always'|'deny',epoch:number,digest:string}`。
- **返回** `RequestAnswer`，包括 `{ask: PermissionQuestion}` 或 `Envelope`。无效的 answer 视作未回答。
- **错误** `bad_request`（缺 id）；能力名缺失、卡片已移除、速率限制、信任和调用执行失败通过 Envelope 的 `ok:false` 与 `error` 报告。
- **事件** 调用 emit 能力成功时发一条 `card.emitted`。授权提问和状态读取通过本次 RPC 返回。
- **开放范围** 仅内部。
- **源码** [cards/cards.ts:879](../../core/src/cards/cards.ts#L879)

## cards.revoke
<!-- api:method -->

- **用途** 撤销卡片的指定能力授权。
- **调用方** 窗口和卡片宿主，按卡片归属。
- **参数** id: string、kind: string、subject: string（必填）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（必需字段缺失或不合法）；`not_found`（找不到这张卡片）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [cards/cards.ts:894](../../core/src/cards/cards.ts#L894)

## cards.saveSnapshot
<!-- api:method -->

- **用途** 存储卡片预览图和可选高度。
- **调用方** 窗口和卡片宿主，按卡片归属。
- **参数** `id: string`（对象标识）；`png: string`（Base64 编码的 PNG）；`height?: number`（像素高度）
- **返回** `{ ok: boolean; }`。
- **错误** `bad_request`（必需字段缺失或不合法）；`not_found`（找不到这张卡片）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [cards/cards.ts:905](../../core/src/cards/cards.ts#L905)

## cards.setHeight
<!-- api:method -->

- **用途** 保存窗口测得的卡片高度。
- **调用方** 窗口和卡片宿主，按卡片归属。
- **参数** id: string（必填）；height?: number（四舍五入后的像素值）
- **返回** `{ ok: boolean; }`。
- **错误** `not_found`（找不到这张卡片）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [cards/cards.ts:913](../../core/src/cards/cards.ts#L913)

## cards.snapshot
<!-- api:method -->

- **用途** 读取卡片预览 PNG。
- **调用方** 窗口和卡片宿主，按卡片归属。
- **参数** `id: string`（对象标识）
- **返回** `{ png: string | null; }`。
- **错误** `bad_request`（必需字段缺失或不合法）；`not_found`（找不到这张卡片）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [cards/cards.ts:909](../../core/src/cards/cards.ts#L909)

## cards.source
<!-- api:method -->

- **用途** 读取卡片 HTML 及当前状态。
- **调用方** 窗口和卡片宿主，按卡片归属。
- **参数** id: string（必填）
- **返回** `{ html: string; state: Record<string, unknown>; }`。
- **错误** `not_found`（找不到这张卡片）。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [cards/cards.ts:921](../../core/src/cards/cards.ts#L921)

## cards.tools
<!-- api:method -->

- **用途** 列出卡片可声明的工具名和名称。
- **调用方** 窗口和卡片宿主，按卡片归属。
- **参数** 无。
- **返回** `{ tool: string; label: string; }[]`。
- **错误** 无专属 RpcError；未分类异常按通用 `internal` 返回。
- **事件** 没有专属于本方法的推送。
- **开放范围** 仅内部。
- **源码** [cards/cards.ts:930](../../core/src/cards/cards.ts#L930)
