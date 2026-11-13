# DreamFlutter 后台接口参考

供 0.12 窗口开发和 T-132 契约测试使用。接口名与字段按 v0.11 后台实现记录。

| 领域 | 内容 |
| --- | --- |
| [后台与设置](core.md) | 连接初始化、设置、首次运行、通知前台状态 |
| [会话与上下文](sessions.md) | 会话槽、索引、搜索、压缩、运行、确认 |
| [蝶君与等你处理](butterfly.md) | 对话交办、任务、自主规则、长期目标、待处理回执 |
| [目标与日程](goals-schedules.md) | 目标、作业、日程、巡检及关注项 |
| [记忆](memory.md) | 记忆条目、历史、任务边界、后台作业 |
| [技能、模板与 MCP](skills-mcp.md) | 登记、启停、提议和使用范围 |
| [模型与花费](models-usage.md) | 渠道、模型组、迁移、OAuth、账本及网页搜索 |
| [沙箱与维护](storage-maintenance.md) | 沙箱、备份、迁移、更新、安全审计、Git |
| [卡片与本机 HTTP](cards.md) | 卡片管理、授权和 WebView 资源 |
| [后台推送](events.md) | 事件触发、字段、次数与顺序 |
| [Pi 会话协议](pi.md) | `df_*` 命令、事件和消息记录 |
| [Agent 工具](agent-tools.md) | 工作台、蝶君、最小模式和条件工具 |
| [数据结构](types.md) | 主要对象的字段、类型、时间和标识 |
| [语音输入](voice.md) | 音频识别命令与推送 |
| [卸载](uninstall.md) | 卸载预演、保留数据标记和安装器钩子；[查找保留数据](uninstall.md#uninstallpreserveddata)、[恢复保留数据](uninstall.md#uninstallrestorepreserveddata) |

## 连接与报文

从当前数据目录的 `core.json` 读取 `port`、`token`，连接 `ws://127.0.0.1:<port>`。WebSocket 握手带 `Authorization: Bearer <token>`。服务拒绝带 `Origin` 的握手。每条文本消息传一个 JSON 对象，上限 64 MiB。

```json
{"id":"req-1","method":"slot.list","params":{}}
{"id":"req-1","result":[]}
{"id":"req-2","error":{"code":"unknown_method","message":"Unknown method: missing"}}
{"event":"slot.closed","slotId":"slot-1"}
```

- 请求必需 `method: string`。建议给每次请求唯一的 `id`。省略或传空的 `id` 时应答带 `null`。可省略 `params` 或传 `null`，后台按空对象处理。
- 同一连接可有多笔在途请求，按 `id` 匹配应答。方法结果为 `undefined` 或 `null` 时线上的 `result` 为 `null`。字段为 `undefined` 时 JSON 序列化省略该字段。
- 推送以 `event` 区分，字段与事件名同级。推送可穿插在 RPC 应答之间。状态变更次数由实际业务阶段决定，连接中断后用查询接口重新获取快照。会话记录走 `slot.record`，由 `slot.attach` 或开槽时的附加状态控制。
- HTTP 资源与 WebSocket 共用端口。HTTP 只收 GET/HEAD，`Host` 必须是带本端口的 `127.0.0.1` 或 `localhost`。主机头无效返回 421，方法无效返回 405，路径解析失败返回 400，未匹配路由返回 404。卡片资源使用当前后台签发的实例票据。

## 错误码

WebSocket 返回 `{id,error:{code,message,data?}}`。常规参数校验和权限、对象不存在等 RPC 失败通过此结构应答。只有后台明确附加数据时才发送 `data`，允许显式的 `null`。日程编辑与撤销的版本冲突可用 `data` 返回当前日程快照及其 `version`，目标日程已不存在时为 null。旧窗口仍可只读 code 和 message。

以下业务失败保留各领域的返回格式。一次调用还可能先发生通用参数校验错误。

| 接口 | 业务结果 |
| --- | --- |
| `schedules.preview` | `result.error` 为提示字符串，`next` 为空数组 |
| `cards.request` | `result` 为授权提问或卡片能力信封 |
| `git.*` | `result.ok:false`，附 `code`、`reason`，可带恢复点 |
| `gateway.testChannel`、`providers.test`、`setup.testChannel` | `result.ok:false` 及可选 `error` |
| `attention.resolve` | 已受理后的失败由 `ActionReceipt` 的状态和错误描述 |
| `slot.send` | Pi 命令结果在 `slot.record` 的 `response.success/error` |
| 本机 HTTP | HTTP 状态码 |

| 代码 | 触发范围 |
| --- | --- |
| `parse_error` | 无法解析 JSON |
| `bad_request`、`invalid_params` | 无效报文、参数或特定领域约束 |
| `unknown_method` | 后台未注册该方法 |
| `internal` | 未归类异常 |
| `not_found`、`gone`、`expired` | 对象不存在、已清理或有效期已过 |
| `busy`、`conflict`、`version_conflict` | 正在处理、状态冲突或版本过期 |
| `forbidden`、`untrusted`、`read_only` | 调用、信任或写入范围不允许 |
| `unavailable`、`not_ready`、`not_staged`、`cancelled` | 服务不可用、对象未就绪、恢复未暂存或操作取消 |
| `bad_config`、`not_configured`、`missing_credential` | 配置无效、后端未配置或缺失凭据 |
| `network`、`http`、`download`、`timeout`、`fetch_error` | 网络、HTTP 响应、下载、超时或抓取问题 |
| `model`、`model_unavailable`、`cooldown` | 模型配置、模型不可用或渠道冷却 |
| `oauth_login_disabled`、`migrated` | OAuth 登录策略禁止或旧配置已迁移 |
| `bad_backup`、`update_validation`、`validation_failed` | 备份或更新候选未通过校验 |
| `waiting_window` | 更新验证在等待候选窗口首帧 |
| `invalid_card`、`too_large` | 卡片格式无效或内容超出限制 |
| `sandbox_absent`、`storage_paused`、`patrol_limit` | 沙箱未准备、记忆存储暂停或巡检限制 |

后台进入停机阶段后，已连接窗口的 RPC 统一返回 `unavailable`。维护期间，各接口按自身规则拒绝受影响的写入或执行请求，例如发送提示、导入技能和搬迁数据时返回 `busy`。

## 开放范围

「仅内部」包含 DreamFlutter 自己的窗口、后台和模型工具。标为「将来可开放给模块」的接口仅是后续评估候选，当前仍使用原有认证、权限和调用路径。会话命令与模型工具各有独立入口。

## 新接口命名约定

- RPC 使用 `领域.动作`，字段名和各段采用 camelCase。成对的请求、事件沿用同一个领域前缀。
- 对象路径用 `path`。同时出现多种路径时用明确的 camelCase 限定名，例如 `sourcePath`、`targetPath`。
- 对象版本和调用方提交的期望版本统一用 `version`，在文档标明写入前的比对语义。返回当前版本时同样使用 `version`。
- 资源标识用 `id`，引用其他对象时用明确的 `sessionId`、`goalId` 等。新错误用小写 snake_case 代码与可选 `data`。
- 现有方法与字段沿用各自的契约，逐项见领域页。
