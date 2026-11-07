# 逐请求账本 API（T-68，6.5 / 6.6）

统一来源为 SQLite `request_ledger`（迁移 13）。`usage_records` 保留会话索引职责，`gateway_requests` 保留网关健康与延迟原始记录；日/月及渠道、模型、用途、工作区、会话的金额统计不叠加这些表或旧 `runs.cost`。接口沿用现有本地 WebSocket RPC。

## 查询

### `ledger.summary`

```json
{"since":1793462400000,"until":1796054400000,"period":"day","groupBy":"purpose","timeZone":"Asia/Taipei"}
```

- `since` / `until`：Unix 毫秒，按 **`requested_at >= since AND requested_at < until`** 选取；默认全部。非法范围返回 `bad_request`。
- `period`：`day`、`month`、`all`，默认 `day`。
- `groupBy`：`channel`、`model`、`purpose`、`workspace`、`session`、`all`，默认 `purpose`。
- `timeZone`：IANA 时区，默认后台系统时区；无效时区返回 `bad_request`。时区和范围在响应中原样标明。界面结束日转换为下一日本地零点（不含）。

响应包含上述选项及 `rows`，每行字段：

| 字段 | 含义 |
| --- | --- |
| `period`, `key` | 日/月/全部；所选维度的键。模型键为 `provider/model`，缺失关联显示未知 |
| `requests`, `successes`, `knownStatuses`, `successRate` | 请求数、已知成功数、状态已知数；成功率只以已知状态为分母，无已知状态返回 `null` |
| `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning` | 仅累加已知 token；推理为输出的子集，不再加到输出或价格中 |
| `tokenKnown`, `reasoningKnown`, `missingUsage` | 有输入/输出的请求数、推理读数已知数、模型最终 usage 缺失数；合计 0 不代表每笔都已知 |
| `amounts` | `{币种: 已知金额合计}`，USD/CNY/UNKNOWN 分开，绝不折算或相加；没有金额时为空对象 |
| `amountSources` | 各金额来源的请求数，含缺失来源 |
| `allowance` | `{单位:来源: 合计}`，实际键如 `USD:provider`、`GLM_POINTS:local_estimate`；与账户余额、现金费用分开 |
| `historical` | 历史导入请求数 |
| `ttftMs`, `latencyCount` | 有读数请求的平均首字延迟及样本数；没有样本时为 `null` |

界面只显示前 200 组并明确提示缩小范围；接口返回全部分组。既有 `usage.summary` 的兼容汇总只保留已知 USD 金额，完整多币种和缺失信息使用本接口。

### `ledger.entries`

参数 `since`、`until` 同上，另有 `limit`（默认 100，上限 1000）和 `before`（请求时间的排他上界）。按 `requested_at DESC, id` 返回行数组。`before` 仅为时间过滤，同一毫秒含大量记录时应扩大 limit 或按完整时间范围核对，不是无损游标。

### `ledger.rules`

无参数，返回 `{version, definition}` 数组。`definition` 为 JSON 文本，保存规则来源、查询日期、服务商/模型、生效日期、时区、时段和系数。

### `ledger.importHistory`

无参数，返回 `{imported, linked, web}`。启动时自动导入，也可用于索引刷新后的核对；重复调用不会重复记费。

## 逐请求字段与来源

`id` 为请求事实的唯一键；模型请求采用 UUID，联网工具为 `web:<attempt UUID>`，旧数据为 `history:<SHA-256>`。`requested_at` 是发出时间，最终有 `completed_at`；长运行跨日/月按各次请求发出时间分开。

关联字段为 `channel`、`provider`、`model`、`workspace`、`session_id`、`run_id`、`slot_id`；未知关联保留 `null`。`purpose`：`conversation` 主对话、`subagent` 子 Agent、`memory` 记忆、`compaction` 压缩（包括准备后未使用的候选）、`auto_title` 自动标题、`vision` 看图、`web_search` 联网搜索、`web_fetch` 联网抓取、`auxiliary` 其他辅助。

`state` 为 `pending` / `complete` / `missing`，`success` 为 1 / 0 / `null`。请求开始就建行，最终流式 usage 更新同一行；终止而无最终 usage、进程中断或关闭遗留请求记为缺失，token 和金额保持 `null`。未知不填 0。后台候选即使被丢弃也保留它已经发生的请求；使用候选本身不新增请求。

token 字段为 `input`、`output`、`cache_read`、`cache_write`、`reasoning`。优先使用供应商规范化计量（如 OpenCode `opencode.tokens`）；否则使用 Pi 公开 SDK Usage。输入不重复含缓存，输出不重复加推理。`ttft_ms` 是首段文本/推理事件相对请求时间的耗时；`duration_ms` 是完成耗时。

金额字段 `amount`、`currency` 和 `amount_source`：

| 来源 | 语义 |
| --- | --- |
| `provider_actual` | 供应商最终 usage 明确返回的费用；不再叠加目录估价 |
| `provider_estimate` | 供应商明确标为 estimated 的返回费用（例如 OpenCode BYOK） |
| `price_estimate` | 缺少实际费用，按请求模型的价格快照估算；旧历史金额也只标此来源 |
| `plan_occupancy` | 套餐计量，现金费用可能为供应商明确的 0 或未知 `null`；占用另列 |
| `missing` | 最终 usage 或可用价格缺失，不把目录的全零缺省价格当作免费 |

`price_version`、`price_snapshot` 保留请求当时的规则版本和模型费率。`allowance` / `allowance_unit` / `allowance_source` 另存套餐计量；`billing_source` 保留已知供应商枚举。供应商返回实际费用时只记那一个金额。OpenCode cost 与 allowance 单位按官方定义为 USD，allowance 不表示剩余套餐。

只保存白名单数值和分类，不保存原始响应、提示词、正文、headers 或凭据。Usage 中附加 `dreamflutterRequestId`，供会话与记忆索引关联，避免索引重建再次导入同一请求。

## 规则与历史边界

- 模型目录估价版本 `pi-catalog-1.4.0-2026-11-07`；四个价格字段与 API 保存在逐笔快照，单位为 USD / 百万 token。缺少价格或目录全零时金额未知。
- 智谱套餐积分规则 `glm-plan-points-2026-11-07-v1`：从本次采集日 2026-11-07 00:00 UTC+8 生效，不猜测更早的生效日。`Asia/Shanghai` 周一至周五 14:00（含）—18:00（不含）为高峰，其余时段系数 0.5。GLM-5.3 输入/缓存读/输出系数 6.9/1.7/24；GLM-5.3-Flash 为 2.3/0.56/8，按万 token 计积分。没有官方缓存写系数时不估算该笔积分。此规则只影响 GLM_POINTS，不给现金费用或其他服务商套五折。来源：[智谱官方 Coding Plan](https://docs.bigmodel.cn/cn/coding-plan/overview)，查询日期 2026-11-07。
- OpenCode `usage.cost`、`opencode.allowance`、`billing_source`、`estimated`、token 分类依据[官方推理计量文档](https://opencode.ai/docs/console/api/inference)，查询日期 2026-11-07。
- 旧 `usage_records` 去重键忽略 path，使用 provider/model/entry_id/at，所以复制、分叉和重开历史不算新请求。时间沿用旧消息记录时间；旧数据无法还原真正发出时间，界面标历史导入。先用显式 request ID 关联当前请求，再用受限的 live 消息指纹兜底。与 gateway 仅在时间、渠道、模型、四类 token 全部一致且唯一时补成功与延迟，不做模糊匹配。历史金额不冒充供应商结算，旧 run 总费用不参与金额合计。
- 联网工具逐次 HTTP 尝试沿用原工具用量记录的唯一 ID 接入账本，价格估算和不确定收费保留原语义。工具表保留调用明细职责，账本提供统一多币种合计。

## 渠道余额与供应商用量

`gateway.status` 的 `quota` 是最后有效的供应商读数，`quotaError` 独立保留最近查询错误及 `observed` 未知值；失败不覆盖有效缓存。DeepSeek 全部币种都显示，畸形金额显示未知；智谱百分比必须是有限数值且位于 0–100。没有读数不画 0% 使用条。

`localUsage` 包含 `label: 本机累计用量（估算）`、`allowance`、`amounts`、`amountSources`。套餐渠道 `remaining` 始终为 `null`，不从本机使用推算套餐剩余。账户余额、供应商套餐用量、本机累计用量分别命名。

MiniMax 旧有效接口继续使用；不可用或失效时对[官方新端点](https://platform.minimax.cn/docs/m-plan/faq) `GET https://www.minimax.cn/v1/token_plan/remains` 做能力探测。官方未给 JSON 字段定义，新端点即使返回 200 也只报告可访问且字段未知，不套旧响应字段。此路径只做模拟测试，**真实响应未验证**。
