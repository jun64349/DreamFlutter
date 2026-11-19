# 联网搜索与抓取 API（6.12 / T-64）

实现依据：阶段派工 Q60-02 与 T-64 W1–W6。参数、响应和价格于 2026-11-07 核对 [DeepSeek 官方 Search/Fetch 指南](https://api-docs.deepseek.com/zh-cn/guides/search/)。费用始终标为估算，不是供应商结算，也不属于本轮未实现的 6.6 正式账本。

## 配置与工具可见性

设置入口：**设置 → 工具与 MCP → 联网搜索与抓取**。

独立密钥名为 `web-search-deepseek-official`，通过现有 SecretStore 的 DPAPI 文件保存；不写入普通 settings，不出现在状态或保存响应中。正式保存/读取流程沿用 T-63 的进程内密钥登记。没有环境变量回退，也不读取任何渠道、OpenCode Go、cc-switch 或既有 DeepSeek 渠道的凭据。

未配置时不注册 `web_search`，系统提示也不附加它的说明；`web_fetch` 仍可用，实际抓取方式只会是本机。保存/删除密钥会重载空闲对话的工具；运行中的对话在结束后完整重载。删除后，公开的 turn/context 钩子会在下一次模型请求中移除搜索工具声明和说明（含子 Agent），执行端也立即拒绝缺少密钥的搜索，并把抓取方式恢复为本机。最小模式的既有工具组合保持原样。研究角色在工具可用时允许 `web_search`。

保存密钥不会发起付费请求。只有用户主动点击“测试连接”、Agent 使用工具，或本地已认证客户端明确调用搜索/抓取 RPC，才会发起请求。状态中的“已配置”表示凭据已保存，不表示供应商已经接受该密钥；需要主动测试才能验证连接。

## 工具行为

### `web_search`

请求参数：

| 参数 | 规则 |
| --- | --- |
| `query` | 1–128 个 Unicode 字符，不能全为空白；保留原输入，超长拒绝并说明 |
| `count` | 1–50 的整数，默认 10 |
| `need_content` | 布尔值，默认 false；为 true 时优先展示服务返回的正文 |

固定调用 `POST https://api.deepseek.com/v1/tools/search`，使用独立 Bearer 凭据。结果展示标题、URL、来源、抓取时间、摘要/正文，并把已知发布时间单独列出，避免将发布时间当抓取时间。空结果明确说明；单项正文/摘要上限 12,000 字符，工具文本总上限 200,000 字符，均标明截断。

### `web_fetch`

工具仍接收 `{url}`，由当前 `webFetchBackend` 选择“本机直接抓取”或“DeepSeek 抓取”。一条路径失败不会转到另一条路径。

- 本机：继续使用原有 fetchPage 和 harness 策略，保留 5 MiB 上限、字符集/正文处理；沙箱模式保留离线拒绝、公共地址检查、逐跳重定向检查及连接时 DNS 地址检查。工作台原有本机读取能力保持现状。
- DeepSeek：固定调用 `POST https://api.deepseek.com/v1/tools/fetch`。发出前检查目标 URL：只允许 http(s)、含 host、最多 8192 字符，无用户名/密码，并通过现有公共地址判断拒绝本机、私网和内网地址。DNS 校验有超时和取消；校验失败不会将 URL 上传给服务商。
- 远程 Fetch 的供应商响应没有最终重定向 URL 字段，因此展示请求 URL，不冒充最终地址。正文按服务返回的 Markdown 展示，仍受工具输出上限限制。

两种工具都加相同的外部不可信数据提示；内容不是指令，按来源 URL 引用。工具输出在截断前经 T-63 脱敏，再经过公共 harness/安全边界。搜索与抓取的普通审批分类一致；计划模式、定时任务和角色权限仍由既有机制处理。沙箱离线时两种远程操作均拒绝。

## 请求可靠性与错误

独立客户端默认最多 3 个并发网络请求，最多排队 32 个；排队可取消。单次远程操作总时限 30 秒，覆盖排队、退避和响应读取。只对 429 重试，最多额外 2 次；默认退避 250/500 ms，Retry-After 为秒数时采用该值，上限 2 秒。其他状态不自动重试，也不切换抓取后端。原生 API 地址不接受重定向，以免将 Authorization 转交其他域名。

响应体最多 5 MiB，按流读取并取消超限响应；无效 JSON/结构返回清楚错误，不输出供应商原始错误体或密钥。会话停止信号和后台停机信号贯穿请求；停机等待在途调用取消/写完记录后才结束模块。

| 错误码 | 中文原因 |
| --- | --- |
| `not_configured` | 未配置独立官方密钥 |
| `invalid_key` | 401，密钥无效/已失效 |
| `insufficient_balance` | 402，官方账户余额不足 |
| `rate_limited` | 429，有限次重试后仍限流 |
| `target_denied` / `target_unavailable` | 403/404，策略拒绝、站点拦截、不存在或没有可用正文 |
| `timeout` / `cancelled` | 超时 / 用户停止或后台停机取消 |
| `response_too_large` / `invalid_response` | 响应超限 / 无效 JSON 或字段 |
| `invalid_query` / `invalid_count` / `invalid_content` | 搜索参数无效 |
| `busy` / `network_error` / `service_error` / `fetch_error` | 本地队列满 / 网络错误 / 服务不可用 / 目标或本机读取失败 |

## RPC

沿用现有本地认证 Core RPC，不新增对外监听服务。

| 方法 | 参数 | 返回/行为 |
| --- | --- | --- |
| `webSearch.status` | `{}` | configured/state/keyMasked、backend、lastError、pendingToolRefresh、month 和本月 usage；不返回明文密钥 |
| `webSearch.saveKey` | `{key}` | DPAPI 保存并刷新工具，返回新状态；不主动测试 |
| `webSearch.deleteKey` | `{}` | 删除本功能的密钥，将抓取设为 local，刷新工具，返回状态 |
| `webSearch.setBackend` | `{backend:"local"\|"deepseek"}` | 未配置时拒绝选择 deepseek；返回新状态 |
| `webSearch.test` | `{}` | 用户主动的一次固定搜索，返回 `{ok,count,retrievedAt,estimated,estimatedCostCny}`；有结果时约 ¥0.005 |
| `webSearch.search` | `{query,count?,need_content?}` | 主动调用搜索；返回脱敏 results 和 retrievedAt；会产生供应商搜索费用 |
| `webSearch.fetch` | `{url}` | 按已选后端主动抓取；返回工具 content/details；DeepSeek 后端会产生费用 |
| `webSearch.usage` | `{before?,limit?}` | time 倒序原始记录，before 为排他的毫秒时间上界，默认 100 条、最多 1000 条；6.6 可以直接查询下表 |

`webSearch.search/fetch` 与“测试连接”使用 `source=settings_test`，Agent 调用使用 `source=agent`。RPC 把 WebError 映射为上述错误码和中文信息；不会把供应商回显的 Authorization 或原始响应体当错误输出。

## 6.6 可消费的用量表

表名：`web_tool_usage`。每次实际 HTTP 尝试一行，429 重试分别记录；本机抓取一行。尚未发出网络请求即被参数/URL/离线/排队取消拒绝的调用，`attempt=0`。每个逻辑调用共享一个 invocation_id。表声明进已有应用备份接口，不改网关账本，不记录 query、正文或密钥。

| 字段 | 类型/含义 |
| --- | --- |
| `id` | UUID，行标识 |
| `time` | Unix 毫秒，该次尝试开始时间 |
| `invocation_id` | UUID，同一次工具/RPC 调用及其重试的关联 |
| `request_id` | 工具调用 ID 或主动 RPC 请求标识 |
| `slot_id` / `session_id` / `run_id` | 可空；Agent 请求关联原会话/运行，设置中主动调用可空 |
| `source` | `agent` / `settings_test` |
| `tool` / `provider` | `web_search` / `web_fetch`；`deepseek` / `local` |
| `attempt` | 0=未发出；1–3=HTTP 尝试序号；local 为 1 |
| `http_status` | 可空，已收到的 HTTP 状态 |
| `status` | success / empty / error / cancelled |
| `billable` | 1=HTTP 200 且确认有搜索结果/正文；0=确认无结果/失败/本机；null=200 响应无法检查，供应商计费未知 |
| `estimated_cost_cny` | 对确认计费请求估算 0.005，其他确认请求 0；未知为 null |
| `currency` / `estimated` | CNY / 1，始终是估算 |
| `price_source` | DeepSeek 为“官方文档 2026-11-07 估算”；local 标明本机无供应商搜索费用 |
| `error_code` / `error_message` | 可空，规范化错误码与脱敏中文原因 |
| `duration_ms` | 本次尝试耗时 |

本月按桌面系统的本地日历月统计；calls 为该月出现的不同 invocation_id 数，requests 为记录/尝试数（含 attempt=0），deepseekCalls 为远程逻辑调用数。billableCalls 和 estimatedCostCny 只合计已确认有结果的请求；uncertainCalls 单列，不把客户端无法检查的 200 响应冒充免费。供应商最终结算仍以官方账户为准。

## 验证与待用户项

自动化只使用本地 HTTP 模拟、faux 模型、临时目录及合成 DPAPI 凭据。覆盖成功/空结果、Unicode 参数、鉴权/余额/站点错误、429、超时、取消、并发、响应上限、公共 URL 拒绝、未配置工具与提示缺席、保存/删除后的工具刷新、角色/审批、持久化用量、日志与输出脱敏、默认本机抓取、停机取消，以及浅/深色 150% 字号下的设置操作。

真实验证是独立暂停点：用户必须本人在本轮应用设置中保存 DeepSeek 官方密钥，不在对话或脚本中传递明文。2026-11-07 用户明确告知“尚未保存，真实验证先留待后续”，因此本轮真实调用为 0，该项未做、未通过。后续最多 10 次搜索和 5 次抓取，记录成功率、耗时、计费尝试及估算，覆盖中文官网、英文技术文档、重定向、404、长页和反爬页；没有真实证据就不能标该项通过。本轮最终状态和计数以 T-64 任务回执为准。
