# 长任务内核开发设计（0.4 · 4.9，0.8 照此实现）

写于 2026-11-05。依据：roadmap 第二节「跨版本的共同原则」、0.8「长任务与目标」、0.9「蝶君自主与成长」；Codex 报告 04（Goal）、03（DSH，第 3、6、8–11 节）、05（后台压缩，只取接口）；[memory-design.md](memory-design.md) 第十六节（任务边界）。和 0.3 先写记忆设计、0.5 再实现一样：这里定数据结构、状态机、调度协议和与 0.5 / 0.9 的接口，**第十八节的待定项给了建议值，等用户逐项定**。

本文的字段和接口名是实现时的起点，不是已经存在的 API；实现时有出入就改本文，并在末尾「实现记录」写明。

## 一、范围

- **要解决的**：一个明确的目标不用用户一遍遍说「继续」就能推进到验收；能等后台工作、能被插话和停止；进度、花费、为什么停下都说得清；崩溃、重启、导入后不重复做、不复活用户停掉的东西。工作台和蝶君共用一套，以蝶君为主。
- **不在这里的**：主动接活的规则、事件来源、授权依据的细节（0.9，本文只留接口，第十三节）；记忆快照怎么选（memory-design）；压缩算法（0.5 的 5.12，本文只定它对目标服务发什么事件）；界面视觉（0.4 设计稿，本文第十四节只列面板需要的数据）。

## 二、概念和现有表的对应

| 概念 | 意思 | 落在哪里 |
|---|---|---|
| 目标 Goal | 要达到什么、哪些约束不能违反、怎样算完成；可以跨任务、跨会话 | **新表 `goals`**（+ `goal_revisions`） |
| 工作项 | 一个明确范围的工作单元，有产物 | **现有 `tasks`**，加 `goal_id` |
| 执行尝试 Attempt | 一次模型执行（含中断、失败、重试） | **现有 `runs`**（已有 `task_id`）；重试是同一工作项的新 run，不新建工作项 |
| 会话 | 模型和用户交流的容器 | Pi 会话文件 + `session_meta`；**不是**任务状态的唯一来源 |
| 证据 | 文件、检查结果、工具回执、读过的来源、用户的确认 | **新表 `goal_evidence`**；产物文件继续记在 `artifacts` |
| 审查 | 对「某个目标修订号 + 某个证据版本」的验收判定 | **新表 `goal_reviews`** |
| 账本 | 主执行、子 Agent、审查、记忆、压缩、观察评估的花费 | **新表 `ledger`**；`runs.cost` 照旧，账本按目标汇总 |
| 等待 | 等计算 / 外部事件 / 用户 | **新表 `goal_waits`** |
| 事件 | 发给调度者的一切消息 | **新表 `goal_events`**（带去重键） |
| 续跑意图 | 调度者决定「再跑一次」的持久记录 | **新表 `goal_intents`**（带幂等键） |
| 暂停卡片 | 轮数、花费上限触发的「继续 / 到此为止」 | 现有 `notices`，加 `goal_id`、新的 kind |
| 定时任务 | 按时间触发 | 现有 `schedules` / `schedule_runs`；每次运行是一个确定的任务边界，可以挂在某个目标下（`schedules.goal_id`） |

**不另起一套**：没有目标的普通任务（工作台里随手的一次请求、写笺、模板、定时任务）照旧只有 `tasks` + `runs`，`goal_id` 为空，行为和现在完全一样。目标服务只在这些表上加列和加表。

## 三、数据结构

### 3.1 `goals`

| 列 | 说明 |
|---|---|
| `id` | `g_` + 8 位 |
| `revision` | 修订号，从 1 开始；用户修改目标、约束、验收条件时 +1 |
| `title` | 短标题（界面用） |
| `origin_text` | **用户原话**，原样保存，任何摘要、压缩都不替代它 |
| `spec` | JSON：`objective`（一句话结果）、`constraints[]`（每条 `{text, kind: "must" \| "must_not", check?}`）、`acceptance[]`（第六节的验收条目）、`deliverables[]`（期望的产物，路径或描述） |
| `scope` | JSON：`cwd`、`partition`（`workbench` / `butterfly`）、`sandbox`、允许的工具和路径（0.9 的 Mandate 在这里引用） |
| `mandate_ref` | 授权依据：`user:<消息 ID>` / `rule:<规则 ID>@<版本>` / `schedule:<ID>@<版本>`；新资料不能改它（共同原则 2） |
| `source` | `user`（用户明说 / 点「设为目标」）、`card`（接受了「要不要设为目标」卡片）、`schedule`、`rule`（0.9） |
| `status` / `reason` / `resume_when` | 第四节的状态机；`reason` 是原因代码，`resume_when` 是人能看懂的恢复条件 |
| `stop_intent` | `null` / `pause` / `stop_run` / `cancel` / `emergency`；用户的停止意图，**跨重启保持**，只有用户的明确操作能清掉（共同原则 5） |
| `current_task_id` | 当前工作项 |
| `budget` | JSON：`maxCostUsd`、`maxTokens`、`maxActiveMs`、`maxRuns`、`maxParallel`；空 = 用全局默认（第十八节） |
| `progress` | JSON：最近的进展指纹、停滞计数、最近一次有进展的时间（第七节） |
| `lease_owner` / `lease_generation` / `lease_until` | 执行租约（第五节）；`lease_generation` 单调递增 |
| `latest_review_id` | 最近一次审查 |
| `created_at` / `updated_at` / `ended_at` | |

`goal_revisions(goal_id, revision, origin_text, spec, scope, by, why, at)`：每次修订一行，旧的不删。

### 3.2 其他新表

```text
goal_events     id, goal_id, kind, dedupe_key UNIQUE, payload JSON, created_at, handled_at, handled_by_generation
goal_intents    id, goal_id, revision, generation, idem_key UNIQUE, action(run|review|notify), status(pending|started|dropped|done), reason, created_at, started_at
goal_waits      id, goal_id, kind(compute|external|user), ref(job/subagent/schedule/question id), wake_on, deadline, status(open|resolved|expired|cancelled), created_at, resolved_at
goal_evidence   id, goal_id, task_id, run_id, kind, ref, digest, detail JSON, version, created_at
goal_reviews    id, goal_id, revision, evidence_version, layer(program|model|user), verdict, missing JSON, reasons, model, cost, created_at
ledger          id, goal_id, task_id, run_id, kind(main|subagent|review|memory|compaction|assessment), state(reserved|settled|released),
                est_cost, cost, input_tokens, output_tokens, active_ms, created_at, settled_at
```

现有表加列：`tasks.goal_id`、`tasks.attempt`（同一工作项的第几次尝试）、`notices.goal_id`、`schedules.goal_id`。

- `goal_evidence.version`：每个目标一个单调递增的证据版本（新证据 +1），审查固定在某个版本上。
- `goal_evidence.digest`：文件证据记 sha256 + 大小 + 修改时间，「原文件不变」这类约束就是比较 digest。
- **备份**：这些表在 `TasksModule`（或新的 `GoalsModule`）里 `declareBackup`，路径列（`scope.cwd`、证据里的文件路径）写进 `paths`；`backup.test.ts` 的「每张表都有人认领」会检查。从备份导入时，所有 `running` / `queued` / `reviewing` / `waiting_*` 的目标改为 `paused`，`reason = imported`（第十节）。

## 四、状态机

| 状态 | 意思 | 进入时机 | 怎么出来 |
|---|---|---|---|
| `draft` | 还不能执行（缺目标、范围或必要信息） | 「要不要设为目标」卡片被接受但信息不全 | 信息齐了 → `queued` |
| `queued` | 已接纳，等执行资源 | 新建、续跑意图写好 | 调度者拿到租约 → `running` |
| `running` | 正在执行（有一个 run 在跑） | 启动 run | run 结束 → 调度者判断；用户停止 → `paused` / `cancelled` |
| `reviewing` | 在固定的证据版本上验收 | 到达里程碑或可能完成 | 审查结论（第六节） |
| `waiting_dependency` | 等计算或外部事件 | 有本目标拥有的后台工作、子 Agent 在跑，或在等某个外部事件 | 依赖完成（事件）/ 超时 → 调度者判断 |
| `waiting_user` | 需要用户回答具体问题或做选择 | 审查结论 `needs_user`、执行时提问、要扩权 | 用户回答 → `queued`；用户取消 → `cancelled` |
| `paused` | 不再续跑 | 用户暂停、预算用完、重启后待检查、导入 | 用户恢复（预算类要先放宽）→ `queued` |
| `blocked` | 当前条件下做不下去，**有说得清的缺失条件** | 停滞检查后仍无路、外部条件缺失 | 条件变化（新证据、用户补充）→ `queued` |
| `completed` | 当前修订号的验收通过 | 第六节 | 用户追加需求 = 新修订号 → `queued` |
| `failed` | 执行失败且不再自动重试 | 重试用完、准备失败 | 用户明确重试 → `queued` |
| `cancelled` | 用户终止 | 用户取消 | 只能新建或用户明确恢复，**旧的自动事件不能复活** |

`reason` 的代码（界面按它写人话）：`user_paused`、`budget_cost`、`budget_tokens`、`budget_time`、`budget_runs`、`restart_check`、`imported`、`stalled`、`missing_input`、`needs_decision`、`needs_permission`、`waiting_job`、`waiting_subagent`、`waiting_event`、`review_unparsable`、`run_failed`、`prep_failed`……

**和现有 `tasks.status` 的关系**：工作项（任务）的状态照旧（`waiting / running / needs_input / done / no_change / failed / interrupted`），描述「这一件事」；目标的状态描述「整件事」。任务 `done` 不等于目标 `completed`——那要审查说了算。界面上目标卡片显示目标状态，展开看各个任务。

**显示上分开的五个说法**（共同原则 4）：「执行结束」（run 结束）≠「产物已生成」（`artifacts` 里有）≠「机器验收通过」（program + model 层通过）≠「等你验收」（`waiting_user` 且 `reason = acceptance`）≠「完成」（`completed`）。

## 五、唯一调度者和续跑协议

### 5.1 谁是调度者

后台里一个 `GoalScheduler`（0.8 新模块），**是唯一能改目标状态、能启动续跑的地方**。其他人——工作台、蝶君、定时任务、子 Agent、后台作业、记忆、压缩、0.9 的规则——只往 `goal_events` 写事件（共同原则 1）。

每个活动目标有一个执行租约：`lease_owner`（后台实例 ID）、`lease_generation`、`lease_until`。所有写目标的语句都带条件：

```sql
UPDATE goals SET status = ?, ..., updated_at = ?
WHERE id = ? AND lease_generation = ? AND revision = ? AND stop_intent IS NULL
```

改到 0 行就说明期间有人改过（用户停止、修订、别的实例接手），这次的决定作废、重新读。这就是「比较后提交」，不是「先读后写」。后台现在是单进程，但三个后台同时启动的锁竞争（HANDOFF 里留着的问题）、崩溃后新实例接手，都靠这个保证不出双份。

### 5.2 事件

| 事件 kind | 谁发 | 去重键 |
|---|---|---|
| `run.finished` | TasksModule.onRunFinished | `run:<runId>` |
| `user.input` | 用户在目标所属会话里发消息 / 插话 | 消息 ID |
| `user.control` | 暂停 / 恢复 / 停止 / 取消 / 修改目标 | 操作 ID |
| `job.finished` | 后台作业（`JobRegistry`）、子 Agent 结束 | `job:<id>` |
| `schedule.fired` | 定时任务触发（挂在目标下的） | `schedule_runs.trigger_key` |
| `review.done` | 审查返回 | `review:<id>` |
| `budget.changed` | 用户放宽预算、跨天 / 跨月 | 操作 ID |
| `memory.candidate_ready` | 记忆（0.5） | 记忆任务 ID |
| `context.ready` | 压缩（0.5） | 压缩候选 ID |
| `rule.matched` | 0.9 的规则（自动档） | 来源事件 ID |

`dedupe_key` 唯一：同一事件到两次只记一次（Goal 报告 §14「完成事件重复到达」）。记忆和压缩的事件**只是让调度者知道「材料准备好了」**，它们本身不触发续跑。

### 5.3 什么时候判断续跑：空闲边界

只在**真正空闲**时判断（Goal 报告 §2.2）：

1. 目标所属的会话没有 run 在跑（`slot.running` 为假）；
2. 没有待处理的用户输入（Pi 的 steer / followUp 队列为空，`goal_events` 里没有未处理的 `user.*`）；
3. 没有本目标在等的计算（`goal_waits` 里 `kind = compute`、`status = open` 的，对应的作业还在跑）。

常驻服务（开发服务器、`watch` 一类）不算「在等的计算」：后台作业登记时带 `service: true`（模型启动它时声明，或按命令识别），它们不挡空闲、不挡完成，只在界面上列出「还在运行的服务」。

### 5.4 调度者的一步

```text
处理一条事件（或空闲检查到点）
  1. 读最新：目标（revision、stop_intent、预算）、未处理的用户输入、授权
  2. stop_intent 非空 → 按第十节处理，结束；不启动任何续跑
  3. 有未处理的用户输入 → 交给执行者（插话，第十一节），旧的续跑意图作废（dropped）
  4. 有本目标在等的计算 → 登记/更新 goal_waits，状态 waiting_dependency，结束
  5. 预算检查（第八节）：超了 → paused(budget_*)，结束
  6. 进展检查（第七节）：停滞 → 有限换路 / blocked(stalled)
  7. 该审查吗？（第六节：有明确未完成的确定性步骤就不审查，直接续跑）
       审查 → 固定 evidence_version → 审查 → 校验结论对应的 revision 和 evidence_version
  8. 写决定前再读一次 stop_intent / revision / lease_generation（条件更新）
  9. 按结论：
       done        → completed，发一次通知（通知也带去重键）
       continue    → 写 goal_intents（idem_key = goal:revision:generation:序号），状态 queued
       wait        → goal_waits + waiting_dependency
       blocked / needs_user → 写清原因和恢复条件
```

**续跑意图先落库再执行**：`goal_intents` 写成功后，执行器领取（`status: pending → started`，条件更新），启动 run 前**再查一次** `stop_intent` 和授权。崩溃发生在写意图和启动之间时，重启后看到 `pending` 的意图，按第十节的恢复检查处理，不盲目重放。

续跑的提示词由程序生成（「继续推进目标，当前未完成的验收项：……；上次审查指出：……」），**目标原文和约束每次从 `goals` 读**，不从对话历史或摘要里取（共同原则 2）。

## 六、验收

### 6.1 验收条目（`spec.acceptance[]`）

```text
{ id, text,                       // 人能看懂的一句话
  layer: "program" | "model" | "user",
  check?: { kind: "file_exists" | "file_parses" | "file_unchanged" | "command_ok" | "tests_pass" | "sources_read" | "contains",
            args: {...} } }
```

- 程序层（确定性，免费、先跑）：文件在、能解析（JSON / CSV / docx / xlsx / PDF / 图片打开得了）、约束里的文件 digest 没变、指定命令退出码 0、规定的测试通过、指定的来源确实被读过（看 run_steps 里的读文件 / 抓网页记录）、产物里包含某些内容。
- 审查模型层（语义）：产物是否回答了目标、有没有漏掉用户约束、证据够不够。
- 用户层：审美、偏好、事先约定要人看的。

目标建立时由模型从用户原话提一份验收条目草稿，**用户在目标卡片上能看、能改**；程序层能自动加的就自动加（例：「不改原文件」→ 每个提到的原文件一条 `file_unchanged`）。

### 6.2 审查模型

- **只读**：能读目标、证据列表、产物（读文件工具，限定在目标范围内），**没有写、执行、联网工具**；需要新的验证（比如跑一次测试）时返回「要做的验证动作」，由调度者在原授权内安排（Goal 报告 §7）。
- 输出固定格式（JSON）：`verdict: done | continue | wait | blocked | needs_user`、`missing[]`（未满足的验收条目 ID）、`next`（建议的下一步，一句话）、`questions[]`（needs_user 时）、`revision`、`evidence_version`。解析不了重试有限次（建议 2 次），仍不行 → `paused(review_unparsable)`。
- 结论对应的 `revision` / `evidence_version` 和当前不一致 → 作废，不覆盖用户之后的操作（Goal 报告 §14「暂停时审查正好返回」）。
- **什么时候审查**：执行者报告「完成了」、产物修订、到达阶段末尾、进展检查觉得可能完成；**程序层还有没通过的条目时不叫审查模型**（省钱：先把能确定的做完）。
- 「模型说完成了」不是证据；测试没跑不能写「测试通过」：审查看的是 `goal_evidence`，不是对话里的话。

### 6.3 用户验收

有 `layer: user` 的条目时，机器层全过之后进 `waiting_user(reason = acceptance)`，界面显示「等你验收」和产物；用户点「通过」→ `completed`（写一条 `kind = user_ack` 的证据）；「还要改」→ 新修订号（附用户的意见）→ `queued`。

## 七、进展和防空转

**轮数不是进展。** 每次 run 结束算一个进展指纹：

```text
fingerprint = hash(
  证据版本, 已通过的验收条目集合, 产物的 digest 集合,
  已解决的等待, 剩余未完成条目数, 最近一次错误的归一化文本)
```

- 指纹和上次一样 = 这次没有可检查的进展，`progress.stall += 1`；有变化清零。
- 另外几种停滞信号（Goal 报告 §8）：同样的错误在同样条件下重复（错误文本归一化后相同）；计划改了但没有动作和新证据；反复读同一批材料没有新结论（run_steps 里读的文件集合和上次相同、没有写）。
- `stall` 到阈值（建议 2）→ 调度者在续跑提示里明确要求「换一条路」（列出试过的路），有限次（建议 1 次）；仍没进展 → `blocked(stalled)`，界面写清卡在哪、试过什么。
- 纯写作、纯推导也是进展：产物的 digest 变了就算，不要求「必须调用工具」。

## 八、预算账本

- **目标的预算**（`goals.budget`）：费用、token、活跃时长、run 次数、并发数。全局的日 / 月上限（`settings.dailyBudgetUsd` / `monthlyBudgetUsd`）照旧管所有花费。
- **预留和结算**：每次调模型前（主执行的一轮、子 Agent、审查、记忆、压缩），先在 `ledger` 写一行 `reserved`（估算：输入 token × 单价 + 预计输出上限），并发的几个调用都看得到彼此的预留；返回后改成 `settled`（实际值）或 `released`（没发出去）。可用余额 = 预算 − settled − reserved。不够就不发，进 `paused(budget_*)`。
- 现有的 `TasksModule.checkLimits`（每个 `turn_start` 检查轮数和日 / 月花费）保留，0.8 时改为读账本；`notices` 的暂停卡片加 `goal_id`，「继续」= 放宽这个目标的预算（写 `budget.changed` 事件），不再是 `extraTurns` 这种只在内存里的加成。
- 换会话、重启、导入都不清零：账本在数据库里，按 `goal_id` 汇总。
- 没用上的压缩候选、观察模式的评估（0.9）也记账（共同原则 7），仪表盘（0.6）按 `kind` 分类显示。
- 估不准的费用（渠道没有单价）标「估计」，不当成 0。

## 九、等待和后台工作

三种等待分开（DSH 报告 §8.2）：

| 等待 | 例子 | 资源 | 唤醒 |
|---|---|---|---|
| 等计算 `compute` | 测试在跑、长脚本、子 Agent | 执行者可以先结束这一轮 | `job.finished`（真实的作业 ID） |
| 等外部事件 `external` | 等某个文件夹出现新文件、等下一次定时 | 释放执行资源，保留订阅 | 对应事件；有 `deadline` |
| 等用户 `user` | 缺资料、要决定、要验收 | 释放 | 用户回答 |

- 后台作业（`agent/shell.ts` 的 `JobRegistry`）和子 Agent 登记时带 `goal_id`、`owner run`、`service` 标记；结束时发 `job.finished`（去重键是作业 ID）。
- 现在的后台作业只活在会话的内存里（会话关了就没了）。0.8 要让目标的后台作业**跨会话可查**：作业的元数据（ID、命令、开始时间、输出文件位置、状态）落库，输出写到 `data\cache\jobs\`；重启后进程已经不在的作业记为 `lost`，等待它的目标进恢复检查。
- 超时（`deadline`）要说明是什么超时：作业失败、通知丢了、还是服务仍在跑。不能无限等。
- 子 Agent 的权限不超过父目标（已经是这样：继承父会话的审批规则和沙箱），花费记到父目标的账本。

## 十、停止、重启和导入

用户的四种停止（界面上分开，roadmap 8.6）：

| 操作 | `stop_intent` | 做什么 | 界面要说明 |
|---|---|---|---|
| 暂停这个目标 | `pause` | 当前 run 跑完这一步后不再续跑；不打断正在跑的 | 「当前这一步还在进行，做完后停下」 |
| 停止当前执行 | `stop_run` | abort 当前 run，目标进 `paused(user_paused)` | 列出还在运行的后台作业和服务，问要不要一起停 |
| 取消目标 | `cancel` | abort + 停掉本目标的后台作业 → `cancelled` | 列出已经发生、收不回的动作（写过的文件、发出的请求） |
| 紧急停止全部 | `emergency` | 所有目标 abort、所有后台作业停、所有续跑意图作废、后台停止领取新意图，直到用户解除 | 全局横幅 |

- `stop_intent` 写进数据库，调度者的每个条件更新都带 `stop_intent IS NULL`：**旧的审查结果、完成事件、续跑意图都不能把它复活**。
- **重启恢复检查**：后台启动时，所有 `running` / `reviewing` / `queued` 且有 `started` 意图的目标 → `paused(restart_check)`；调度者核对：最后一个 run 的状态、产物是否还在（digest）、后台作业是否还活着、账本里 `reserved` 的行（改为 `released` 或按 run 的实际花费结算）。低风险、有明确恢复策略的（默认只有「等计算」中的目标、且作业还活着）可以自动恢复，其余等用户点「继续」（待定项 8）。
- **导入**（v0.3.1 的备份恢复）：所有非终态目标 → `paused(imported)`，不自动恢复（换了电脑，路径、沙箱、工具都可能不一样）。

## 十一、插话和跟进

- 目标的会话里，用户新发的消息**先交给这个目标的执行者**（DSH 报告 §6）：正在跑 → 作为 steer 插进当前 run（现有 `session.steer`）；没在跑 → 作为下一次续跑的输入。「刚才那个改成只读」进入原目标、提升修订号，**不新建第二个任务**。
- 修改目标、约束、验收条件的话由执行者识别后调用目标工具（`goal_update`，第十五节），调度者写新修订号；旧修订号上的审查、续跑意图作废。
- 「立即插入」（打断当前步骤）：待定项 6。
- 用户在别的会话里说的事不会自动并进这个目标；话题相似只当「关联候选」，界面上提示，用户确认才挂上。

## 十二、和 0.5（记忆与上下文）的接口

先定下来，0.5 和 0.8 各自照着做：

1. **任务边界从目标服务来**（memory-design 16.2）：目标服务在这些时候发 `task_boundary` 事件给记忆模块：新建目标、目标修订（约束变了）、进入下一阶段、新工作项开始 / 结束、挂在目标下的定时任务每次运行。没有目标的普通会话，边界照 memory-design 16.2 自己判断。事件带 `goal_id`、`revision`、`task_id`，记忆模块用它做快照的版本键。
2. **记忆、压缩只发事件**：记忆的「候选就绪」→ `memory.candidate_ready`；压缩的「上下文可用」→ `context.ready`。调度者收到后**只是记下来**，下一次本来就要发请求时，上下文装配会用上；**它们不触发续跑**（memory-design 16.7、共同原则 1）。
3. **结构化真值每次单独放进上下文**：目标原文、当前修订的约束和验收条目、授权范围、剩余预算，由上下文装配（Pi 的 context 钩子，memory-design 6.3 的同一个注入点）**每次请求都从 `goals` 读**，放在记忆快照之后、对话之前；压缩摘要里关于目标的内容只是背景。目标修订后，上下文里的这一块立即换成新的。
4. **防复活**：用户推翻的约束（旧修订号里的）在压缩摘要里出现时，上下文装配不靠摘要判断，以 `goals` 为准；0.5 的「被纠正的事实不从摘要复活」测试加一条「被修订掉的目标约束不复活」。
5. **账本**：记忆任务、压缩（含没用上的候选）带 `goal_id`（有的话）写 `ledger`，`kind = memory / compaction`。

## 十三、和 0.9（蝶君自主）的接口

- 0.9 的规则接活 = 新建 `source = rule` 的目标，`mandate_ref = rule:<ID>@<版本>`；观察模式只写评估记录（`ledger.kind = assessment`），不建目标。
- 0.9 的「先存状态、再做副作用」（effects / outbox）复用本文的模式：意图先落库（带幂等键）、执行器领取、执行前再查停止和授权。通知、交付、对外动作都是 `goal_intents.action` 的一种。
- 规则或授权收紧：0.9 给工具层加「受保护操作前重新检查 `mandate_ref`」，本文的调度者在第 1 步也会读到最新授权。

## 十四、界面需要的数据（给 0.4 右侧面板留位置）

0.4 的右侧面板先按这些块排版（0.8 再接上真数据），任务视图的排序也先按这个：

- **目标块**：标题、状态和一句原因（「等你验收」「预算用完：$1.20 / $1.00」「卡住了：同样的报错出现 3 次」）、当前阶段 / 下一步（审查的 `next`）、验收条目清单（勾选状态，`program / model / user` 三种图标）、已用预算（费用、时长、run 次数，进度条）、按钮：暂停 / 停止 / 取消 / 修改目标。
- **任务列表**：目标下的工作项，每项的状态、产物、花费；展开看各次尝试（runs）。
- **等待块**：在等什么（作业、子 Agent、用户的问题），能点进去看。
- **还在运行的服务**：常驻的后台作业。
- **任务视图的排序**：等你决定 → 阻塞 → 等你验收 → 运行中 → 暂停 → 完成。
- **通知**（共同原则 6）：只在 `completed`、`waiting_user`、`blocked`、`paused(budget_*)` 时通知一次（通知带去重键 `goal:revision:status`）；单轮结束、子任务完成、审查结束都不通知。

## 十五、RPC、事件、给模型的工具

- RPC：`goals.list / get / create / update / control(pause|resume|stop_run|cancel|emergency|clear_emergency) / accept / reject / budget / ledger / history`。
- 广播：`goals.changed`（带目标 ID 和新状态）。
- 给执行者模型的工具（目标会话才有）：`goal_status`（读当前目标、未完成的验收条目、剩余预算）、`goal_update`（用户要求改目标时提议修订，调度者落库）、`goal_report`（执行者报告「我认为完成了 / 卡住了 / 需要问用户」——只是一个信号，触发审查，不改状态）、`goal_wait`（登记在等哪个作业）。
- 「要不要设为目标」卡片：执行者对明确的长任务请求可以提议（用 0.3 的卡片 / 提问框），列出对象、结果、边界、验收条目草稿、预算；用户接受才建目标。普通聊天不强行变成目标。

## 十六、迁移

- 数据库升级：加新表、加列；现有 `tasks` 的 `goal_id` 为空，行为不变。
- 现有的 `extraTurns`（内存里的「继续」加成）在 0.8 改为写进目标的预算；没有目标的普通任务保留现在的做法。
- `notices` 的旧 kind 保留，新加 `goal_budget`、`goal_blocked`、`goal_acceptance`。

## 十七、测试（0.8 的 8.11 用）

Goal 报告 §14 的每一条都做成后台的单元 / 集成测试（假模型，确定性），加上真实模型的长任务测试集：

| 场景 | 期望 |
|---|---|
| 需要多轮的明确目标 | 不用用户说「继续」推进到验收 |
| 用户插话时正好要续跑 | 新输入优先，旧续跑意图 dropped |
| 用户暂停时审查正好返回 | 审查结论作废，状态仍是 paused |
| 部分产物缺失 | 不报完成，`missing[]` 指出缺什么 |
| 子任务没结束 | `waiting_dependency`，不反复审查 |
| 常驻开发服务器 | 不挡完成，列在「还在运行的服务」 |
| 模型连续输出相同计划 | stall 计数，有限换路后 blocked |
| 预算并发耗尽 | 预留生效，不超额，不重置 |
| 崩溃（写意图后、启动前）和导入恢复 | 不重复执行、不复活取消的目标 |
| 压缩和纠正同时发生 | 新约束生效，旧约束不从摘要复活 |
| 纯聊天 | 不变成目标 |
| 完成事件重复到达 | 状态和通知都只一次 |
| 修订后旧审查返回 | 作废 |
| 紧急停止 | 所有目标停、意图作废、解除前不领取 |
| 重启后后台作业已不在 | 等待它的目标进恢复检查，说明原因 |

## 十八、待定项（建议值，等用户定）

| # | 问题 | 建议 |
|---|---|---|
| 1 | 目标的默认预算 | 费用 $2、活跃时长 2 小时、run 次数 30、并发 2；蝶君的自主目标（0.9）减半。用 8.11 测试集跑一轮后再调 |
| 2 | 停滞判据 | 指纹连续 2 次不变 → 要求换路 1 次 → 仍不变 blocked |
| 3 | 审查用哪个模型 | 默认和执行同一个渠道的同一模型（DeepSeek 便宜，审查质量够用）；设置里可以单独选 |
| 4 | 审查的频率 | 只在执行者报告完成、产物修订、程序层全过时审查；不每轮审查 |
| 5 | 审查结论解析不了重试几次 | 2 次 |
| 6 | 「立即插入」 | 直接打断当前步骤（等这一步的工具调用结束，不拆开调用和结果），不再问一次 |
| 7 | 什么时候提「要不要设为目标」卡片 | 只在用户的请求同时满足：有明确产物、预计要多轮、给了范围；其他时候不提；用户可以在设置里关掉 |
| 8 | 重启后自动恢复的范围 | 只有「等计算」且作业还活着的目标自动恢复；其他进 `paused(restart_check)` 等用户点 |
| 9 | 等外部事件的默认期限 | 7 天，到期 blocked 并说明 |
| 10 | 等计算的超时 | 跟着作业自己的超时；没有的默认 2 小时 |
| 11 | 工作台要不要也开目标 | 开（同一套服务），但工作台不主动提卡片，只在用户点「设为目标」或明说时建 |

## 十九、0.8 的实现顺序（建议）

1. 表和迁移、`GoalsModule` 的读写和状态机（不接执行）；备份声明。
2. 调度者：事件、空闲边界、续跑意图、租约和条件更新；先只有程序层验收。
3. 账本：预留 / 结算，接上现有的 limits 和 notices。
4. 停止的四种、重启恢复检查、导入暂停。
5. 审查模型（只读）和用户验收。
6. 进展指纹和停滞。
7. 等待：后台作业落库、子 Agent、外部事件。
8. 插话路由、`goal_*` 工具、「设为目标」卡片。
9. 界面（接上 0.4 留好的位置）。
10. 第十七节的测试和 8.11 测试集。

## 实现记录

（0.8 实现时补写：和本文不同的地方、为什么。）
