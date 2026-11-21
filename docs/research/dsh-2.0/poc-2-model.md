# POC-2 · 模型组与逐请求预算

2026-11-20，DreamFlutter V1.1.0 底座工作树。用官方 DSH `0.2.2-rc.5` 的 SDK 和 `sdk-minimal` 进程实测。插件、路由与账本都在子进程内运行，模型端点由测试在 `127.0.0.1` 上提供。测试使用临时 SQLite 数据库、临时 DSH 会话目录和固定的测试认证占位值。

## 接入位置

- 通过官方 `patches` 加载模型预算插件和 `dsh-llm-pi-ai` 传输。SDK 选择已有 `dreamflutter/<模型组 ID>`，插件从 1.0 的 `gateway_groups` 和 `gateway_channels` 读取配置，调用原有 `pickEntry()`。官方 `agent/created` 钩子在首步准备前通过 `agent.model.select()` 选定物理模型，所以 DSH 的会话请求头也记录实际的渠道和模型。`agent/request` 此时已经固定本步的渠道与模型，修改它们会被当前官方版本拒绝。 [官方 Agent 事件](https://github.com/deepseek-ai/deepseek-harness/blob/9c2670d3bce5275e0d1610272958121af87787bb/packages/core/agent/src/runtime-types.ts) · [路由插件](../../../tools/dsh-poc/model-routing.mjs)
- `llm/stream` 读 DSH 已解析的输出上限和现有渠道模型的价格。真实 `AutonomyBudget.reserve()` 在底层调用前检查已结算支出与在途预留。允许后由真实 `Ledger.begin()` / `finish()` 记录物理渠道请求与用量，成功后的预算按该笔账单结算，预留与逐请求账单以同一 ID 关联。 [官方 LLM 流接口](https://github.com/deepseek-ai/deepseek-harness/blob/9c2670d3bce5275e0d1610272958121af87787bb/packages/llm/llm/src/index.ts) · [预算插件](../../../tools/dsh-poc/model-budget-plugin.mjs)

## 实测结果

Windows x64，Node `24.21.0`。一个官方 DSH 后台发出 5 次回环 HTTP 请求，其中 3 次正常回复、2 次故意制造的异常。另有 1 次被拒绝，回环端点没有收到请求，逐请求账本没有生成该笔记录。

| 场景 | 观察结果 |
| --- | --- |
| 模型组主渠道 | 模型组把备用条目排在配置列表第一行，原路由仍按优先级选中主渠道。实际收到 `POST /primary/v1/messages`、模型 `poc-primary`、输出上限 256，回复回到 SDK。测试端点上报普通输入 20、输出 8、缓存读 7、缓存写 3，按测试价格结算 `$0.0000594`。 |
| 主渠道停用 | 更新临时库的渠道配置后，新会话选中备用渠道。实际收到 `POST /secondary/v1/responses`、模型 `poc-secondary`、输出上限 256。Responses 端点上报输入合计 50（其中缓存读 20）、输出 10，账本拆成普通输入 30 和缓存读 20，结算 `$0.0000740`。 |
| 并发预算和正对照 | 让备用请求在回环端点等待，确认真实账本处于 `pending` 且预算有预留。构造一笔测试前序支出，使已结算后余量能覆盖一笔同等预估，但包含在途预留后不足。相同提示、模型、费率和输出上限的新会话返回 `DF_DAILY_BUDGET_EXCEEDED`。第一笔结清后调整测试前序收据，恢复到被拒时的同样已结算支出。在途占款为 0 时，同样请求抵达端点并结算 `$0.0000740`。两次发出的 Responses 请求体只有会话缓存键不同。 |
| 异常附有用量 | Messages 端点上报输入和缓存后提前关流，DSH 会话原因是 `TRANSPORT`。账本以失败记录保存已见的输入 20、输出 0、缓存读 7、缓存写 3 和相应估价 `$0.0000274`。预算按占款结算，因为 DSH 的异常用量缺少完整性标记。 |
| 异常没有用量 | 回环端点返回 HTTP 400。账本的计数与金额留空，状态 `missing`，失败码 `INVALID_REQUEST`。预算按占款结算，异常之后两笔预留均释放。 |

金额都是用端点提供的 token 计数和测试配置的模型价格计算的估价。官方 Pi-AI 适配器把推理用量包含在输出中，未单独转发 `reasoningTokens`。测试 Responses 回复带 2 个推理 token，输出仍按总计 10 个计费。[官方 Pi-AI 用量转换](https://github.com/deepseek-ai/deepseek-harness/blob/9c2670d3bce5275e0d1610272958121af87787bb/packages/llm/llm-pi-ai/src/stream.ts) · [验收脚本](../../../tools/dsh-poc/model-budget.test.mjs)

## 迁移边界

- 已验证的是新建 Agent 时从现有模型组初选渠道，以及本进程的两条并发请求共用同一份预留。原网关的会话内自动换线路、渠道熔断、多个密钥、真实账户计费与套餐额度还待迁移验证。原型通过测试补丁独立声明物理 DSH 路由，生产版需把这份配置和渠道配置同步到同一来源。
- 预算守卫覆盖此补丁接入的 `df-` 渠道。输入按序列化的字节数预估，输出按已解析的上限预留，图片、供应商附加开销和不同计费形式需要单独验证。实际费用一旦超过原估算，记录实际用量对应金额，影响后续可用额度。
- 逐请求账本和自治预算分别写入现有表。当前验证进程正常退出；多进程争用、崩溃后未结算占款恢复、热卸载期间的在途请求，以及正式数据迁移仍待验证。插件通过临时配置挂载在独立测试工程。

## 本机复跑

先在 `core` 安装锁定依赖，再在独立验证工程安装锁定的官方 DSH 包。运行两项验证需要 Node ≥24.9。本机可用现有 Node 24 执行以下命令，临时测试数据由脚本自动清理。

```powershell
cd E:\claude\DreamFlutter-2.0
$pocNode = 'E:\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$npmCli = Join-Path (Split-Path (Get-Command npm.cmd).Source) 'node_modules\npm\bin\npm-cli.js'
& $pocNode $npmCli --prefix core ci --ignore-scripts --no-audit --no-fund
if ($LASTEXITCODE -eq 0) { & $pocNode $npmCli --prefix tools/dsh-poc ci --ignore-scripts --no-audit --no-fund }
if ($LASTEXITCODE -eq 0) { & $pocNode --test tools/dsh-poc/session.test.mjs tools/dsh-poc/model-budget.test.mjs }
```
