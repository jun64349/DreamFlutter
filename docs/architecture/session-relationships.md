# 会话关系与侧边对话接口（v0.5 第 7 步）

依据 T-07 的 C1–C9、用户确认的 Q-01 和 Claude 反馈 F-01。本步交付后台接口及现有侧边对话的兼容修改；子会话入口、删除数量提示、来源已删除的展示由第 8 步设计落地。

## 文件与类型

Pi JSONL 继续作为数据源。header 的 `parentSession` 是唯一的父文件关系；不新建关系文件，不迁移用户会话。

- `customType: "df.sideConversation"`，`data: { sessionId, quote, quoteEntryId }`。`sessionId` 必须等于本文件 header id 才表示侧边对话；`quoteEntryId` 取不到时为 null。复制来的祖先标记不改变普通分叉的类型。
- `customType: "df.inheritedHistory"`，`data: { sessionId, lastEntryId }`，记录复制历史的末条 entry id，供计费排除。新侧边与通过宿主创建的普通分叉均写此边界。
- 无本会话侧边标记的旧文件仍是普通会话。继承用量依次按本会话的显式边界标记、索引数据库内已确认的继承缓存、父文件中的相同 entry id 排除。父文件可读时，将匹配出的 entry id 集合缓存到数据库；确认没有继承条目的空集合也有效。之后父文件删除，索引与 `get_session_stats` 共用缓存，不再退回时间比较。
- 仅当没有显式标记、没有已确认缓存且父文件不可读取时，旧分叉才使用时间近似：带 usage 的条目时间戳 `<=` 子会话 header 创建时间则算继承，不带用量的条目不参与判断。此规则无法精确恢复所有旧数据的归属；没有缓存时，同毫秒的合成自有回复也会被视为继承。时间估计不写入确认缓存；新文件一律走显式标记，不依赖父文件判断费用。
- schema 第 10 次迁移为 `session_meta` 添加 `session_type`、`side_quote`、`quote_entry_id`，使已有索引重新解析；保留 pin/archive，不重写 JSONL。
- T-07R 的 schema 第 12 次迁移新增 `session_inherited_history(session_id, parent_session, entry_ids)`，让现有索引重新解析并缓存旧分叉的已确认边界。该表纳入会话备份及路径重映射；删除来源会话保留子会话的缓存，删除子会话时才清理其缓存。此机制不写回旧 JSONL。

## 创建与发送

`slot.open` 原有字段继续兼容，新增/明确以下字段：

| 字段 | 含义 |
| --- | --- |
| `cwd` | 必填，必须与父会话同工作区 |
| `forkOf` | 父会话文件路径；有此字段即创建侧边对话，不再要求同时传 incognito |
| `parentSlotId` | 从活跃 slot 复制当前分支；无痕来源须用此字段，不需要文件 |
| `sideQuote` | 引用文本快照，缺省空串 |
| `quoteEntryId` | 可选的父会话条目 id |
| `incognito` | 显式 true 或父 slot 无痕时，不保存；默认持久化侧边对话 |

创建与打开已有文件不能同时指定。父会话正在保存或删除时返回冲突；尚未保存的非无痕父会话不能作为来源。继承父会话的模式、模型和沙箱记录。

`slot.open`、`slot.list`、`slot.attach.info`、`slot.changed.info` 的会话信息增加：

| 字段 | 含义 |
| --- | --- |
| `sessionType` | `ordinary` 或 `side` |
| `willPersist` | false 表示此会话不会保存，不等同于当前已经落盘 |
| `forkOf` | 侧边对话的来源文件；普通会话为 null，无痕来源也可能为 null，判断类型应看 sessionType |
| `sessionFile` | 侧边对话首发前为 null，保存后为独立文件 |

仍通过 `slot.send` 内的 `prompt` 发送，无单独保存方法。后台先写完整快照，以公开 Pi API 创建并绑定持久化运行时，最后把首条消息交给模型。原内存运行时在此期间保留；身份与 slot 不变，不调用新会话/替换会话钩子。

保存中再次发送返回可重试错误；成功首发的同一连接、同一请求与内容重放不会再次调用模型。客户端重新附着会重置请求去重作用域，避免新的 RPC 客户端复用编号时丢消息。首发前的 steer/follow_up 被拒绝，请先用 prompt。

快照写入或重开/绑定失败时，后台删除本次创建的文件、恢复原运行时并返回失败；已有同名文件不会被覆盖或删除。索引与普通打开操作看不到准备中的文件。窗口仅在成功后清空原输入，失败后的重试仍携带首次引用文本。

关闭会等待首发事务：进入发送前可回滚；已进入模型发送则保留完整会话后按通常关闭语义停止运行。关闭与后台退出重叠时，也要等关闭操作结束才关闭数据库。这里验证的是应用正常退出与可控异常，不是断电/强制终止的跨进程事务保证。

关闭完成前保留 slotId、文件与父关系的占用；同 id 重开、同文件另开返回冲突，重复关闭等待同一关闭过程。释放运行时、清理控制句柄并发出 `slot.closed` 后才允许复用身份。

## 查询

- `sessions.list({cwd?, archived?})`：仅普通会话，普通分叉照常显示。
- `sessions.children({parentSession, cwd?})`：同一工作区的直接子会话，包含普通分叉和侧边对话；cwd 缺省取父索引。父索引不存在时必须提供 cwd。
- 两种列表均返回原 `SessionRow` 字段，增加 `sessionType`、`parentMissing`、`quote`、`quoteEntryId`。`parentSession` 为父文件路径；父文件缺失不妨碍重开子文件。quote 是引用快照，界面可截断展示。
- `slot.open({cwd, sessionFile})`：以正常方式重开侧边文件，按文件标记恢复隔离规则。
- `sessions.search` 不返回侧边会话；它们的消息不写入 FTS。

## 删除

- `sessions.deletePreview({path})` → `{sideCount, paths}`。paths 包含目标及同工作区中递归挂在其下的侧边文件；普通分叉及其子树不连带删除。
- `sessions.delete({path})` → `{deleted, sideCount}`。先锁定关系、关闭相关运行时，再移动目标及侧边文件到 Windows 回收站；其他平台沿用原先直接删除语义。清理相应索引、FTS、用量和会话卡片，固定到桌面的卡片保留。
- 只允许索引中的会话目录内文件，校验真实路径，拒绝越界目标。打开/创建/切换会话不能绕过删除锁。若会话还在启动，要求稍后重试。
- 已在关闭的关联 slot 仍参与删除范围判定；删除等待其关闭完成，再刷新索引并重算连带集合，纳入首发已经接受但尚未发布索引的侧边文件。
- 真实文件删除失败返回错误；已经成功回收的文件保持已删除，未成功的仍保留，索引按实际状态清理。回收站多文件操作不宣称具备文件系统事务回滚能力。
- Flutter 原删除操作已改调后台。删除前显示 sideCount 的提示、普通分叉的 parentMissing 展示和侧边重新打开入口属于第 8 步。

## 记忆、任务与计费

侧边运行时不加载记忆扩展：无记忆工具、无快照准备、无任务边界、无压缩后记忆刷新；父历史已有的上下文可继续只读使用。事件、运行结束钩子跳过校准、工具反证、回忆冲突检查、未保存声称检查和自动提取。手动提取返回 null，队列中遗留的提取任务也按文件标记跳过。

`memory.tasks` 返回空列表，`memory.newTask` / `continueTask` / `refresh` / `setSessionMode` 拒绝侧边目标；`memory.sessionMode` 返回 readonly。通用任务不自动绑定侧边会话，`tasks.bind` 拒绝它。每周整理仍只使用记忆库条目；侧边内容不进入该库。没有改动已定记忆设计。

定时计划的 bound 目标同样不能是侧边会话：`schedules.save` 拒绝保存该绑定，启动遗留的无效计划时，在创建通用任务之前将该次计划运行标为失败。活跃侧边与已关闭的侧边文件遵循同一规则；带 `taskId` 打开侧边、直接预赋绑定均被拒绝，运行记录及任务生命周期也独立阻断旧绑定旁路。

侧边会话可压缩。session-index 记录其自身回复、usage、compaction、branch_summary 用量，复制的历史不再次入账。`get_session_stats` 同样扣除继承用量，消息数与上下文大小仍反映实际完整历史。普通分叉按同样规则处理。自动标题跳过侧边会话，避免因复制父历史产生额外标题调用。

## 验证入口

- `core/test/side-sessions.test.ts`：生命周期、身份、重开/重启、同工作区、故障回滚、竞态、隔离、费用、压缩、删除、旧普通分叉。
- `core/test/t07r.test.ts`：关闭中身份复用、首发/关闭/主删除交错、活跃与关闭侧边的定时绑定、预赋 taskId、旧分叉同毫秒费用与父文件删除后的缓存持久化。
- `app/test/side_chat_test.dart`：现有引用/发送/带回主对话/结束，以及失败输入保留和再次发送。
- `packages/pi_rpc/test/core_test.dart`：Dart 客户端到真实后台的字段传输及无痕父 slot；`session_store_test.dart` 验证兼容列表不会把侧边文件带回顶层。
- 本轮实际命令、结果与真实模型待验状态见 T-07 实施回执。
