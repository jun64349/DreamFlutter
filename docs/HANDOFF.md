# DreamFlutter 开发交接

更新时间：2026-11-06（v0.4.0 已打 tag；计划改成后端优先；记忆设计全部定稿。**下一个窗口：开发 0.5「记忆与上下文」**）

## 新窗口从这里开始：0.5 开发

### 一、先读这些（按顺序）

1. [dev-guide.md](dev-guide.md)：开发规范和踩过的坑（**动手前必读**）。
2. [roadmap.md](roadmap.md)：第一节第 6 条「后端优先」；第二节「2026-11-06 定下的事」；**v0.5 一节（5.0–5.13）**；附录 D（0.4.0 报告 11 条的去向）。
3. [memory-design.md](memory-design.md)：0.5 的开发设计，**用户 2026-11-06 已定稿**。重点：第二节数据结构、第四节「默认自动生效」和例外、第六节快照组装、第十二节定稿值、**第十四节实现顺序**、第十六节任务边界、第十七节遗忘补强。
4. [research/hermes-memory.md](research/hermes-memory.md)：Hermes 记忆机制调研（第十七节的来源，可选读）。
5. [long-task-design.md](long-task-design.md)：只看和 0.5 的接口（任务边界事件、压缩完成只发事件不续跑）。
6. [testing/scenarios.md](testing/scenarios.md)：发布前要走的全场景清单；0.5 的新功能要在里面加行。

### 二、0.5 的范围

- **后端**：roadmap 5.1–5.13：三级记忆、快照、写入、转化与遗忘、作用域、记忆 Agent、用户控制的接口、强度和频率设置、模式行为、旧记忆迁移、任务边界（5.11）、上下文服务和压缩（5.12）、会话关系（5.13：分叉来源接口；**侧边对话保存**：挂在原对话下、能打开，不进记忆、搜索、任务，算进统计）。
- **只做必要的界面**（后端优先，roadmap 第一节第 6 条）：
  - **记忆日志**：按天列出存了哪些、改了哪些、忘了哪些，能改、能删、能撤销（「默认自动生效」的安全网，必须有）；
  - 工作区记忆提升为全局时的确认；
  - 「说记住了但没存」的提示和「保存」按钮（memory-design 17.7）；
  - 新的设置项（写入前要我确认、记忆模型、后台预算、强度和频率）加在现有设置分类里；
  - 侧边对话保存后的最简打开入口。
  - 其余（完整记忆页、「本次用了哪些记忆」「为什么没想起来」、右栏的上下文）都在 0.11。

### 三、已经定下的（不要再问用户）

- **记忆默认自动生效**（2026-11-06）：新增、修改、升级、合并、到期、推翻、软遗忘都自动做，记入按天的记忆日志（原因、来源、可撤销）。**例外**：锁定的不自动改（只标待复核并提醒）；彻底删除只能用户做；工作区记忆提升为全局要用户决定。设置里有「写入前要我确认」（默认关）。
- 遗忘（17.10）：有效期到了自动标「已结束」退出快照；对工具 / 环境的判断默认 30 天有效，遇到反例自动推翻；回想时发现矛盾自动排复查；「说记住了但没存」提示 + 保存按钮；删除会话时提取出的记忆保留（来源标「会话已删除」）。
- 第十二节 12 项全部按表里的值；记忆 Agent 只碰记忆库（无文件、无命令、无网络）；记忆模型默认用辅助模型（`llm.ts` 的 `auxModel`）；记忆后台预算默认每天 $0.20。
- 侧边对话：保存、不进记忆 / 搜索 / 任务、算进统计。

### 四、还没定、做到时再问用户

- 后台压缩（5.12）：提前量、摘要用哪个模型、费用上限（roadmap v0.5「要用户定的」）。
- long-task-design 第十八节 11 个待定项（0.8 前定就行，0.5 不用）。

### 五、现有代码起点

- `core/src/modules/memory.ts`（736 行）：v0.2 的扁平模型（表 `memories` / `memory_blocks` / `memory_snapshots` / `memory_extraction`）；工具 `memory_search` / `memory_save` / `memory_update` / `memory_forget` / `memory_block_edit` / `session_search`；`before_agent_start` 注入 `df-memory` 快照；运行结束后 `extract`；v0.3.3 的止血 `nearDuplicate` / `saysMore`。窗口接口 `memory.*`（list、add、edit、remove、history、accept、reject、blocks、setBlock、snapshots、extractNow、refresh、clear、export，事件 `memory.changed`）。
- `core/src/schema.ts`：迁移只能往后加。0.4.0 是 8 个（`user_version` 8；原来这里写的 16 是错的）；**0.5 的新表都在第 9 个里**（0.5 发布前还可以往第 9 个里加，发布后就不能再改）；**新表要 `core.declareBackup(...)`**，否则 `backup.test.ts` 失败（dev-guide 第二节）。
- 窗口：`app/lib/ui/memory_page.dart`；测试 `core/test/memory.test.ts`。
- 压缩：`core/src/agent/harness.ts`（`session_before_compact`）、`core/src/pi/host.ts`。
- 侧边对话：窗口 `agent_controller.dart` 的 `openSideChat` / `_endSideChat`、`state/side_chat.dart`；后台 `core.ts` 的 `openNewSlot`（`forkOf`）、`pi/host.ts`（`SessionManager.inMemory`）、`slots/slot.ts`（会话信息里的 `forkOf`）。5.13 要把它改成存盘的会话。

### 六、建议的开工顺序（memory-design 第十四节，补上 0.5 新加的）

1. 新表 + 旧记忆迁移 + 范围函数 `allowedScopes` + 操作接口（程序侧守门、事务、版本、留痕）+ **记忆日志**；先不接记忆 Agent。
2. 快照组装改造：预算、配额、素材、`context` 钩子防重复和即时纠正、压缩防复活、降级标记。
3. 记忆 Agent 角色卡 + 任务队列 + 任务结束提取 + 每周整理。
4. 分层转化、冲突、周期复查；第十七节的到期、反例推翻、回想复查、矛盾预筛、不记的清单、原子条目。
5. 软遗忘、恢复、回撤、彻底删除；写入 / 加载安全扫描；「说记住了但没存」检测。
6. 任务边界（5.11，第十六节）+ 上下文服务和压缩（5.12；后台压缩那几个参数先问用户）。
7. 会话关系和侧边对话保存（5.13）。
8. 最简界面（第二节列的那几样）+ 端到端测试加对应步骤 + scenarios.md 加行。

每一步都带测试（后台用假时钟、脚本化假模型，见 memory-design 第十三节和 17.11）；每个修复确认「去掉修复测试会失败」。

### 七、仓库和发布状态

- 交接时工作区干净。**从 `aba5e45` 起的所有提交（0.4 全部、计划修订、记忆设计、这份交接）和 tag `v0.4.0` 都没推送**（GitHub 上最新还是 `v0.3.4`；用 `git log origin/main..main` 看）。推送要用户点头，命令见下面「推送」。
- 用户的测试版 `E:\DreamFlutter测试版` 是 0.4.0（升级命令见下面「用户的测试版在哪、怎么升级」）。
- 用户 0.4.0 的测试报告：`C:\Users\21669\Desktop\毕设、agent学习笔记库资料库\DreamFlutter\dfv0.4.0 测试记录.md`（已全部处理进计划）。

### 八、和用户合作的规矩（摘要，详见下面「和用户合作的约定」）

- 回复用平实的简体中文；用户不是开发者，要用户运行的命令给完整的 PowerShell（先 `cd`）。
- **提交、打 tag、推送都等用户说**。
- 测试模型走 OpenCode Go（不新建渠道、不经手 Key）；e2e 前用户的应用要先退出。
- 不从 Claude 的终端替用户启动应用做试用。
- 本机没有全局 Python：用 `core\bin\uv.exe` + `core\python\` 建临时 venv。改代码用 Edit / Write，别用 heredoc / sed 改含反斜杠的代码。

## 0.5 进度

### 第 1 步：新表、迁移、范围函数、操作接口、记忆日志（2026-11-06，**未提交**）

- 代码在 `core/src/memory/`：`types.ts`（条目、操作、日志的类型）、`store.ts`（记忆库和程序侧守门）、`scopes.ts`（工作区的稳定 id、`allowedScopes`）、`migrate.ts`（v0.2 迁移）、`text.ts`（相似度，从 memory.ts 挪出来）。`modules/memory.ts` 改成接在新库上。
- 数据库第 9 个迁移：`workspaces`、`workspace_groups`、`workspace_group_members`、`memory_items`、`memory_versions`（每一版都存整条）、`memory_sources`、`memory_links`、`memory_batches`、`memory_ops`（记忆日志就是它）、`memory_pending`（等用户的改动）。旧表留着只读。
- **守门**（`MemoryStore.commit`）：一批操作一个事务；逐项查作用域、版本（记忆 Agent 必须带版本）、例外——锁定的只有用户能改（Agent 的修改变成待确认，条目标「待复核」）、工作区提升为全局要用户、只有用户能锁定；「写入前要我确认」打开时按 memory-design 第四节的表；不合格的项拒绝并写原因，其余照常提交。
- **记忆日志**：`memory.log`（按本地日期分组，最新在前，每条带改前改后、改了哪些字段、谁、原因、是不是推测、来自哪个会话、能不能撤销）；`memory.undo`（单条）、`memory.undoBatch`（整批，之后被改过的条目不覆盖、列为冲突）。撤销本身也是一个新版本。
- 新接口：`memory.items`、`memory.item`、`memory.save`、`memory.update`、`memory.setStatus`、`memory.log`、`memory.undo`、`memory.undoBatch`、`memory.pending`、`memory.acceptPending`、`memory.rejectPending`、`memory.workspaces`、`memory.setWorkspaceBackground`、`memory.migrationReport`。**旧接口**（`memory.list`、`add`、`edit`、`remove`、`history`、`accept`、`reject`、`blocks`、`setBlock`、`clear`、`export`）暂时接在新库上，窗口的记忆页不用改就能用；第 8 步做最简界面时换掉。
- 新设置 `memoryConfirmWrites`（默认关）。
- 这一步 Claude 自己定的（memory-design 没写死的地方，有异议再改）：
  - 新条目的层级：用户在界面加的默认二级；主 Agent 照用户的话存的偏好 / 背景 / 约定 / 决定 / Agent 设定进二级，用户说「长期记住」进三级，其余和推测的进一级；对话后提取的都进一级。
  - 「关于 Agent 的设定」单独一类 `persona`（第十五节第 2 条），快照里单独一节「用户给你（Agent）的设定」。
  - 定时任务（没人看着的运行）里 Agent 存的记忆一律等用户确认，不自动生效（沿用 v0.2 的安全规则）。
  - 主 Agent 不带 explicit 的「忘记」只标「待复核」，带 explicit（用户要求）才软遗忘。
  - 「待复核」的条目仍进快照，带「待核对」标记、排在最后（第六节 6.2）。
  - 去掉了 `memory_block_edit` 工具（常驻块变成了 `pinned` 条目，`memory_save` 加了 `pinned`、`long_term`、`valid_until`）。
  - `session_search` 只搜本工作区（蝶君只搜蝶君的），第八节。
  - 迁移沿用旧 id，中途崩了再跑一次不会重复；迁移整批可以从记忆日志撤销。
- 测试：`core/test/memory-store.test.ts`（14 个，假时钟）、`core/test/memory.test.ts`（重写，12 个，含迁移）；`backup.test.ts` 改查新表。守门的 5 条关键规则逐条去掉确认测试会失败。后台全部 217 个通过，`tsc` 无错（2026-11-06）。窗口没改，还没跑窗口测试。
- 快照（第 2 步要重做）和提取（第 3 步交给记忆 Agent）暂时是在新库上的过渡版本。
- 已提交：`1db3b43`。

### 第 2 步：快照组装改造（2026-11-06，**未提交**）

- `core/src/memory/snapshot.ts`：预算 = min(用户上限, 窗口 × 3%, (窗口 − 已有内容 − 模型最大输出 − 8000) × 15%)；份额常驻 15% / 相关 70% / 查找 15%；相关部分按层级 40 / 35 / 25 软分配（某层用不完给别层）；估算留 10% 余量；常驻超过份额全部保留并标 `pinnedOver`（以后界面提示精简）；「待复核」排最后；和任务无关的不放（偏好、约定、Agent 设定、决定除外）。预算默认值改成 2000。
- 中文相关度：原来只按三个字一组比较，「周报」这种两个字的词对不上；加了相邻两个汉字的比较（`text.ts` 的 `taskRelevance`）。
- `memory_snapshots` 加列（第 9 个迁移里）：快照 id、任务的第一句话、预算、用量、条目版本、没放进去的条目和原因、状态（ok / degraded / failed）、生成原因（task_start / refresh / correction / compaction）、常驻超额。
- 记忆模块的 `context` 钩子（每次调用模型前）：只发最新的一份快照（会话文件里旧的还在）；**用户**改过、撤销、软遗忘了快照里的条目，就在下一次调用模型前换上——只换用户动过的那几条，其余条目和选择照旧（Agent 和后台的改动等下一个任务，一次运行里保持稳定）；关闭记忆或无痕时把快照拿掉；压缩之后把当前快照补回到摘要后面（运行中途的压缩也补）。
- 压缩防复活：harness 的 `session_before_compact` 把记忆快照从要总结的内容里去掉，并在压缩说明里加一句不要把记忆写进摘要（`MEMORY_SUMMARY_NOTE`）；压缩完成后扫一遍摘要，出现了用户已撤掉的条目原文就记日志并发 `memory.warning` 事件。
- 组装失败不再默默跳过：会话收到「记忆未能加载」的提示，快照记录标 `failed`，不拿旧快照充数。
- `memory_search` 的结果限在预算的「查找」份额里，超出时只列最相关的几条和「还有 N 条」。
- 新接口：`memory.snapshotInfo`（会话当前用的快照）、`memory.whyNot`（某条记忆为什么没进快照：irrelevant / budget / forgotten / ended / out_of_scope / newer_than_snapshot / snapshot_failed …，17.8 的数据部分）。`memory.snapshots` 多返回了上面那些字段。
- 还没做：快照素材 `memory_materials` 和「快照准备」任务（要记忆 Agent，放到第 3 步）；`degraded` 状态要等素材有了才会出现；token 估算还没用模型实际计数回校。
- 测试：`core/test/memory-snapshot.test.ts`（13 个）。6 处关键处理逐条去掉都确认测试会失败。后台全部 230 个通过（`slots.test.ts` 里默认预算改成 2000），`tsc` 无错。窗口没改。

## 0.4 收尾记录（2026-11-05 / 06）

- **2026-11-06：用户交了 0.4.0 的测试报告**（`C:\Users\21669\Desktop\毕设、agent学习笔记库资料库\DreamFlutter\dfv0.4.0 测试记录.md`，11 条，截图在同目录 `Pasted image 20261105*.png`）。大多是方向性意见，**最重要的是第 6 条：改成后端优先、前端只做必要的，后端做完写接口文档再设计前端**。Claude 逐条对照代码给出理解和计划调整草案，用户确认了（第 3 条是侧边对话：保存、挂在原对话下、能打开；不进记忆、搜索、任务，**算进统计**；搜索方案先调研再定），计划修订写进 roadmap.md。用户说「0.4.0 现在提交、打 tag」：修复提交 `eb8c9d6`，版本号和发布说明一个提交，annotated tag `v0.4.0` 打在它上面，**都没推送**。

- **0.4 已做完**：4.2 窗口框架、4.3 详情分块、4.4 过程折叠、4.5 回复下方信息、4.6 输入框模式（含无痕）、4.7 选中文字回复（含侧边对话）、首页蝴蝶 + 问候语、4.8 沙箱镜像、4.9 长任务设计文档。**4.1 品牌也做完了**（见下一条）。
- **设计资料都在 [design/](design/)**：[design/README.md](design/README.md)（索引）、[design/design-language.md](design/design-language.md)（0.4 界面设计语言）、[design/brand.md](design/brand.md)（品牌：已定的事、用户原话、下一步）；设计稿源文件在 `design/canvases/`，图标原图和截图在 `design/assets/`。
- **品牌已定（用户 2026-11-05）**：图标 = 用户的橙色蝴蝶；要做 **1:1 完整完美复刻的矢量版**（方便二创和组合，不改造型）——**已做**：[design/assets/butterfly.svg](design/assets/butterfly.svg)，由 `scripts/brand/trace_butterfly.py` 从原图描出（平均像素差 0.96 / 255，黑线重合 98.2%，分层、可换色，做法和精度见 brand.md 第二节第 1 步；之前的近似重画草稿已删）；**图标填充色、界面 / UI 颜色都随名画主题变；深色场景轮廓黑线变白线**；「工作台」「蝶君」名字不变。**配色用户同意了**（[design/assets/butterfly-theme-preview.png](design/assets/butterfly-theme-preview.png)，深色主题翅心用深色），已做完 brand.md 第二节第 2–4 步：`theme.dart` 的 `ButterflyColors`（每个主题 `AppColors.butterfly`）、`ButterflyMark` / `ButterflyGlyph` 用矢量路径（`app/lib/butterfly_art.dart`，由 `scripts/brand/export_butterfly.py` 生成）、exe 和托盘 ico 换成新图标（小尺寸线条加粗到 1 像素）。还没定的只有「梦蝶」朱印 / 组合标志要不要（brand.md 第二节第 5 步，不挡发布）。
- **提交**（都在 `main`，**都没推送**）：`aba5e45`（4.8、4.9）、`79d853b`（4.2）、`cbe3fb8`（4.3–4.5）、`99903f2`（4.6）、`7583865`（4.7）、`4152935`（首页）。`22a8451`（设计资料和交接）、`2a35ef3`（品牌 4.1，用户说「提交，继续做」）。`eb8c9d6`（全场景测试和安装包试用中修的：侧边对话后台会话收尾、启动等待、顶栏按钮、端到端脚本），之后是版本号 0.4.0 和 [v0.4-release-notes.md](v0.4-release-notes.md) 的提交（tag `v0.4.0`）。推送前要用户点头（命令见下面「推送」）。
- **全场景测试（2026-11-05 晚，按 scenarios.md）**：窗口 126、协议层 43、后台 200 + tsc、场景巡检 5、卡片、视觉检查、**真实模型端到端全过（2 分 23 秒）**。端到端脚本补了两处旧名字（「新会话」→「新建对话」、「工作区 · 」→ 顶栏工作区按钮），并新增 1b **侧边对话**（真实模型一问一答、主对话和会话文件不变、带回、结束）。它撞出一个真 bug：侧边对话「结束」后后台会话还开着，窗口重开会被接成没名字的对话 → 修了（`_endSideChat` 关闭 slot、后台会话信息加 `forkOf`、`_attachLiveSlots` 跳过），回归测试确认去掉修复会失败。dev-guide 一.9、三节加了对应的坑。
- **用户问「记忆入口在哪」**：在侧栏底部图标（灯泡），只有图标所以没注意到。问了要不要升到上面做成文字行，**用户选了「先不改」**，发布说明里写清了入口位置。以后改版时可以再提。
- **版本号已改 0.4.0**（`app/lib/main.dart`、`app/pubspec.yaml` 0.4.0+9、`core/package.json` 和 lock 的前两处、`core/src/core.ts`、`core/test/server.test.ts`、`packages/pi_rpc/test/core_test.dart`）。安装包打到 `dist\DreamFlutter`。
- **下一步（2026-11-06 起，后端优先）**：`v0.4.0` 已打 tag，**`main` 和 tag 都没推送**（推送要用户点头）。计划已按 0.4.0 报告修订（roadmap.md 2026-11-06、[roadmap-review-2026-11-06.md](roadmap-review-2026-11-06.md)）：0.5 开工先做 5.0a——调研 Hermes 的记忆机制（广泛调研按约定交给 Antigravity）、强化遗忘机制设计并和用户定稿，然后才写 0.5 的代码。0.5–0.9 只做必要的界面（见 roadmap 第一节第 6 条）。
- **5.0a 已完成（2026-11-06）**：计划修订已提交 `92a60c1`。Hermes 调研 [research/hermes-memory.md](research/hermes-memory.md)（本机 Hermes 0.21.0 源码和 GitHub 2026-11-05 主干，一手资料）；遗忘补强 memory-design 第十七节；用户把 17.10 的 6 问、第十二节 12 项、第四节例外、第五节隔离、第七节预算和模型**全部定稿**。**新决定：记忆默认自动生效**（不逐条审批），按天的记忆日志可看、可改、可删、可撤销；例外：锁定的不自动改、彻底删除只能用户做、工作区提升为全局要用户决定。**下一步：0.5 写代码**，按 memory-design 第十四节的顺序（先新表、迁移、范围函数、操作接口和日志，不接 Agent）。这批文档已提交 `5ea3cef`。
- 待用户定：[long-task-design.md](long-task-design.md) 第十八节 11 个待定项（0.8 前定就行）。

**0.4 进度明细（2026-11-05）**：提交 `299a586`（计划修订 + 忽略 `packages/*/build/`），`main` 和 `v0.3.4` 已推送。
- **4.8 沙箱镜像**：**用户定了只装编译器、Node、文字识别**（「平台不能太重，以后需要再补，留好空位」）：`IMAGE_PACKAGES` 加 `build-essential nodejs npm tesseract-ocr tesseract-ocr-chi-sim`；ffmpeg 和 `chromium-headless-shell` 记在 `ON_DEMAND_PACKAGES`（以后做应用代装）；`CHECK_SCRIPT` 和 `live-sandbox.ts` 加了这几样的检查。正式镜像按这个重新构建（结果见下一条之后补的「正式镜像」）。之前的记录：`build-sandbox-image.ts` 加了 `--out <file.tar.gz>`（试构建不覆盖正式镜像）。试构建（2026-11-05，Debian 官方源，1279 秒）：压缩包 **282 MB → 788 MB（+506 MB）**，包 240 → 866；`core/sandbox-image/` 里还是旧镜像，试构建的在会话临时目录（不留）。逐组估算（解压后、`--no-install-recommends`，有共用依赖）：编译器 271 MB、Node + npm 210 MB、ffmpeg 400 MB、OCR + 中文 67 MB、chromium 698 MB / `chromium-headless-shell` 517 MB；全装合计约 1.4 GB；不含 ffmpeg 和 Chromium 约 512 MB。大头是 chromium 和 ffmpeg 共用的 libllvm19 + mesa + libz3（约 190 MB）。定了之后：重新构建正式镜像、`live-sandbox.ts` 加这几样工具的检查、重打安装包。
- **4.9**：[long-task-design.md](long-task-design.md) 写好（目标表 + 在 tasks / runs 上扩展、状态机、唯一调度者和租约、三层验收、进展指纹、预算账本、等待、四种停止、和 0.5 / 0.9 的接口、给 0.4 右栏的数据、11 个待定项的建议值），待用户定待定项。
- **4.2–4.3 设计稿**：画布 https://claude.ai/artifact/NYpoVANRPEKZPmMgkhKYuS（三个方案：一「一栏到底」单侧栏 + 分块右栏；二「导航条 + 标签」图标导航条 + 会话栏 + 标签式右栏；三「专注」右栏按需滑出、目标和计划固定在输入框上方。都用现在的蛱蝶配色，有深色开关；源文件在会话临时目录，改的话先从画布读回）。**用户 2026-11-05 选定方案三 + 方案一的顶栏**，删了方案二；已按要求改好：顶栏换成方案一的（标志、名字、「工作台 / 工作区 / 会话标题」、分支、详情开关、窗口按钮），工作区是一个明确的下拉按钮（列出每个工作区的路径、对话数、在运行的；查找、打开文件夹、管理工作区；Ctrl O），侧栏顶部写「毕设论文的对话」并有切换按钮，输入框补回上下文用量圆环。下一步：品牌（4.1）和按这个框架开始改界面。
- **正式镜像**（2026-11-05）：451 MB（原 282），667 个包，构建 546 秒；`live-sandbox.ts` 全部通过（建沙箱 12 秒、自检 11 项、编译运行 C、Node、npm、中文 OCR、联网 / 离线 / 重置）。
- **4.2 窗口框架第一步已做（未提交）**：新文件 `ui/window_frame.dart`：`AppTitleBar`（替代删掉的 `title_strip.dart`，放在 `MaterialApp.builder` 里、`Overlay.wrap` 包着；标志 + 名字 + 「工作台 / 工作区下拉 / 会话标题」，蝶君页「蝶君 / 标题」，任务 / 记忆 / 技能页显示页名；详情开关；真窗口才有拖动和窗口按钮，测试里没有）、`workspaceMenu`（`MenuAnchor`，Ctrl O、侧栏切换按钮共用，Esc 关）、`ResizeHandle`。`Sidebar` 重写成全窗口共用（`home_page.dart` 去掉了图标导航条 `_NavRail`）：工作台 / 蝶君切换、新建对话（旁边临时对话）、搜索（点了才出搜索框）、任务（待处理数）；「某工作区 的对话」列表（蝶君页列蝶君的会话，`butterfly_page.dart` 的 `_Talk` 不再自带侧栏）；底部记忆、技能、仪表盘、外观、设置图标；右边缘拖宽（`sidebarWidth`，232–420）。对话页去掉了自己的顶栏 `_TopBar`；右栏改成「详情」：**默认关着**（新偏好键 `detailsOpen`，旧的 `runPanelOpen` 不沿用），宽窗口停在对话旁边、窄窗口（对话剩不到 640）盖在对话上带阴影，左边缘拖宽（`panelWidth`，280–560）；原「⋯」菜单变成详情里的「常用操作」按钮（`chat_view.dart` 的 `SessionActions`）。测试：窗口 106（新增 `test/window_frame_test.dart` 4 个，连跑 3 遍稳定）、场景巡检 5、视觉检查（新增 `01b_details_light`）都过；`flutter analyze` 干净；集成测试的 `nav()` 改成在侧栏里找。**还没做**：设计稿里顶栏的「分支」按钮（分支还在详情的「分支」标签里）、工作区下拉里每个工作区的对话数和「在运行」、详情按设计稿分块（目标、进度、产物…，4.3）、过程折叠（4.4）、悬停显示的信息行（4.5）、输入框里的模式（4.6）、选中文字回复（4.7）、首页蝴蝶 + 问候语、品牌（4.1）。
- **已提交**（用户说「提交，继续做」）：`aba5e45`（4.8、4.9）、`79d853b`（4.2 框架），未推送。
- **4.3–4.5 已做（未提交）**：详情「概览」分块（`run_summary.dart` 的 `_sections` / `_Section` / `_ContextGauge`：进度、步骤只显示最近 5 步可展开、产物与改动（运行中取本次回复的 edit / write）、子 Agent 与后台、上下文与花费（圆环 + 会话花费 + 上次耗时花费）、常用操作；折叠状态在窗口生命期内记住；标签「本次运行」改名「概览」）。过程块（`message_widgets.dart` 的 `WorkBlock`）运行中也折叠，露出最近三步（`_OneLineStep`）；命令（`_TerminalStep`）改成一行、点开才是终端，出错自动展开，终端白天用 `codeBackground`、夜里用 `terminal`；工具图标和动词统一在 `toolIconVerb`（MCP `mcp__服务__工具` 显示「MCP · 服务 · 工具」）；工具返回的图片和用户消息里的图片都是 `ImageThumb`（`common.dart`，点开 `showImagePreview` 可缩放）。回复下方：信息和按钮一行、只在鼠标移上去或键盘焦点时显示（最新一条也一样），信息只留 `replyFactsShort`（模型 · 耗时 · 花费），完整的在悬停提示；按钮 18 号图标、36×34。测试：窗口 113（新增 `work_block_test.dart` 6 个，`window_frame_test` 加分块测试，`chat_and_zoom_test` 加悬停，`message_view_test` 加短信息）、场景巡检 5、视觉检查都过（`look_test` 现在点开终端再截 02 / 03）；e2e 按新界面改了（打开详情找分支和「存为模板」、侧栏「搜索」打开搜索框），没跑（要真实模型）。
- 4.3–4.5 已提交 `cbe3fb8`（用户「提交，继续做」），未推送。
- **4.6 已做（未提交）**：输入框的模式选择（`composer.dart` 的 `_ModeChip`）加了「无痕」（`composerModeNames` / `composerModeHints`；设置里的默认模式仍只用 `agentModeNames` 两项）。无痕 = 原来的临时对话，现在一律极简模式（`newTemporarySession` 带 `agentMode: 'minimal'`）；从无痕选标准或极简会新开一个保存的会话（`selectAgentMode` 不再因模式相同而跳过无痕）。界面上「临时对话」全部改叫「无痕对话」（侧栏眼睛按钮、横幅、记忆页说明、顶栏详情按钮提示）。测试：窗口 115（`window_frame_test`、`agent_controller_test` 各加 1），场景巡检过；e2e 第 13 步的文字跟着改了，没跑。
- 4.6 已提交 `99903f2`（未推送）。
- **4.7 选中文字回复已做（未提交）**：
  - 后台：`slot.open` 新参数 `forkOf`（只和 `incognito` 一起用；`core.ts` 的 `OpenSlotOptions` / 目标、`pi/host.ts` 的 `OpenTarget`）：`SessionManager.inMemory(cwd, { parentSession }, SessionManager.open(forkOf).getBranch())`，新 id、源文件只读；文件不存在报 not_found。测试 `slots.test.ts`「opens a side conversation」。
  - 协议层：`SessionTarget.forkOf`，`slot.open` 带上。`SessionRuntime.forkOf`、`editorAppend`（输入框把文字接在已有内容后面）。
  - 窗口：`state/side_chat.dart`（`SideChat`：引用、独立的 SessionRuntime、`baseline` 之后才是侧边对话的内容、第一问带「关于主对话里的这段内容：」+ 引用）；`AgentController.quoteInComposer`、`openSideChat` / `closeSideChat` / `bringBackSideChat`、`canOpenSideChat`（无痕不行）；侧边会话不进 `_runtimes`，也不通知主控制器（流式不重建主对话）。`chat_view.dart` 的 `_MessageListState`：`SelectionArea.onSelectionChanged` 记选中文字，左键松开处浮出 `_SelectionBox`（回复 / 侧边对话），滚动、按下即收；右键菜单加同样两项。`ui/side_chat_view.dart`：详情里新标签「侧边对话」（新开时自动切过去）：引用、问答（问题去掉引用前缀、回答 = 折叠的过程块 + Markdown）、「带回主对话」「结束」、输入框（Enter 发送 / 停止）。
  - 测试：窗口 118（`side_chat_test.dart` 3 个）、协议层 43、后台 200、场景巡检 5。**真实模型下没试过侧边对话**。
- 4.7 已提交 `7583865`（未推送）。
- **首页已做（未提交）**：`chat_view.dart` 的 `_EmptyState` 只剩蝴蝶（132）和一句问候语（宋体 32、字距 6、墨色 → 主色 → 赭石渐变的 `ShaderMask`）；问候语在 `ui/greetings.dart`（清晨 / 上午 / 午后 / 傍晚 / 深夜各 4 句、通用 10 句、蝶君 6 句，`pickGreeting` 用会话的 identityHashCode ^ 日期当种子，同一会话不变）；说明文字、三张建议卡片、底部工作区按钮都去掉了；「开始之前」引导第三步的文字改成在输入框里说。测试：`greetings_test.dart` 4 个，`window_frame_test` 加 1；窗口 123，视觉检查过。
- 首页已提交 `4152935`（未推送）。
- **4.1 品牌（进行中，以 [design/brand.md](design/brand.md) 为准）**：图标用用户的橙色蝴蝶（原图已复制到 `docs/design/assets/butterfly-icon-original.png`）。过程：我先做了近似的矢量重绘 → 用户「请完美复刻好嘛，不要做更改了」→ 我改成画布里全用原图位图 → 用户澄清「矢量版是请 1:1 完整完美复刻，方便二创和后续组合设计，不是说用原图」，并定了「图标填充色、界面和 UI 颜色随名画主题变，深色场景轮廓黑线变白线」。品牌画布 https://claude.ai/artifact/XYxoNwpu9p5mu2zWbVy5xv 的两套方案（「印」「蝶橙」）只作参考，用户的最后决定见 brand.md 第一节。
- 用户问过测试窗口里的「Claude Opus 4.8」：是假后台回放的录音 `runtime/fixtures/rpc-session-prompt.jsonl`（v0.1.0 录的，Pi 自带模型清单里的默认项），真正回话的是 DeepSeek；测试不调用任何模型。

**v0.3.4（2026-11-04）**：按用户的 `C:\Users\21669\Desktop\毕设、agent学习笔记库资料库\DreamFlutter\dfv0.3.3测试记录.md`（截图在同目录 `Pasted image 2026110415*.png`），详见 [v0.3.4-release-notes.md](v0.3.4-release-notes.md)。
- 修了：行内代码 / 文件名选中不显示高亮（**v0.3.3 的修复没生效**：flutter_markdown_plus 把自带的默认样式合并进来，默认 `code` 有底色，要明写 `Colors.transparent`）；文件名链接断行（改成 `Text.rich(WidgetSpan(FileLink))`，去掉 Tooltip，悬停铺底色）；「往上弹」「不明的刷新」：在测试里贴底时一直正确，问题出在用户往上看时——`chat_view.dart` 的 `_AnchoredRow`（阅读锚定：视口上方的行变高变矮，偏移跟着补）、`CardStage.info / height`（卡片重新搭建时不再先显示「正在打开…」）、`_seen`（只有新行播入场动画）、`SessionRuntime.sends`（发消息回到底部）。排队消息插入那一刻在真实应用里到底是哪个原因，没能在测试里复现，要用户再试。
- 测试：窗口 102、后台 199 + tsc、协议层 43、场景巡检 5、视觉检查（示例回复加了文件名）、卡片。新测试都确认过去掉修复会失败（`chat_scroll_test` 的排队插入那条修之前就能过，是防护）。**e2e**：步骤全部走通，但三次都被「踩过的坑」最后一条的语义树错误判失败；把 `app/lib` 换回 v0.3.3 对照跑也一样，所以不是本版引起的（v0.3.3 那次没出现，时有时无）。
- 安装包已打：`dist\DreamFlutter`（0.3.4）。
- **状态**：用户说「直接提交」：提交 `ef5e4fe`（修复）、`85eeac5`（版本号和发布说明），annotated tag `v0.3.4` → `85eeac5`，2026-11-05 和计划修订一起推送。`packages/pi_rpc/build/` 是跑测试留下的，不要提交。
- **计划修订（2026-11-04，待用户确认）**：读了用户的 5 份报告（现在在 `C:\Users\21669\Desktop\毕设、agent学习笔记库资料库\DreamFlutter\档案馆\Codex\`；01 备份已在 v0.3.1 做完）和蝶君体检报告，修订了 [roadmap.md](roadmap.md)（第二节「跨版本的共同原则」，0.4 加 4.8 沙箱镜像、4.9 长任务内核开发设计；0.5 改「记忆与上下文」加任务边界和后台压缩；0.8 改「长任务与目标」；新 0.9「蝶君自主与成长」；深度测试顺延 0.10），讨论稿 [roadmap-review-2026-11-04.md](roadmap-review-2026-11-04.md)；报告 02 已合并进 [memory-design.md](memory-design.md) 第十六节。核对过：Pi 1.4 的 `session_before_compact` 能交出现成摘要、`prepareCompaction` 可提前算切点（后台压缩不用改 Pi）；后台 `tasks` 表已有 goal/status/runs/cost（目标服务在它上面扩展）。**用户 2026-11-05 确认，开始 0.4**。

**v0.3.3（2026-11-04）**：按用户的 `C:\Users\21669\Desktop\毕设、agent学习笔记库资料库\DreamFlutter\dfv0.3.2测试记录.md`（截图在同目录）做的，详见 [v0.3.3-release-notes.md](v0.3.3-release-notes.md)。
- 修了：生成时滚轮被拉回底部（`chat_view.dart` 的 `_BottomAnchoredController`，阈值 80 → 2，加「回到底部」按钮）；缩放下拖选错位（Flutter 滚动列表选区的 bug，对话列表绕开，见 dev-guide 一.2）；拖放串到隐藏页面（`showsOnScreen`）；生成时图片闪（`memoryImageOf`）；Ctrl 卡住（`ui/keys.dart` 的 `HeldKeys`）；气泡里 Pi 的图片说明；记忆去重和「用户叫蝶君」（`memory.ts` 的 `nearDuplicate` / `saysMore`、提取提示词，只是止血）；v0.3.1 剩下的行内代码高亮、备份页、仪表盘表头；场景巡检发现的 150% 缩放导航栏溢出。
- Python 乱码（v0.3.1 第 7 条）用用户的 venv 实测复现不了，写进发布说明请用户再遇到时把命令发来。
- 新增：`integration_test/scenarios_test.dart`（场景巡检）、`app/test/chat_reading_test.dart`、`docs/testing/scenarios.md`、`docs/dev-guide.md`，`memory-design.md` 第十五节（用户对记忆的意见，0.5 要逐条解决）。
- **状态**：用户 2026-11-04 在安装包上试过说「没啥问题了」，让打 tag 发布：提交 `283c0e7`（修复）、`d2cdce6`（版本号和发布说明），annotated tag `v0.3.3` → `d2cdce6`，`main` 和 tag 已推送。安装包在 `dist\DreamFlutter`；用户用的是 `E:\DreamFlutter测试版`（数据在它的 `data\`，桌面快捷方式名字还是 v0.3.2），升级靠用户自己用 robocopy 覆盖 app、core、runtime、licenses 四个文件夹（Claude 替换那个文件夹被权限拦下）。
- **下一步**：用户在做深度测试，等报告（一般放在 `C:\Users\21669\Desktop\毕设、agent学习笔记库资料库\DreamFlutter\`），先修报告里的问题（每个修复带回归测试，发布前走 scenarios.md）；然后看用户的另外 4 份报告（三级记忆、DSH 与蝶君、Goal、后台压缩，在 `…\2026-11-02 13-01 Codex-五项平台能力调研与设计\`），再开 0.4。

**用户的测试版在哪、怎么升级**：用户用 `E:\DreamFlutter测试版`（桌面快捷方式「dreamflutter v0.3.2」指向它，名字没改），数据在它的 `data\`。发新版本 = `scripts\package-windows.ps1` 打到 `dist\DreamFlutter` → 请用户先从托盘「退出并停止后台」→ 给用户下面这段命令自己运行（Claude 直接删改那个文件夹会被权限拦下）：

```powershell
$src = "E:\claude\DreamFlutter\dist\DreamFlutter"; $dst = "E:\DreamFlutter测试版"
foreach ($d in "app","core","runtime","licenses") { robocopy "$src\$d" "$dst\$d" /MIR /NFL /NDL /NJH /NJS /NP | Out-Null }
Copy-Item "$src\使用说明.txt" $dst -Force
Get-Content "$dst\使用说明.txt" -TotalCount 1
```

**推送**（用户点头后）：`$env:GCM_INTERACTIVE="never"; git -c credential.helper= -c credential.helper=manager push origin main <tag>`（PowerShell；本机 git 的凭据助手是个图形选择窗口，会卡住。PowerShell 5.1 会把 git 的正常输出显示成红色错误，看有没有 `main -> main` 就行）。

**v0.3.3 测试**（2026-11-04，全部通过）：后台 199 + `tsc`；窗口 95 + `flutter analyze`；协议层 39；场景巡检 5（真窗口）；视觉检查（顺手修了脚本：窗口低时先 `ensureVisible` 再点「过程」行）；卡片；**真实模型端到端 3 分 27 秒全过**（这次语义树错误没再让它失败）。每个修复都确认过「去掉修复测试就失败」。安装包打好后用户自己试过（截图工具卡 Ctrl、真实拖放、行内代码高亮这些手动项由用户验收）。

以下是 v0.3.2 及以前的记录。

**现状**：v0.2.0 已发布（annotated tag `v0.2.0` → `001d03c`）。**仓库已在 GitHub 公开：https://github.com/jun64349/DreamFlutter**（2026-11-02 推了 `main` 和 v0.1.0、v0.1.1、v0.2.0 三个 tag，`main` 跟踪 `origin/main`；本机已存 GitHub 凭据，推送没弹登录）。2026-11-02 和用户讨论后**重排了 v0.3–v1.0 计划**（[roadmap.md](roadmap.md)，用户已确认）：书桌升级为在 WSL2 沙箱里独立工作的「蝶君」，对话改名「工作台」；0.3 = 修复批 + 执行环境 + Agent 运行时与子 Agent + WSL 沙箱 + 蝶君骨架 + 记忆开发设计。

**v0.3 进度**：
- 完成并提交：3.0 修复批、3.1 三份调研、3.4 子 Agent、3.2 执行环境 + 3.3 WSL 沙箱。WSL 已装好（3.0.3）。
- 2026-11-02 第二个窗口（都已提交：`a7f982e`、`2546ef1` 和最后一个提交）：修好在线时沙箱上不了网；3.5 蝶君骨架（按用户试用意见改过）；沙箱改用 Debian 13 并随应用附带镜像（建沙箱 8 秒）；3.6 工作区运行环境（自带 uv 和便携 Python、每个工作区的 `.dreamflutter\`）；3.7 记忆开发设计 [memory-design.md](memory-design.md)（0.4 期间和用户逐项定稿，第十二节是 12 个待定项的建议值）。**用户说做完就可以提交**；**推送：用户 2026-11-02 定了等 v0.3.1 全部做好再一起推**（v0.3.0 的 tag 也到那时一起推）。
- **2026-11-03 窗口**：
  1. **v0.3.0**：版本号、[v0.3-release-notes.md](v0.3-release-notes.md) 单独一个提交 `afd6ef2`（tag 打在它上面）。测试：后台 188、窗口 83、look、cards 全过；e2e 36 步全部走通，但测试被判失败，原因是一开始就冒出的 Flutter 自己的语义树错误（见「踩过的坑」最后一条），没修。
  2. **v0.3.1 备份、迁移与恢复**：做完并提交，版本号已改 0.3.1，见下面「v0.3.1 备份、迁移与恢复」一节和 [v0.3.1-release-notes.md](v0.3.1-release-notes.md)。安装包按 v0.3.1 打（`dist\DreamFlutter-0.3.1\`，第一次带上沙箱镜像、uv、Python）。
  3. （用户 2026-11-03 同意）annotated tag `v0.3.0` → `afd6ef2`、`v0.3.1` → `1b4e950`，`main` 和两个 tag 已推送。推送要绕开 git 的凭据选择窗口，命令见本节开头「推送」。
  4. **v0.3.1 实测反馈**（用户的 `C:\Users\21669\Desktop\毕设、agent学习笔记库资料库\DreamFlutter\2026\2026-11\2026-11-03\User\dfv0.3.1测试记录.md`，10 条 + 截图）的去向：
     - 第 4 条（数据集中、不放 C 盘、和别的 Agent 平台隔离）：用户定了**提前到 v0.3.2**、默认放**软件目录旁边的 data 文件夹** → 已做，见下面「v0.3.2 数据集中」一节。
     - 第 1 条提示条（配色反了、太宽、没居中、想放上面、字小点）→ v0.3.2 已改。第 9 条「⋯」菜单错位（界面缩放时坐标没换算）→ v0.3.2 已修。
     - **v0.3.3 已做（Python 乱码复现不了）**：第 3 条选中文字时行内代码段不显示高亮（`markdown_view.dart` 的行内代码用 `backgroundColor`，疑似盖住了选中色；复制正常）；第 8 条备份页太复杂（改成一行说明 + 导出 / 导入两个主按钮，选项折叠）；第 10 条仪表盘表格没有表头（先补表头，重做在 0.6 的 6.5）；第 7 条截图里 Python 报错是乱码（`toolchainEnv` 已设 `PYTHONUTF8` 和 `PYTHONIOENCODING`，但用户用自己 venv 的 python 时仍乱码，要用真实 pwsh 工具复现：中文路径 + 中文 assert 信息）。
     - 已在计划里：第 7 条过程默认折叠（0.4 的 4.4）、第 5 条首页只留蝴蝶 + 随机问候语（艺术字，0.4 设计稿）、第 6 条自动刷新记忆快照（0.5；已回答用户：快照放在对话前部，换掉它后面的缓存都失效，所以只在本来就要重算的时机刷新——新任务、压缩后）。第 2、11 条没有具体问题。
- **下一步**：
  1. **v0.3.2 已打 tag 并推送**（用户 2026-11-03 说直接推、后面再试；annotated tag `v0.3.2` → `d2f5a36`，含全仓库审查的修复）。安装包按审查后的代码重新打过；建议用户复制到 `E:\DreamFlutterApp`（`E:\DreamFlutter` 是用户别的资料）并建桌面快捷方式，用户还没试：第一次启动会自动搬数据，后台重启一次；**搬家的真实运行结果要等用户反馈**。
  2. ~~做上面「还没做」的四条~~（v0.3.3 已做）；然后看用户的另外 4 份报告，再开 0.4。
- 要用户在真实应用里试的：拖图片、子 Agent、蝶君整条流程、工作台的 uv / Python；**备份**：设置 › 数据与迁移 › 备份与恢复，导出一份（试试带 Key）、再导入它（会先自动备份、后台重启）、看「上次恢复」、撤销；有条件的话在另一台电脑或另一个 Windows 用户下导入。用户试用要**自己双击**（不要从 Claude 的终端启动，见约定）：用户实际用的是复制出去的 `E:\DreamFlutter测试版`（见本节开头）；开发版 `app\build\windows\x64\runner\Debug\dreamflutter.exe` 的数据在仓库根目录 `data\`，两者不共用。改了后台要先从托盘「退出并停止后台」。

**先读这些**：

| 文档 | 内容 |
|---|---|
| [dev-guide.md](dev-guide.md) | **开发规范与踩坑**（v0.3.3 起新坑写这里） |
| [design/](design/README.md) | **设计资料**：0.4 界面设计语言、品牌（已定的事和下一步）、设计稿源文件、图标原图、截图 |
| [long-task-design.md](long-task-design.md) | 长任务内核开发设计（0.8 照此实现；第十八节待用户定） |
| [testing/scenarios.md](testing/scenarios.md) | **全场景测试清单**：怎么跑每层测试、每个场景由谁覆盖、发布前的手动清单 |
| [v0.4-release-notes.md](v0.4-release-notes.md) | 最新版本（0.4.0）做了什么 |
| [memory-design.md](memory-design.md) | **0.5 的开发设计（2026-11-06 定稿）** |
| [roadmap.md](roadmap.md) | v0.3–v1.0 计划（第二节是已定的事）、v0.2.0 已有能力对照表、35 条 + 额外 12 条反馈的去向、要用户定的事 |
| [roadmap-review-2026-11-02.md](roadmap-review-2026-11-02.md) | 重排时的讨论稿：对 Gemini 隔离方案的核查（为什么不给 root）、额外测试的核查、Agent 运行时的想法 |
| 用户的新材料（`C:\Users\21669\Desktop\毕设、agent学习笔记库资料库\DreamFlutter\2026-11-01\`） | `2026-11-01 df测试记录（额外）.md`、`2026-11-01 DreamFlutter-三级记忆管理系统-调研与讨论纪要-2026-11-01.md`（0.5 的依据）、`2026-11-01 v0.3补充：对话、书桌两板块的设计文档与调研报告.md`（蝶君和沙箱方案） |
| [v0.2-release-notes.md](v0.2-release-notes.md) | v0.2 做了什么、已知限制 |
| [architecture.md](architecture.md) | 整体架构 |
| 本文件「架构」「怎么运行应用」「怎么跑测试」「踩过的坑」几节 | 日常开发要用的 |
| [agent-modes.md](agent-modes.md)、[v0.2-gateway.md](v0.2-gateway.md)、[v0.2-multimodal.md](v0.2-multimodal.md)、[v0.2-design.md](v0.2-design.md) | Agent 模式、模型网关、卡片与多模态、视觉设计的细节 |
| 用户的深度测试记录 `C:\Users\21669\Desktop\毕设、agent学习笔记库资料库\DreamFlutter\2026-11-01\2026-11-01 df测试记录.md` | 35 条原文和截图（截图在同目录 `Pasted image 20261101*.png`） |

**和用户合作的约定**：
- 用户不是开发者：说话用平实的中文；需要用户运行的命令给完整、可直接复制的（PowerShell，先 `cd` 到目录）。**不要用 Claude 的终端面板替用户启动应用来做真实试用**：Claude 桌面版是打包应用，从它启动的程序写 `%APPDATA%` 时会部分被重定向到 `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\DreamFlutter`（2026-11-02 实测：后台看到的数据库和外面不一致），建沙箱时 wsl 也找不到磁盘文件。让用户自己双击安装包里的 `app\dreamflutter.exe`（用户平时用 `E:\DreamFlutter测试版`，见本节开头）。注意：跑过 `flutter test integration_test/... -d windows` 之后，`app\build\windows\x64\runner\Debug\dreamflutter.exe` 是测试程序，不是应用。
- 分工：Claude 写全部代码（前后端）；Codex 只做必要的只读审查（额度少，经 Agent Bridge 后台任务，`cwd: E:\claude\DreamFlutter`）；广泛调研交给 Antigravity（Agent Bridge）。
- **测试模型走 OpenCode Go**（用户 2026-11-01 决定）。
  - 用户在应用里自己填 Key、配渠道（渠道 `c13903cbb`，模型 `deepseek-v4.1-flash`）。**不要在测试里新建渠道，也不要经手 Key。**
  - E2E 启动前用 `core/scripts/copy-channels.ts` 把这个渠道（加密的 Key 文件原样）复制进测试自己的后台；没有这个渠道或给了 `--dart-define=E2E_MODEL=…` 时，用 Pi 配置的模型。
  - 用户的 DeepSeek 官方余额不多，不要再默认用它。
- **提交、打 tag、推送都等用户说**（GitHub 公开仓库 jun64349/DreamFlutter）。
- **改了后台代码**之后，用户要从托盘「退出并停止后台」一次，新代码才生效（应用不会自动替换旧后台；直接结束后台进程会被权限检查拦下）。跑 E2E 或视觉检查前，用户的应用要先退出：调试版 `dreamflutter.exe` 会被占用。
- 外部标准（如 Showcard）按官方规范、原样参考代码和官方一致性测试来做，列出偏差。

## 全仓库 Codex 审查（2026-11-03，v0.3.2 之后）

用户要求「大范围 review」：Codex 只读审查分四块（备份迁移、后台核心、功能模块、窗口与协议层），报告原文在 `C:\Users\21669\AppData\Local\agent-bridge\jobs\20261103-0744*.md` / `20261103-0745*.md`。逐条核对后修了大部分，没修的列在下面。

- **已修**：
  - 备份迁移：资料编号路径穿越；沙箱恢复改为 agent 用户解包到 `/df-restore/new` 再换（旧文件挪到旁边，实机验证过恶意包写不进 `/etc`）；跨盘移动先写 `.df-partial`；**沙箱 WSL 名字按数据目录区分**（`distroFor`，`sandbox\distro.txt`；v0.3.1 建的沙箱和 adopt 搬来的保留旧名 `DreamFlutterSandbox`），否则开发版和安装包会互删沙箱；打包脚本拒绝输出到仓库所在目录；备份里 Authorization / `*_API_KEY` / `*_TOKEN` 等也抹掉；恢复从自动备份到重启一直持有 `maintenance`；搬家时旧后台还活着就不搬、过程中持有 maintenance、中途中断（state=started）下次重来；定时任务立即运行、继续卡片在 maintenance 时拒绝；PathMap 保留「位置不变」规则作屏障；Pi 设置里 `-路径` / `+路径` 也换路径；窗口偏好写失败返回 false，恢复结果偏好存好才 ack；apply / undo 时窗口把当前偏好交给自动备份。
  - 后台核心：蝶君会话不再有 `read_document`（在主机上读文件）；沙箱会话的 `web_fetch` 离线时拒绝、联网时只连公网（`fetchPublic` 用 undici Agent 在**连接时**检查地址，防 DNS 重绑定；undici 已加为直接依赖；`isPrivateAddress` 按数值判断 IPv6）；沙箱启动脚本防火墙一次事务替换、挂载 / 防火墙失败即停沙箱（实机验证）；`git --textconv` 要批准；子 Agent 准备期间被停止就不开始；压缩的花费计入运行；被拒绝（auth）的 Key 不再兜底重试；`switch_session` 不能切到别的 slot 已打开的会话文件。
  - 功能模块：定时任务启动前再查一次是否被暂停 / 修改 / 删除（`stillWanted`）；重启时把已认领未开始的运行（retry_at 为空）捡回来；继续卡片失败时恢复为待处理；记忆同一目标的两个更新候选，后接受的替换先接受的；记忆导出 / 清空工作区不受 500 条限制；MCP 保存写入时重新读文件；卡片 `net` 绑定只连公网并限制下载大小。
  - 窗口：打开文件改用 ShellExecute（`launchUrl(Uri.file)`，原来 `cmd /c start` 文件名带 `&` 能执行命令）；回复里的 `\\server\share` 路径不再在渲染时探测，Markdown 图片只加载 http(s)；临时对话里打开历史会话用新的运行环境（不再把临时对话变成存盘的）；蝶君的提问对话框拿对控制器（原来会自己取消）；重连时又断开会继续重连；书桌自动保存按编辑版本记「已保存」；图片先看大小再读。
- **没修，留着**：撤销恢复不会删掉恢复时新加进来的会话文件；仓库自己的 git 配置（fsmonitor、textconv、diff.external）可能让只读 git 命令执行程序（0.4 改 shell 时处理）；两个 Agent 同时改同一文件的锁不共享；图片描述不能中途取消；三个后台同时启动的锁竞争；定时任务绑定到已打开的会话时用普通轮数上限（0.8）；连接时的回放快照和实时事件的先后（可能显示「运行中」不消失）；长任务的步骤列表没有虚拟化（性能，0.4 过程折叠时一起看）；资源受限的 Key 冷却期间仍会兜底重试（单 Key 渠道常见，故意保留）。

## v0.3.2 数据集中（2026-11-03）

见 [v0.3.2-release-notes.md](v0.3.2-release-notes.md)。要点：

- **数据目录** = `<软件目录>\data`，软件目录 = 放着 `core\` 的那个文件夹。后台 `core/src/paths.ts` 的 `APP_ROOT`（从 paths.ts 自己的位置推）和窗口 `CoreLocator.defaultDataDir()`（找到 `core\src\main.ts` 再往上三级）必须算出同一个地方；`DREAMFLUTTER_DATA` 覆盖两边。里面：后台的东西照旧平铺（core.db、secrets、cards、butterfly、sandbox、backups…），`pi\` 是 DreamFlutter 专属的 Pi 目录（`defaultAgentDir(dataDir)`），`window\prefs.json` 是窗口偏好（`FilePreferencesStore` 顶替 shared_preferences 的 Windows 存储，第一次用时接过 `%APPDATA%\com.dreamflutter\dreamflutter\shared_preferences.json`），`webview2\`，`cache\`（shell 长输出、uv / pip 缓存、拖进来的图片）。
- **隔离**：`main.ts` 把 `PI_CODING_AGENT_DIR` 设成 `data\pi`（Pi 内部的 bin、themes 等跟着走，Agent 开的 shell 也继承）；`dropSharedAgentSkills` 作为 Pi 资源加载的 `skillsOverride`，去掉 `~/.agents/skills`（host.ts 和 skills.ts 两处）。**不改 `HOME`**（会影响 git 等找配置）。
- **自动搬家**（`backup.ts` 的 `migrate`）：只在默认数据目录（`main.ts` 给 `legacyData`）、新库还没用过（没有运行、记忆、渠道）、没有 `migration.json`、旧目录没有「已搬到新位置.txt」时做一次。做法 = v0.3.1 的备份恢复：旧库 `createBackup`（Key 用 local 方式、只带 DreamFlutter 的会话：数据库里引用过的 + 文件头部有 `"customType":"df.` 的）→ 复制 Pi 下载的 rg / fd → `Sandbox.adopt` 搬沙箱（拷磁盘、unregister、import-in-place）→ `stageBackup`（`minDbVersion: 1`，v0.2 的库也能搬）→ `apply`（不再先自动备份空数据）→ 后台重启时切换；下次启动 `afterMigration` 在旧目录写标记。窗口收到 `backup.migrating` 时没有专门提示（只有恢复结果的提示），下次可以加。
- 打包：`dist\DreamFlutter\`（不带版本号），重新打包时删除里面除 `data\` 以外的东西。`.gitignore` 加了 `/data/`。
- 测试：`backup.test.ts` 新增搬家测试（只搬 DreamFlutter 的会话、Key 能用、rg 跟过来、旧目录有标记、不会搬第二次）。**真实环境没跑过搬家**：用户第一次打开 v0.3.2 安装包就是第一次真实运行，`%APPDATA%\DreamFlutter` 和 `~\.pi\agent` 原样保留，出问题可以删掉 `dist\DreamFlutter\data` 和旧目录里的「已搬到新位置.txt」重来。

## v0.3.1 备份、迁移与恢复（2026-11-03）

按 [v0.3.1-backup-design.md](v0.3.1-backup-design.md) 做的，文档末尾「实现记录」写了所有具体做法和与设计不同的地方。要点：

- 后台 `core/src/backup/`，模块 `BackupModule`。RPC：`backup.overview / export / cancel / job / inspect / stage / apply / discardStaged / restoreResult / ackResult / undo / history / delete`；导出、准备、替换是后台任务，进度走 `backup.job` 事件，替换前广播 `backup.restarting`。
- 每个模块在构造时 `core.declareBackup(...)` 声明自己的表和路径列；**以后加表要加声明**，否则 `backup.test.ts` 的「每张表都有人认领」会失败。新功能有路径列也要写进 `paths`。
- 替换：`backup.apply` 先自动备份当前数据（`backups\auto-import-*.dfbackup`）、写 `restore-switch.json`、后台退出；窗口重连时新后台在 `main.ts` 里、打开数据库之前执行切换（`applyPendingRestore`），结果在 `restore-result.json`。切换失败（退出码 4）会在下次启动重试回滚。升级数据库前的自动备份也在 `main.ts`（`backupBeforeUpgrade`）。
- 窗口：`ui/backup_panel.dart`，设置里「数据与存储」改名「数据与迁移」，加「备份与恢复」一组。`AgentController` 连上后台后读 `backup.restoreResult`，把备份里的窗口偏好写回一次（`Preferences.exportAll / importAll`）并提示。
- 依赖：yazl 3.3.1、yauzl 3.4.0（及其类型包）。
- 沙箱文件的打包和放回在真 WSL 上试过（2026-11-03，用随附镜像导入临时发行版 DFBackupCheck，试完已删）：打包、改动、放回后文件和属主（23456）都对，后加的文件被清掉。
- 安装包 `dist\DreamFlutter-0.3.1\` 已打好（带镜像、uv、Python、zip 库）。小问题：`npm prune` 删不掉开发依赖 jsdom 的文件夹（路径太长），留在包里，无害，下次打包脚本里处理。
- 测试：`core/test/backup.test.ts`（8 个：表认领、路径对照、迁移密码、换「电脑」整套往返 + 撤销、不带 Key 时列出要重填的渠道、恶意 / 更新 / 损坏的包、任务在跑时拒绝和取消不留半成品、切换中途被杀和失败）；`app/test/backup_panel_test.dart`（3 个）。
- **没做 / 没验证**：真实两台电脑之间的迁移；「磁盘满」没有测试；DPAPI 的另一个 Windows 用户下解密靠的是「导入时用当前用户重新加密」，没在真实的第二个用户下试。

## v0.3 沙箱 3.2 / 3.3（2026-11-02）

**WSL**：用户的电脑上 `wsl --install` 失败（`REGDB_E_CLASSNOTREG`，系统自带的引导调不动安装组件），改为从 github.com/microsoft/WSL/releases 下载官方 `wsl.3.0.3.0.x64.msi`（核对过微软签名）用 msiexec 装好，WSL 3.0.3、内核 6.18，不用重启。用户另有本机代理 `127.0.0.1:12450`（环境变量），WSL 每次都提示「localhost 代理未镜像」，无害。

**手动验证过的事实**（比调研报告可靠，写进了 `core/src/sandbox/sandbox.ts` 文件头）：
- （2026-11-02 第二个窗口起**改用 Debian 13 并随应用附带镜像**，见「v0.3 沙箱镜像」一节；下面这条是原来的做法，Ubuntu Base 现在只用作构建镜像时临时的构建环境。）底包用 **Ubuntu Base 24.04**（约 30 MB，首次使用时下载，不涉及再分发）；校验值和 cdimage.ubuntu.com 官方 SHA256SUMS 一致。下载**直连不走代理**（用户要求；`sandbox/download.ts` 用 node:https，不用 Pi 的带代理 fetch）。这台电脑直连：阿里云通，清华、中科大连不上，所以阿里云排第一。
- `wsl.conf` 关自动挂载 + 关互操作后：看不到磁盘；agent（无 sudo）挂不了 drvfs、改不了 wsl.conf、注册不了 binfmt；**沙箱里运行 Windows 程序会被宿主拒绝**（`UtilAcceptVsock accept4 failed`）。
- **所有 WSL 发行版共用一个虚拟机和网卡**：`ip link set eth0 down` 会让用户所有 WSL 断网，重启发行版也不恢复（`wsl --shutdown` 才恢复）。所以离线 = nftables 只拦 agent 的 uid（**23456**，故意选罕见的，别的发行版不会撞）。
- `/etc/resolv.conf` 是指向 `/mnt/wsl/resolv.conf` 的链接，卸载 `/mnt/wsl` 前要先复制成真文件（boot 脚本已做）。
- 停掉的发行版的 vhdx 仍被虚拟机占着，覆盖会 `EBUSY`：重置 = `--unregister` → 复制 clean.vhdx → `--import-in-place`（3 秒）。
- 装工具约 3–5 分钟，磁盘约 1.3 GB，快照复制 1 秒，冷启动 0.4 秒。

**已完成**：
- `core/src/sandbox/sandbox.ts`（模块 `Sandbox`，只在 Windows 加载）：`sandbox.status / provision / reset / selfTest / setOnline / remove`，事件 `sandbox.changed`（带步骤和下载进度）。设置 `sandboxOnline`（默认 true）。数据在 `%APPDATA%\DreamFlutter\sandbox\`（disk\ext4.vhdx、clean.vhdx），发行版名 `DreamFlutterSandbox`。
- 逃逸自检 10 项（以 agent 身份）：uid、看不到磁盘、不能挂载、没有 sudo、切不到 root、改不了 wsl.conf、注册不了互操作、共享目录已断开、改不了防火墙、运行不了 Windows 程序。**真实环境全部通过**。
- 执行环境抽象（3.2）：`agent/state.ts` 的 `ExecEnv`（`HOST_ENV` / `sandboxEnv(distro)`）：路径按环境解析（沙箱是 POSIX），文件工具经 `state.local()` 用 `\\wsl.localhost\<发行版>\...` 读写，rg 经 `env.spawn` 在沙箱里跑。`agent/sandbox-shell.ts`：沙箱里的常驻 bash（`bash` 工具，结束标记、超时、截断）；先起 shell 占住发行版再跑 boot。`harness.ts` 的 `sandbox` 选项：工作目录 `/workspace`、bash 代替 pwsh 和后台任务、提示词加 `SANDBOX_ENVIRONMENT`（`host-text.ts`）。
- 沙箱会话：`slot.open` 带 `sandbox: true`；会话文件记 `df.sandbox`，再打开自动恢复；总是标准模式；**沙箱会话里不审批**（`core.ts` approval override）；子 Agent 跟随父会话进沙箱。`SlotInfo.sandbox`。
- 窗口：设置 › 蝶君沙箱（`ui/sandbox_panel.dart`）：没 WSL 时给安装说明、建立（进度条）、自检结果、联网开关、重置、删除。
- 测试：`core/test/sandbox.test.ts`（纯函数）；`core/test/sandbox-live.test.ts`（真 WSL，`$env:DF_WSL_LIVE="1"` 才跑，会建沙箱约 5 分钟，**还没跑通过一次**）；`app/test/sandbox_panel_test.dart`；真实检查 `cd core; node --disable-warning=ExperimentalWarning scripts/live-sandbox.ts [--keep]`。

**在线时沙箱上不了网：已修好（2026-11-02 第二个窗口）**：
- **根因**：WSL **每次新启动一个进程**（每次 `wsl.exe -d …`，包括 Agent 的 `rg` 搜索）都会把 `/etc/resolv.conf` 重新建成指向 `/mnt/wsl/resolv.conf` 的链接（实测：链接的时间戳等于每次启动的时间）。boot 脚本原来把 resolv.conf 复制成真文件、再卸载共享的 `/mnt/wsl`，下一次启动链接又回来了，指向已经卸载的地方，DNS 就断了；再 boot 时读不到 nameserver，退回 `127.0.0.53`，防火墙只放行它，真正的 DNS（DNS 隧道 `10.255.255.254`）落在 10.0.0.0/8 被拦。真实应用里也会出这个问题：Agent 用一次搜索（`rg` 是单独启动的），沙箱就断网。
- **做法**（`sandbox.ts` 的 `bootScript`）：卸载共享的 `/mnt/wsl` 后，挂一个私有的 tmpfs（来源名 `dfresolv`，64K，root 才能写）在 `/mnt/wsl`，里面只放 resolv.conf；`/etc/resolv.conf` 保持指向它。WSL 重建的链接也就指向这个文件。已经是 `dfresolv` 就不重复挂。自检的 `no-shared-mounts` 不算 `dfresolv`，新增一项 `dns-locked`（agent 改不了 DNS 设置）。
- **验证**：留下的测试沙箱里逐项：在线 aliyun 301、baidu 200 → 离线都是 000 → 再在线 301 / 200；中间单独启动一次 `rg` 后照样能上网；局域网（192.168.1.1）照样拦；自检 11 项全过。`scripts/live-sandbox.ts` 这次跑出的「online: 000」是旧 boot 脚本的结果（建沙箱 15 分钟，这台电脑当时网络慢，后来一度整机断网），修好后没再整套重跑；下次有空再完整跑一次 `live-sandbox.ts`（约 15 分钟）。
- 坑：Git Bash 里调 `wsl.exe … --cd /workspace` 会被 MSYS 改写路径（报 `Wsl/ERROR_FILE_NOT_FOUND`），要 `export MSYS_NO_PATHCONV=1`。
- 测试发行版 `DFSandboxLiveCheck` 和临时文件夹已删除。

**版本管理**：已完成。GitHub 公开仓库 https://github.com/jun64349/DreamFlutter，`origin` 已设好。以后推送仍然**等用户点头**（提交和打 tag 也是）。v0.3.0 发布时推 `main` 和新 tag。

## v0.3 工作区运行环境 3.6（2026-11-02）

- **工具链随应用**：`core/bin` 放 rg、fd（打包时从 Pi 的 bin 拷）和 uv / uvx / uvw；`core/python/cpython-3.13.*` 是便携 Python（python-build-standalone，由 uv 安装并校验）。开发目录里用 `cd core; node --disable-warning=ExperimentalWarning scripts/fetch-toolchain.ts` 取（uv 走 GitHub 的 `releases/latest/download`，GitHub API 在这台电脑会 403；下载经 curl，走代理；只在开发机上跑）。`core/python/` 不进 git。uv 31 MB、Python 60 MB（未压缩）。uv 装 Python 时会建一个版本别名的 junction（`cpython-3.13-windows-...`），打包用 `robocopy /XJ` 跳过，不然 Python 拷两份。
- **Agent 的命令**（`agent/shell.ts` 两处 spawn）用 `toolchainEnv()`（`agent/toolchain.ts`）：工具和 Python 排在 PATH 最前，`UV_PYTHON` 指向自带的 Python、`UV_PYTHON_DOWNLOADS=never`、`PYTHONUTF8=1`；没有自带工具时环境不变。
- **每个工作区的 `.dreamflutter\`**：工作台标准模式每次运行前 `prepareWorkspace(cwd)` 确保它存在（第一次建时写 `.gitignore` 内容 `*`，git 完全看不到它），系统提示词加「# Workspace environment」一节（`workspaceGuidance`）：有哪些工具、自己的文件放 `.dreamflutter\`（`venv\` 用 uv 建、`tmp\` 放临时文件和辅助脚本）、`.dreamflutter\workspace.md` 是给以后会话的工作区笔记（学到长期有用的事就更新）。笔记内容（超过 6000 字截断）每次运行都重新读进提示词。极简模式、蝶君（沙箱）不加这一节。
- 测试 `core/test/toolchain.test.ts`（环境变量、文件夹和 git、提示词、会话里每次读到最新笔记、极简模式不加）。真实检查：按 Agent 的方式起 PowerShell，`uv` 和 `python` 都是自带的，在 `.dreamflutter\venv` 建虚拟环境并 `uv pip install six` 成功。
- 安装包：`package-windows.ps1` 拷 uv 和 Python，`THIRD-PARTY.txt` 写 uv（MIT / Apache-2.0）和 Python（PSF，许可文本在 `core\python\*\LICENSE.txt`）。

## v0.3 沙箱镜像：Debian 13，随应用附带（2026-11-02）

用户试用后提出「安装包把东西都打包进去，不要在线下载」，选了**换 Debian 并打包**（Ubuntu 的商标政策限制再分发改过的镜像，Debian 没有这个问题）。

- **构建**：`core/scripts/build-sandbox-image.ts` → `core/sandbox-image/dreamflutter-sandbox.tar.gz`（+ `.json`：sha256、Debian 版本、时间、大小、包数；+ `.packages.txt`：每个包和版本）。这个文件夹不进 git（`.gitignore`）。做法（`core/src/sandbox/image.ts`）：导入 Ubuntu Base 当临时构建环境 → 装 debootstrap 和 debian-archive-keyring → `debootstrap --variant=minbase`（校验签名）组装 Debian 13 trixie → chroot 里 apt 装工具（`IMAGE_PACKAGES`：原来那些 + passwd + `fonts-wqy-microhei`，`/etc/matplotlibrc` 设好中文字体）→ 写 wsl.conf、建 agent（uid 23456）、锁 root、建 /workspace → 列包清单、清掉 apt 缓存和 resolv.conf → `tar --numeric-owner -czf` → 拷出来 → 删除构建环境（`finally` 里一定删）。镜像里装了 sudo 就构建失败。
- **下载源测速挑最快的**（`pickFastest`，并行各下 1MB）：2026-11-02 阿里云只有 0.24 MB/s，deb.debian.org（CDN）4.5 MB/s，华为云 Debian 2.3 MB/s、Ubuntu 7 MB/s；清华、中科大、163 连不上。Debian 源顺序：官方、华为云、阿里云；Ubuntu（只给构建环境用）加了华为云。
- **实测**：镜像 282 MB（压缩后），240 个包，构建 349 秒。用镜像建沙箱 **8 秒**（原来在线装约 15 分钟）。`scripts/live-sandbox.ts` 全部通过（自检 11 项、工具、Debian 13、matplotlib 找到中文字体、在线 301 / 离线 000 / 再在线 301、重置）；`DF_WSL_LIVE=1` 的 `sandbox-live.test.ts` 通过。
- **建沙箱**（`sandbox.ts` 的 `doProvision`）：有随附镜像（`bundledImage()`：`core/sandbox-image/` 或环境变量 `DREAMFLUTTER_SANDBOX_IMAGE`，要有 `.json`）就先校验 sha256 → `wsl --import` → `CHECK_SCRIPT`（agent 的 uid、wsl.conf、工具、没有 sudo）→ 保存干净快照；没有随附镜像（没跑过构建脚本的开发目录）就当场在线构建一份（10–20 分钟），用完删掉。`sandbox.status` 多了 `bundled`，设置面板按它显示「不用联网，一般 1–2 分钟」或在线构建的说明。
- **安装包**：`scripts/package-windows.ps1` 把镜像三个文件拷进 `core\sandbox-image\`，`licenses\THIRD-PARTY.txt` 加 Debian 的说明（每个包的许可证在镜像的 /usr/share/doc/*/copyright，源码在 snapshot.debian.org），`licenses\Debian-packages.txt` 是包清单；没有镜像时报错，`-NoSandboxImage` 可以跳过。安装包因此大约多 282 MB。**还没实际打过一次包。**
- 坑：`image.ts` 和 `sandbox.ts` 互相 import，模块顶层的常量不能跨这个环用（`IMAGE_PACKAGES` 因此放在 image.ts），只能在函数里用。

## v0.3.1 全平台备份、迁移与恢复（已定，v0.3.0 发布后做）

用户 2026-11-02 给了调研设计报告（Codex 写的）：`C:\Users\21669\Desktop\毕设、agent学习笔记库资料库\DreamFlutter\2026-11-02 13-01 Codex-五项平台能力调研与设计\2026-11-02 13-01 Codex-01-v0.3.1全平台备份迁移与恢复-调研设计报告.md`，说「这个东西我们是要做的」，归在 v0.3.1（v0.3.0 发布后的第一个补丁）。同一个文件夹还有 4 份报告（三级记忆、DSH 与蝶君、Goal、后台压缩），还没看。

**用户 2026-11-02 定了**：五个待定项按 Claude 的建议；旧版本「从 v0.3.0 起都支持」；**先做完并发布 v0.3.0，再做 v0.3.1**，然后用户真实测试反馈；另外 4 份报告在 v0.3.1 测完、0.4 开工前看。设计文档 [v0.3.1-backup-design.md](v0.3.1-backup-design.md)，roadmap 第二节第 9–11 条和「v0.3.1」一节。下面是给用户的核对意见（已写进设计文档）：
- 报告漏了**蝶君的沙箱**：只打包沙箱里的 `/workspace` 和 agent 的家目录，不带整块磁盘（能用随附镜像重建）。
- 会话文件在 Pi 的公共目录 `~\.pi\agent\sessions`（38 MB，混着用户自己的 Pi 会话和测试会话），要按后台的会话索引挑。
- **到处是绝对路径**：数据库（任务、运行、卡片、资料）、Pi 按 cwd 编码的会话文件夹名（如 `--C--Users-21669-AppData-Roaming-DreamFlutter-butterfly--`）→ 要一张「路径对照表」，导入时改数据库和会话文件，平台自己的目录也算。
- 「试装数据」实际是：后台数据库一直共用，窗口偏好分两份（`%APPDATA%\com.dreamflutter\dreamflutter\`、`%APPDATA%\DreamFlutter.Packaged\DreamFlutter-v0.2.0\`）。
- 不备份：webview2（86 MB）、core.json/lock/log、core\bin、沙箱的 clean.vhdx。密钥在 `%APPDATA%\DreamFlutter\secrets`（DPAPI），Pi 的 auth.json 是空的；迁移密码用 Node 自带的 scrypt + AES-256-GCM。
- 导出由后台做：有任务在跑先请用户等或停，暂停定时；数据库 `VACUUM INTO`；会话按当时长度复制。替换导入：后台先检查并解到暂存区、写切换记录，重启时打开数据库之前完成切换，失败回到旧数据。
- 五个待定项：支持 v0.3.0 及以后（用户改的）；默认不含密钥，勾选含 API Key 时设迁移密码；工作区文件只记位置、蝶君资料默认随包（超 200 MB 提醒）；**第一版只做整套替换 + 替换前自动备份**（报告要求的「恢复成独立数据集」放以后，和报告不同，要用户拍板）；升级前、导入前自动备份各留 3 份，放 `%APPDATA%\DreamFlutter\backups`。
- 每个模块声明自己的备份数据，加一个测试检查数据库每张表都有人认领。

## v0.3 蝶君骨架 3.5（2026-11-02）

按 roadmap 3.5 做的骨架。名字是工作名（0.4 品牌讨论时定）。

**后台**（`core/src/modules/butterfly.ts`，模块 `ButterflyModule`）：
- 蝶君有自己的「家」：`%APPDATA%\DreamFlutter\butterfly`（`CorePaths.butterflyDir`，`core.hello` 带 `butterflyHome`）。蝶君的会话都用这个 cwd 打开（`slot.open` 带 `sandbox: true`），所以 Pi 的会话按 cwd 分开存，**工作台的会话列表、工作区列表里都看不到它**（窗口还把这个文件夹从「最近工作区」里滤掉了）。
- **数据迁移**：第一次启动时把所有工作区的写笺、资料、收进书桌的卡片（`on_desk = 1`）、写笺的产物都搬到蝶君的家（同一个文件被两张书桌加过的合成一条）；任务留在原工作区。只做一次：数据库第 8 版新表 `app_flags` 记 `desk_moved_to_butterfly`。
- `butterfly.handOff {noteId}`：沙箱没建好就直接报错（不建任务）；把「工作」里的全部资料复制进沙箱 `/workspace/inbox`（文件、文件夹原样复制，粘贴的文字存成 `<标题>.md`，同名覆盖），建任务（`source: note`，cwd = 蝶君的家），返回提示词：写笺原文 + inbox 里的路径 + 「结果放进 /workspace/outbox」+「不清楚先问用户」。**去掉了选动作的弹窗**（额外反馈 6）。
- `butterfly.import {paths}`：拖进蝶君对话的文件复制进 inbox，返回沙箱路径。
- `butterfly.outbox`：列出 outbox 里的文件（经 `\\wsl.localhost\<发行版>\workspace\outbox`，最多 200 个，新的在前）。蝶君每次运行结束后对比 outbox，广播 `butterfly.outbox`（带 `fresh`：新增或改过的文件），窗口弹提示；没有窗口连着时发系统通知。
- 沙箱会话写的文件按 `\\wsl.localhost\…` 记成任务产物（`tasks.ts`）。
- **默认不开 MCP**（`pi/host.ts`：沙箱会话不加载 Pi 的 mcp 扩展）；**蝶君的卡片不给本机授权**（`cards.ts`：家里的卡片调用任何宿主工具都返回 TOOL_UNAVAILABLE「蝶君的卡片不能使用这台电脑上的文件、网络或程序」）。
- 测试 `core/test/butterfly.test.ts`（7 个：家、迁移只一次、交付流程和 inbox 副本、没沙箱时拒绝且不建任务、拖入和 outbox 列表、卡片无本机授权、文件名）。测试里把 `ButterflyModule.local` 指到普通文件夹。

**窗口**：
- 导航：「对话」→「工作台」，「书桌」→「蝶君」（`AppSection.butterfly`，图标 `filter_vintage`）；工作台会话栏标题也改成「工作台」。
- 蝶君页 `ui/butterfly_page.dart`：顶栏「蝶君 [交流][工作]」+ 沙箱联网状态；没有沙箱时「交流」显示说明和设置面板（`SandboxPanel`），建好后自动切到对话；后台太旧（hello 没有 `butterflyHome`）时提示从托盘退出后台。
- **「交流」**：第二个 `AgentController`（`sandbox: true`，`parentController` = 主控制器，`AgentController.ensureButterfly()` 第一次用时创建），共用后台连接；会话都在沙箱里开（`SessionTarget.sandbox` → `slot.open sandbox`），用现成的 `Sidebar` + `ChatView`，外面包自己的 `AgentScope` 和 `ExtensionDialogHost`。蝶君控制器：不换工作区、不显示临时对话和模式切换（总是标准模式）、提示和徽标交给主控制器（`_mainOnlyEvents`）、空闲会话由主控制器的定时器回收、断线由主控制器重连后 `_reattach`。`openTask` / `continueWork` / `resumeInterrupted` / `openSearchHit` 按 cwd 交给对应的控制器（`_ownerOf`）。拖进蝶君对话的文件（图片以外）复制进 inbox，变成沙箱路径的附件；`@` 和右栏「写笺」只给写笺和粘贴的文字（本机路径蝶君打不开）。
- **「工作」** = 原书桌（`desk_page.dart`，cwd 换成蝶君的家，去掉工作区切换）：右栏「交付」（outbox，`OutboxTile`：点开预览文本/图片，小于 512KB 的文本可以直接改，「保存到这台电脑」选位置复制，用默认程序打开、在资源管理器中显示）、「改过的文件」、卡片、最近任务。写笺右上角「交给蝶君」直接交付，切到「交流」看它干活。
- 卡片菜单「收进书桌」只在蝶君的对话里出现，改叫「收进「工作」」；工作台没有书桌了，工作台对话的卡片不再能收起来。工作台右栏的「书桌」标签也只在蝶君对话里出现（叫「写笺」）。
- 测试：`work_pages_test`（交给蝶君：调 `butterfly.handOff`、在沙箱会话里跑、绑定任务、工作台看不到）、`chat_panel_test`（工作台没有写笺标签；蝶君右栏的写笺能附上）、`cards_test`（收进「工作」只在蝶君里）；`FakeBackend.butterflyHome`。集成测试同步改了：`look_test` 看蝶君页，`cards_test` 在工作台直接放大卡片测授权，`e2e_test` 第 16 步改成蝶君 › 工作（测试后台没有沙箱，交付会提示「沙箱还没有建好」；真实交付由 `sandbox-live.test.ts` 和后台测试覆盖）。**集成测试这次没跑**。

**用户试用后的修改（2026-11-02）**：
- 用户：「工作部分也是要在独立环境里进行」→ 整个蝶君页都等沙箱：没建好时「交流」「工作」两个标签都不显示，只显示建立沙箱（`butterfly_page.dart`）。
- 书桌遗留：v0.2 书桌的 Agent 在本机写的文件跟着写笺搬了过来，不该算蝶君的 → 「工作」的「改过的文件」和写笺下面的产物只列沙箱里的（`isSandboxPath`：`\\wsl.localhost\` / `\\wsl$\`），写笺下面的任务只列蝶君的（cwd = 蝶君的家）；空写笺页的「一张干净的书桌」、资料的「从书桌移除」改了说法；`NoteEditor` 去掉没用的 `materials` 参数。数据库里的旧记录没动。
- **试用的坑**：从 Claude 的终端面板启动应用，数据目录被 Claude（MSIX 打包应用）部分重定向，见「和用户合作的约定」。让用户自己双击 `app\build\windows\x64\runner\Debug\dreamflutter.exe`。

**没做 / 留到以后**：
- 技能里的脚本复制进沙箱执行（roadmap 3.5「技能里的脚本复制进沙箱执行」）：蝶君现在能读技能说明，但脚本在本机路径，沙箱里跑不了。
- 记忆的「蝶君」分区：现在只是按 cwd 自然分开（工作区范围的记忆），全局记忆两边共用；正式隔离在 0.5（5.5）。
- outbox 里的 PDF / HTML 没接应用内的渲染页，只能用默认程序打开。
- 「交流」里的会话标题、运行面板等都沿用工作台的样子；视觉在 0.4 统一。
- 真实模型下的整条流程（交给蝶君 → 它在沙箱里用 Python 出图 → outbox → 保存到本机）**还没跑过**，要用户在应用里试，或下个窗口用真沙箱跑一次。

## v0.3 子 Agent 3.4（2026-11-02）

设计见 [v0.3-design.md](v0.3-design.md)。顺序调整：子 Agent 先做（不依赖沙箱），3.2 执行环境抽象和 3.3 WSL 沙箱一起做。

- **角色卡** `core/src/agent/roles.ts`：`general`（通用，全部标准工具）和 `explore`（调研员，只读：read、glob、grep、web_fetch、read_document、read_image、working_directory、skill）。子 Agent 永远没有 `agent`（不嵌套）、`ask_user_question`、`exit_plan_mode`、`todo_write`。
- **`agent` 工具** `core/src/modules/subagents.ts`（标准模式，`STANDARD_EXTRA_TOOLS` 里加了 `agent`，免审批）：参数 `role`、`description`、`prompt`；`executionMode: "parallel"`，同一轮调用几次就同时跑几个，整个后台最多 4 个同时跑。子 Agent 是内存里的 Pi 会话：`Core.openSubagentRuntime` 用父会话的审批规则（含定时任务的限制）+ 标了 `forSubagents` 的模块（网关、读文档），不加载记忆、定时、技能提议、卡片、看图转述。模型和思考级别跟主 Agent（角色卡可以指定模型）。审批框经父会话的 UiBridge 出现在主对话里，末尾注明「来自子 Agent「通用 · 写笔记」」。主对话点停止，子 Agent 一起停；到轮数上限（通用 40、调研员 30）也停，交回已有结果。用量和改动的文件经 `Slot.absorbSubagent` → `RunRecorder.absorb` 算进父会话这次运行（花费上限照样管住它）。
- **进度**：工具的 `onUpdate` 带 `details`（角色、状态、正在做什么、轮数、工具次数、token、花费）；协议层 `ToolExecutionUpdateEvent.partialDetails` 新增，`Transcript` 把它放进 `ToolRun.details`。窗口 `message_widgets.dart` 的 `_SubagentStep`：一行「子 Agent · 调研员 · 查甲 · grep: 甲」，结束后点开看它的回复（Markdown）和统计；过程块总结「派出 2 个子 Agent」。
- 测试：`core/test/subagents.test.ts`（两个同时跑、各自只看到任务、工具受限、审批转到主对话并注明、文件算进运行、未知角色报错）；`app/test/subagent_step_test.dart`。
- **还没用真实模型试过**：DeepSeek 会不会主动用 `agent`、任务说明写得够不够，要用户在应用里试（例如「分头查一下 A 和 B」）。

## v0.3 修复批 3.0（2026-11-02）

额外测试里确认的 bug 都修了，每条有回归测试：

1. **思考档位**（额外 1、2）：根因在窗口：档位只在会话启动时取一次，新装的应用里先启动会话、后配渠道和模型，就一直只有「关闭」。现在每次刷新状态都重新取（`session_runtime.dart` 的 `_refreshState`，换渠道后的 `refreshModels` 也会刷新）；后台的模型列表给每个模型带上 `thinkingLevels`（`slot.ts`，Pi 的 `getSupportedThinkingLevels`），设置页的「新会话默认思考级别」按**默认模型**列档位；默认档位交给 Pi 就近换算（deepseek-v4.1-flash 关不掉思考，「关闭」会变成「低」）。
2. **从浏览器、聊天软件拖图片**（额外 3）：`desktop_drop` 复制到 `packages/desktop_drop`（Apache-2.0，`app/pubspec.yaml` 的 `dependency_overrides`），Windows 端拖放除了文件路径，还接收虚拟文件（FileGroupDescriptorW + FileContents）、PNG、CF_DIBV5 / CF_DIB 位图（WIC 转成 PNG），存到 `%TEMP%\DreamFlutter\drops\` 再交给输入框；什么都读不到时提示用 Ctrl+V。**真实拖放没有自动测试，要用户手动试**（QQ / 微信 / 浏览器各拖一张图）。
3. **发消息时窗口抖动**（额外 7）：消息列表「跟到底部」原来是画完一帧后再跳，输入框变高变矮、新消息、排队消息变成正式消息时都会画出一帧错位（测试测到 110、82、103 像素）。现在 `chat_view.dart` 的 `_BottomAnchoredController` 在布局时就钉在底部（`applyContentDimensions` 里 `correctPixels`），往上翻看时不动。`test/chat_scroll_test.dart` 逐帧检查。
4. **安装包缺 ripgrep**（额外 4）：Codex 打的包给 Pi 单独设了数据目录，里面没有 Pi 平常下载的 `bin\rg.exe`。后台现在按「应用自带 `core/bin` → Pi 的 bin → PATH」找 rg（`search-tools.ts`）；窗口按「`DREAMFLUTTER_NODE` → 自带的 `runtime/node.exe` → PATH」找 Node（`PiRuntimeLocator.findNode`）。打包脚本 `scripts/package-windows.ps1` 生成 `dist\DreamFlutter-<版本>\`（app、core 只留生产依赖、core\bin 的 rg/fd、runtime\node.exe、许可证），已实际跑通。它和开发版共用数据目录，没有 Codex 那个试用包的隔离启动器和卸载器（安装包的完整做法在 0.6 的 6.9）。
5. **产物在资源管理器里定位**（额外 9）：回复里用代码格式写的文件名或路径（相对会话工作区或绝对路径），文件真实存在时变成链接：左键在资源管理器里选中，右键用默认程序打开，文件夹直接打开（`markdown_view.dart` 的 `FileLinks`）。
6. **缓存命中率**（额外 10）：上下文面板加「缓存命中率」= 缓存命中 ÷（累计输入 + 缓存命中 + 缓存写入），「累计输入」悬停说明不含缓存部分。
7. **提问限时**（额外 12）：后台设置 `askTimeoutSeconds`（默认 60，0 = 一直等），设置 › 对话里可选 30 秒 / 1 分钟 / 5 分钟 / 一直等。`ask_user_question` 超时后选推荐项（标了 (Recommended) 的，没有就第一个），开放式问题算跳过，工具结果里告诉模型「用户没在 N 秒内回答」；窗口提问框显示倒计时，后台超时后窗口的框自动关掉（`confirm.changed` → `dropDialog`）。**批准操作不受影响，永远等用户。**

3.1 的三份调研（Antigravity）已存到 `docs/research/`：`wsl-sandbox.md`、`subagents.md`、`agent-security.md`。要点（待核验，出处里有可疑的 issue 编号）：
- **WSL**：普通用户挂不了 Windows 盘、重开不了互操作（印证不给 root 的决定）；宿主不用 Windows 管理员就能 `wsl -u root` 在沙箱里执行管理命令，一键离线 = `ip link set eth0 down`；`/mnt/wsl`（跨发行版共享）和 WSLg（`/mnt/wslg`）是额外的通道，要在启动时以 root 卸载；`wsl --import` 默认以 root 登录，`wsl.conf` 要写 `[user] default=agent` 且命令行带 `-u agent`；重置用「复制干净的 vhdx + `wsl --import-in-place`」约 1 秒；底包推荐 Debian（约 50MB，可以自由分发）；`\\wsl.localhost` 大文件快、海量小文件慢。
- **子 Agent**：四种双环境模式：沙箱探路（本机主 Agent 把改动交给沙箱子 Agent 试到通过，再一次性请用户批准）、高风险工具降级到沙箱（不可信内容的解析、抓取都在沙箱里做，防提示注入）、沙箱并行竞速（几个方案同时试，挑最好的）、本机设计 + 沙箱验证。
- **安全**：P0 敏感路径硬拦截（`.ssh`、浏览器数据、`.env*`…）、命令判断换成语法解析；P1 运行时脱敏、MCP 子进程清洗环境变量；P2 Windows 受限令牌、出站白名单；P3 结构化审计日志。扩充放 0.6（6.7），P0 两条可以考虑提前。

v0.1.1 和 v0.2 各阶段的细节按时间倒序记在下面，查历史时再看。用户 2026-10-31 决定不再做 computer-use 人工测试。

## v0.2 收尾：OpenCode Go 渠道（2026-11-01，用户深度测试第 20 条）

- 平台预设 `opencode-go`（`platforms.ts`）：OpenAI 接口 `https://opencode.ai/inference/go/openai/v1`、Anthropic 接口 `https://opencode.ai/inference/go/anthropic`，套餐类（5 小时 / 每周 / 每月），没有额度查询接口。不带 `/go` 的路径是按量付费的 Zen，Go 的 Key 打过去会 402。
- 会话头 `x-opencode-session`：Pi 1.4.0 的运行时对 opencode.ai 地址会自动按会话 ID 加上（测试锁住）；网关在没有会话 ID 的后台请求（标题、记忆、测试连接）里补 `dreamflutter-<渠道id>`。
- 模型信息（`gateway/catalog.ts`）：平台的 `modelsUrl`（公开、不需要 Key 的 `https://opencode.ai/inference/go/v1/models`）带上下文、最大输出、价格、图片、思考档位（`efforts`），「获取模型列表」按接口类型过滤并带上这些；注册渠道模型时，Pi 内置目录（`catalog: "opencode-go"`）认识的模型用它的 `thinkingLevelMap` 和 `compat`（`max_tokens`、DeepSeek 思考格式等），不认识的用列表里的 `efforts` 和平台默认 `compat`。例：deepseek-v4.1-flash 只有 low/high/max，选「中」时 Pi 会自动换成可用的档位。
- 顺手修了渠道编辑页「接口类型」下拉框在大字号下的溢出（深度测试第 2 条）。
- 真实检查（需要用户的 Key）：`$env:OPENCODE_GO_API_KEY = "oc_sk_..."; cd core; node --disable-warning=ExperimentalWarning scripts/live-opencode.ts [模型] [anthropic]`。

## v0.2 阶段 6：Codex 审查（2026-11-01）

只读审查 v0.1.1 以来的卡片、shell 审批、网关、任务/调度改动，8 条，核实后修 6 条（回归测试都标「v0.2 review」）：

1. 审批：单个 `&`（PowerShell 7 后台运算符）能把写操作藏在只读命令后面 → 出现单个 `&` 就要确认（`ext/approval.ts`）。
2. 审批：只读的 git 子命令带 `--open-files-in-pager` / `-O` / `--ext-diff`（含 git 允许的前缀缩写、短选项连写）会启动程序 → 要确认。
3. 卡片 `fs.*`：授权文件夹里的链接（junction）能指到外面 → 按解析链接后的真实路径再查一次（`cards/bindings.ts` 的 `realTarget`；检查和使用之间被替换链接的竞态没处理）。
4. 卡片 `web.read`：`fetchPage` 自动跟随跳转，已授权主机能把卡片带到本机/内网 → `fetchPage` 新增 `checkRedirect`，卡片每一跳都过 `checkTarget`；Agent 自己的 `web_fetch` 照旧。
5. 网关分类：状态码只要求前后不是数字，请求编号、打码后的 Key 尾号里的「401」会把 Key 永久停用 → 状态码和业务码按整词匹配（`gateway/classify.ts` 的 `codes`）。
6. 卡片 zip：stored 条目伪造解压大小能绕过总量限制、复制大量数据 → 两个大小必须一致，数据不能超出文件。

没改的两条：短于 8 个字符的 Key 不打码（真实 Key 都很长，打短串会误伤错误信息）；跨月/跨天的那次运行的花费算在开始的那天/月（最多超一次运行，单次运行有轮数上限；要精确得给每个请求记账，目前只有经网关的请求有记录，以后再做）。

## v0.2 收尾：深度测试里的小修复（2026-11-01）

- 上下文圆环每轮结束（`turn_end`）和压缩结束都刷新会话统计（`session_runtime.dart` 的 `_refreshStats`，同时只发一个请求），长任务里不再一直停在开始时的数字（第 19 条）。
- 文件拖放：整个对话区（`chat_view.dart` 的 `_FileDropArea`）接收，经控制器的 `dropFiles` / `fileDrops` 交给输入框处理；输入框只负责高亮（`Composer(dragging:)`）（第 16 条）。真实拖放没有自动测试（模拟不了系统拖放），要手动试一下。
- Ctrl + 滚轮缩放（`zoom.dart`）：一格一档，触控板连续滚动间隔 90 毫秒；按住 Ctrl 时列表不滚动（根部的 `_StillWhileZooming` 滚动规则）（第 8 条）。缩放比例那一栏按内容撑开，不再折成「100 / %」。
- 设置去掉「后台会话」说明（第 7 条）；版本号全部改为 0.2.0（窗口、后台、package-lock、测试）。
- 书桌产物：运行结束时只记录还存在的文件，Agent 写了又删的临时脚本不再出现（`tasks.ts`）。
- 自绘顶栏（第 35 条简版）：`desktop_shell.dart` 隐藏系统标题栏（`TitleBarStyle.hidden`，保留边缘拖拽和贴靠），`ui/title_strip.dart` 是导航栏同色的 32 像素条：拖动、双击最大化、window_manager 自带的 Windows 样式按钮，关闭仍是隐藏到托盘。只在真实窗口（`DreamFlutterApp(ownTitleBar: true)`）出现，不随界面缩放；单元测试和 E2E 不带它，视觉检查的对话页那组带。v0.4 计划把页面标题并进这一条。

## v0.2 阶段 5：页面重做 + 名画主题（2026-11-01）

- **共用框架**（`ui/common.dart`）：`SectionedPage`（左栏：衬线标题、分区 `SideNavItem` 带计数/红点、筛选；右边内容，跟书桌和对话页一样的三栏感觉）、`ContentHeader`（宋体标题 + 一句说明 + 操作）、`EmptyState`（蝴蝶 + 一句话 + 下一步按钮）、`PanelLabel`、`FilterRow`、`PanelSwitch`。左栏底色用 `Material` 而不是有色 `Container`，不然里面的 `SwitchListTile` 画不出来（测试会报错）。
- **书桌**（`desk_page.dart`）按设计稿改成三栏：左栏写笺列表和资料（文件/文件夹可以直接拖到左栏，底部「拖入文件，或粘贴文字」），中间是打开的写笺（纸面，标题和正文都是宋体，右上角是主题的印记，下面是这份写笺的任务和产物），右栏「进行中 / 产物（来自哪个任务）/ 卡片 / 最近任务」。第一次进来自动打开最新的写笺；「返回书桌」按钮换成「关闭写笺」。
- **任务**：待处理 / 全部任务（按今天、昨天、这一周、更早分组；筛选和「所有工作区」在左栏）/ 定时。
- **定时任务绑定已有会话**：编辑框里「在哪个会话里运行：每次新开一个会话 / 接着同一个会话」，选会话（`sessions.list`）；对话页右上角菜单新增「定时接着做」，直接绑定当前会话。后台早就支持（`sessionMode: bound`），这次补了后台测试（第二次运行能看到第一次的回复）。
- **记忆**：记忆库（按偏好/背景/经验分组，类别和范围筛选在左栏）/ 待确认（有候选时先打开）/ 常驻记忆块（三块直接展开编辑）；两个开关和「导出和清空」在左栏底部。
- **技能与模板**：技能（字母徽章、来源筛选）/ 任务模板（`/名字` 和 `{{参数}}`）/ 待确认（有建议时先打开）。
- **名画主题**（`theme.dart`）：调研报告 [research/art-themes.md](research/art-themes.md)（Antigravity，8 个候选；作品事实没逐条核实，所以界面上的出处写得比较概括）。用户选了 **日间**「蛱蝶」「草蝶」（梵高）「羽化」（梅里安）「神思」（多索·多西），**夜间**「墨夜」「幽华」（德·黑姆）「琉光」（蒂芙尼）。
  - 每个主题是一个 `PaintingTheme`：颜色（`AppColors`）、圆角（羽化直角、草蝶大圆角）、标题字体（拉丁字母用 Georgia / Sitka / Palatino / Constantia 等 Windows 自带字体，中文仍是思源宋体）、小标签字距、印记 `ThemeMark`（蛱蝶是「梦蝶」朱印；羽化、神思是斜体图版注记；草蝶、幽华、琉光是小蝴蝶）、会话栏底部的题字（中文竖排，西方作品是转 90° 的作品名）、蝴蝶线条粗细（琉光像铅条）。
  - 组件里的圆角统一用 `context.radius` / `radiusSm` / `radiusLg`（跟主题走），`AppTokens.radius*` 只剩「蛱蝶」的默认值。`buildTheme(brightness, painting: …)`，`context.painting` 取当前主题。
  - 选择方式：外观弹窗和设置 › 外观里，「明暗」（跟随系统/浅色/深色）+「日间主题」「夜间主题」各一排预览卡片；偏好 `lightTheme` / `darkTheme`，控制器 `setPaintingTheme`。
  - 对比度：新主题的正文、次要文字、强调色、状态色在底色/侧栏/卡片上都 ≥ 4.5:1（`test/themes_test.dart` 锁住）；原「蛱蝶」有 4 处 4.36–4.47 的小差距（赭石在侧栏上等），是之前定的颜色，没改。
- **测试**：窗口 70 个（新增主题测试、绑定会话的定时任务）；后台 151 个；`look_test.dart` 新增「the work pages in light and dark」：书桌、任务三栏、记忆三栏、技能三栏的浅色和深色截图，加上 5 个新主题各一张书桌和对话页、外观弹窗（`build/look_shots/10_*` 到 `22_*`）。真实 DeepSeek 的 E2E：第 14（记忆）、15（模板）、16（书桌）步按新界面改了找法；第 18 步模型有时把「Example Domain」翻成「示例域名」，现在两种都算对。
- 踩坑：`dart format -l 160` 不是这个项目的格式，会大面积改动旧代码，别用；Bash 里用 heredoc 写含反斜杠的脚本仍会丢反斜杠（这次在测试数据里把 `\b` 变成了退格符），脚本一律用 Write 写文件再 `node` 运行。

阶段 4（多模态 + Showcard 卡片）见下一节和 [v0.2-multimodal.md](v0.2-multimodal.md)。

## v0.2 阶段 4：多模态输入输出 + Showcard 卡片（2026-10-31）

细节、规范对照表和验证见 [v0.2-multimodal.md](v0.2-multimodal.md)。要点：

- **卡片按官方 Showcard 1.0 构建**（用户明确要求，不按调研报告发挥）。官方仓库 liliMozi/showcard 的规范逐条核对过；卡内运行时、占位层、注入代码原样拷贝在 `core/src/cards/showcard/`（不要手改）；官方 13 张一致性探针原样拷贝在 `core/test/fixtures/showcard-probes/`，在我们的宿主上全部通过。OpenHanako 其实没实现 1.0 协议。唯一偏差：宿主服务时把参考运行时的 5 秒应答时限换成 180 秒（授权框要等人点）。
- 后台：`core/src/cards/`（`cards.ts` 模块、`document.ts` 文档与 CSP、`bindings.ts` 宿主工具与授权单元、`shell.ts` 外壳页、`zip.ts`）；HTTP 和 WebSocket 共用一个端口（`server.ts`，只认 127.0.0.1/localhost 的 Host），`core.hello` 带 `port`。数据库第 7 版：`cards`、`card_grants`、`card_events`、`image_descriptions`。卡片包在 `%APPDATA%\DreamFlutter\cards\<id>\`。
- 看图转述 `modules/vision.ts`（只对不支持图片的模型）；文件转文字 `modules/documents.ts`（pdfjs-dist）和 `read_document` 工具；富内容渲染页 `render/renderer.ts`（Mermaid、Chart.js 在 `core/assets/render/`）；系统提示里的富内容说明在 `agent/host-text.ts`（dsh 原文不动）。
- 窗口：`webview_windows`（WebView2，纹理渲染，能截图）包在 `ui/web_surface.dart`（测试里返回 null）；`ui/card_view.dart`（对话里的卡片、授权框、权限、放大、导出、书桌卡片）；`state/cards.dart`（哪些卡是活的：最新的一张 + 最后点的一张；历史卡要点过才能用工具）；`ui/rich_blocks.dart`；输入框把文档转文字（`MentionKind.document`）；问题下面「图片由 X 转述」；设置「看图模型」；书桌新增「卡片」栏。
- 测试：后台 150 个（含官方探针、卡片、文档、看图）；窗口 66 个；真实窗口 `integration_test/cards_test.dart`。

调研报告：[research/deepseek-harness.md](research/deepseek-harness.md)（Codex）、[research/showcard.md](research/showcard.md)（Antigravity，Showcard 放阶段 4）。名画主题：用 Agent Bridge 的 Antigravity 调研，阶段 5 落地。

分工（用户要求）：后端设计和实现、问题排查尽量交给 Codex；广泛搜索和调研交给 Antigravity；都经 Agent Bridge。Agent Bridge（毕设文件夹 `mcp/agent-bridge`）在 2026-10-30 加了后台任务：长任务传 `background: true`，再用 `job_status`（可带 `wait_sec`）取结果；`codex_run` 的 `cwd` 传 `E:\claude\DreamFlutter` 就在本项目里运行。改完需要重启 Claude 才加载。

阶段 0、1、2 已完成（2026-10-30）：用户选了视觉方向 A「蛱蝶」（[v0.2-design.md](v0.2-design.md)，设计稿在 Artifact「DreamFlutter 视觉方向」 https://claude.ai/artifact/6YEFyrT1H7voDESb7SkvDf ），设计系统和对话页已按它重做，见下面各节。用户试用 v0.1.1 的反馈已整理在 v0.2-plan.md 第一节。视觉方向：用户在 2026-10-29 给出方向：参考 HanaAgent（openhanako），文艺、简洁、大气，融入蝴蝶元素，蝴蝶造型参考世界名画和艺术品；以后的主题都以世界名画和艺术品为主题。所有视觉参数集中在 `app/lib/theme.dart`（AppTokens / AppColors）。

## 架构（沿用）

```
Flutter 窗口 ──WebSocket(127.0.0.1 + 令牌)── core/（Node 后台，常驻，与窗口分离）
                                              ├─ Pi SDK 在进程内运行会话（每个会话一个 slot）
                                              ├─ SQLite（node:sqlite）：%APPDATA%\DreamFlutter\core.db
                                              └─ 功能模块：src/modules/*
```

- 后台入口 `core/src/main.ts`，Node 22 类型剥离直接跑 .ts。模块在 `core/src/app.ts` 里接入。
- 模块钩子（`CoreModule`）：`extensions`、`onSlotEvent`、`onSlotChanged`、`onRunStarted`、`onRunFinished`、`resolveTaskId`、`toolPolicy`、`start/stop`。
- 数据库迁移 `core/src/schema.ts`（只能往后追加），目前第 7 版：1 设置/确认卡/运行记录，2 会话索引/用量，3 记忆/提案，4 任务/写笺/资料/产物/上限卡片，5 定时任务/执行记录/交付记录，6 网关（渠道/Key/模型组/请求/额度），7 卡片/授权/卡片事件/图片转述。
- 窗口：`app/lib/state/agent_controller.dart`（会话、任务、收件箱计数、各页刷新信号 `libraryRevision` / `workRevision`），左侧导航 `app/lib/ui/home_page.dart`。

## v0.2 阶段 3b：模型网关、仪表盘、设置重组（2026-10-31）

用法（用户已确认）见 [v0.2-gateway.md](v0.2-gateway.md)。要点：

- 后台 `core/src/gateway/`：`gateway.ts`（渠道和模型组的存取、在 Pi 里注册、渠道流的包装、额度、`gateway.*` 方法）、`router.ts`（挑渠道，纯函数）、`health.ts`（熔断：限流等休息 30 秒起翻倍到 10 分钟；额度/余额休息到恢复时间或 30 分钟；Key 无效一直停用到用户修改）、`classify.ts`（按业务码和关键字分失败类型，额度用完多数也是 429）、`quota.ts`（DeepSeek/Kimi 余额、智谱/MiniMax 套餐额度）、`platforms.ts`（各平台地址，只改这一处）。数据库第 6 版。
- **渠道** = Pi 服务商 `df-<id>`，`streamSimple` 经过包装（选 Key、记录 `gateway_requests`、熔断）；Pi 自己配置的服务商以 `pi:<id>` 出现，只在被模型组用到时包装它的流。**模型组** = Pi 虚拟模型 `dreamflutter/<id>`；旧的备用链迁成模型组 `auto`（同一个模型键，旧会话照常），`ext/fallback.ts` 已删。
- **关键机制**：Pi 不重试额度、余额、Key 错误。经由模型组、还没输出内容时，包装把这类错误改写成「渠道「X」余额不足，换下一个渠道（service temporarily unavailable）」，Pi 重试时路由换渠道。是否经由模型组靠 sessionId 判断（路由时记下，请求的 options.sessionId 对上才改写）。直接选渠道里的模型时不改写。
- 后台小任务（标题、记忆）也能用模型组：`Llm.runtime()` 装上网关，`complete` 对模型组最多再试两次。
- 每月花费上限 `monthlyBudgetUsd`，暂停卡片类型 `limit_budget_month`。
- 窗口：`state/gateway_models.dart`，控制器 `gatewayChannels` / `modelGroups` / `providerLabel()`，事件 `gateway.changed` / `gateway.switched`（提示「已从 A 换到 B」）/ `gateway.alert`；`ui/gateway_pages.dart`（渠道列表和编辑页、模型组列表和编辑框）；`ui/dashboard_page.dart` 替换了用量统计页；`ui/settings_page.dart` 改成左侧分类 + 搜索；输入框模型菜单按「模型组 / 各渠道」分组。旧的服务商页保留为「Pi 配置」。
- 人工端到端：用户用 computer-use Agent 按 [testing/computer-use-e2e.md](testing/computer-use-e2e.md) 测，报告写到 `docs/test-reports/<日期>/report.md`（Agent 写不进项目目录时在它自己的输出目录），交回给 Claude 处理。
  - **2026-10-31 状态：没测完**（Codex 额度用完）。已通过：A1 欢迎页、A6 分叉、F1 渠道测试（可用 · 1461 毫秒）、重新生成后版本切换、仪表盘读余额 5.20 CNY；F8 按任务书跳过（模型没有价格）。其余未执行。
  - 踩过的坑（任务书已写进去）：Agent 在自己终端里 `flutter run` 会因沙箱读不到 AppData 而构建失败 → 改为双击已构建好的 `app\build\windows\x64\runner\Release\dreamflutter.exe`（改代码后要重新 `flutter build windows`）；微软拼音中文模式会吞掉自动输入的文字 → 先切「英」，文字用点输入框 + Ctrl+V 粘贴（已亲测可用）；审批框是被测应用的界面。
  - 测试文件夹 `E:\df-e2e\ws-a`（含 hello.txt）、`ws-b` 已建好，可以直接再测。
  - 脚本版 E2E（`integration_test/e2e_test.dart`，含第 23 步模型组自动换渠道）2026-10-31 最后一轮修复后重跑**全部通过**（约 1.5 分钟）；后台 121 个、窗口 62 个测试都通过。
- 真实检查：`cd core; node --disable-warning=ExperimentalWarning scripts/live-gateway.ts`（坏 Key 渠道 → 你的 DeepSeek，第二问命中缓存，后台调用经由模型组，读余额）。2026-10-31 通过。
- **只实测了 DeepSeek**（对话、余额接口）。智谱、Kimi、MiniMax 的地址、额度接口和错误码来自 Antigravity 调研，没有账号实测；用户有这些账号时先在仪表盘点「查询余额和额度」核对。
- 没做（设计稿里有）：通用里的「开机启动」「关窗口时」（需要原生支持，留到后面）；趋势图按渠道着色；花费按非高峰折扣计算。

## v0.2 阶段 3a：Agent 模式（2026-10-30）

按 DeepSeek Harness 的标准 / 极简预设在 Pi 里复现两种模式，细节和与 dsh 的差异见 [agent-modes.md](agent-modes.md)。要点：

- 后台：`core/src/agent/`（harness 扩展、dsh 原文、各工具）；`host.ts` 按会话模式加载；模式记在会话里（`df.agent_mode`），设置 `agentMode` 是新会话默认值；定时任务总用标准模式。
- 不再写用户的 `~/.pi/agent/settings.json`：压缩、重试设置用 SettingsManager 实例覆盖；`set_auto_compaction` 命令不再改 Pi 设置（自动压缩是后台设置 `autoCompaction`）。
- 审批：只读工具清单换成 dsh 的工具名；`pwsh` 按命令内容分类（`isReadOnlyCommand`）；定时任务里允许 `bash` 的旧计划同样允许 `pwsh`。
- 新命令：`df_agent_state`（模式、计划模式、待办）、`df_set_plan_mode`；新记录 `df_agent_state`（待办或计划模式变化时推给窗口）；`slot.open` 和 `new_session` 接受 `agentMode`。
- 窗口：输入框「标准 / 极简」切换、计划模式按钮、右栏待办、计划审阅和提问对话框、新工具的显示（pwsh 终端带用途说明、写入也显示差异、待办清单、计划卡片）；设置页「Agent 模式」。
- **Bash 工具的沙箱里启动不了 PowerShell**（ENOENT）：跑后台测试和 `scripts/live-modes.ts` 用 PowerShell 工具。
- 真实 DeepSeek 检查：`cd core; node --disable-warning=ExperimentalWarning scripts/live-modes.ts minimal standard [--task=twoturn]`。

**E2E 状态（2026-10-31）**：全部步骤（含极简模式、计划模式）用 DeepSeek 跑通。第 14 步（记忆页）改过：自动整理出的「待确认」卡片会把记忆库挤到屏幕下面，列表不构建看不见的项，所以先滚到「记忆库（」标题、等计数为 1、再滚到那条记忆。第 18 步（web_fetch）也改过：DeepSeek 读完网页后有时还想用 `pwsh` 抽标题（会正常请求审批），测试现在要求它不运行命令，若仍请求就确认请求的不是 web_fetch 再拒绝。

**切换工作区黑屏（2026-10-31 查清，不是应用的问题）**：是 E2E 第 8 步「关窗口」用 `pumpWidget(const SizedBox())` 造成的：没有 MaterialApp 时 Flutter 窗口画默认黑色，持续约 1 秒，紧跟在第 7 步切换工作区之后，看起来像切换时黑了一下。验证方法：用假后台经菜单来回切换工作区 16 次，同时用 PowerShell（CopyFromScreen + LockBits）每约 75 毫秒采样窗口客户区的黑色像素比例：切换期间 147 帧没有一个黑色像素，换成空组件的 1 秒里 12 帧有 11 帧全黑。已把那一步改成铺纸色（`AppColors.light.background`）。以后再查闪屏可以照这个办法：测试里打时间戳，采样器记 `毫秒,黑色比例`，按时间段对照。

## v0.2 阶段 2 后半（2026-10-30）

- **右栏三个标签**（`run_summary.dart`）：「本次运行」「书桌」（本工作区的写笺和资料，点一下附到下一条消息）「分支」（整棵提问树，分叉处缩进，点一个提问切到它所在的分支）。分支树来自后台新命令 `df_tree`（`core/src/slots/slot.ts` 的 `questionTree`：每个用户消息、它前一个提问、是否在当前分支、要切过去的叶子）。
- **附带资料**（`app/lib/state/mentions.dart`）：写笺、资料、拖进来或粘贴的文件/文件夹，发送时按后台书桌任务同样的格式附在消息末尾（`<写笺>`、`<资料>`，文件只给路径让 Agent 自己读，文字直接带上）；问题气泡和重新编辑时再拆回成小标签（`MentionChip`）。
- **输入框**：打 `@` 出书桌的写笺和资料；拖文件进输入框（`desktop_drop`）：图片在模型支持时直接附图，其他文件和文件夹附路径；Ctrl+V 时剪贴板里的图片和文件也会附上（`pasteboard`），文字照常粘贴。
- **数学公式**（`markdown_view.dart`，`flutter_math_fork`）：`$…$`、`\(…\)` 行内，`$$…$$`、`\[…\]` 单独成行；单个 `$` 要求内侧没有空格、右边不跟数字，所以「$5 和 $10」不会被当成公式；解析失败显示原文。
- **第一次打开**：新会话空状态里一张「开始之前」卡片（模型、工作区、试一个任务），点「知道了」后不再出现（偏好 `onboarded`）。不弹窗，不挡测试。
- **深色版检查**：新增 `integration_test/look_test.dart`，用假后台画一段脚本对话（思考、读取/命令/修改、表格、代码、公式），浅色和深色各截一组图到 `app/build/look_shots/`，不需要模型，约 10 秒：`flutter test integration_test/look_test.dart -d windows`。检查后深色对比度没问题。

## v0.2 阶段 2 前半（2026-10-30，用户选了 A「蛱蝶」）

- **设计系统**：`app/lib/theme.dart` 全部换成「蛱蝶」：纸绢底、墨色字、石绿强调、赭石、朱砂印；浅色和「墨夜」深色两套。字体用 Windows 11 自带的 Noto Serif SC（标题和回复正文）/ Noto Sans SC（界面），回退到雅黑/宋体。`ButterflyMark`（工笔蝴蝶，CustomPainter）和 `SealStamp`（梦蝶朱印）也在 theme.dart。`context.serif()`、`context.label` 是常用样式。
- **导航栏**：蝴蝶标志、对话/书桌/任务/记忆/技能，底部仪表盘（暂时打开用量统计页，阶段 3 换成真正的仪表盘）/外观/设置。
- **会话栏**：「对话」标题 + 工作区小标签（点开切换），石绿「新会话」，运行中的会话是呼吸点，底部竖排「栩栩然胡蝶也」和朱印（窗口够高时）。「Skills 与命令」移到了输入框的闪电按钮。
- **对话页**：三栏（会话栏 | 对话 | 右栏「本次运行」，右栏可收起，记在偏好里，窗口窄于 940 自动隐藏）。底部状态栏取消：模型和思考级别进了输入框，上下文用量变成输入框里的小圆环（点开是原来的上下文面板），压缩中/扩展状态显示在输入框上方。
- **回复的呈现**（`message_widgets.dart`）：两个问题之间的所有助手消息合成一行（`ChatRow` / `ReplyRow`）。思考和工具调用合成「过程」块（`WorkBlock`），一行总结「思考了 12 秒 · 读取 2 个文件 · 运行 1 条命令」，运行中展开、结束后收起；命令是终端样式（只显示最后 12 行，可展开），修改文件显示差异（用 Pi 返回的 `details.patch`，运行中用参数里的 edits），读取/搜索是一行、点开看输出。回复正文是宋体 15px、行高 1.85（`markdown_view.dart`），代码块有语言标签、复制按钮和高亮（`highlight` 包）。每条回复下面一行数据：模型 · 输入/输出/缓存 token · 首字延迟 · token/秒 · 耗时 · 花费 · 时间（实时计时只有窗口看着的回复才有，历史只显示 token 和时间）。
- **协议层**：`Transcript` 记录 turn_start / 首个 token / 结束时间和每段思考时长（可注入时钟测试）；工具结果带上 `details`。
- **动效**（`motion.dart`）：呼吸点、新内容淡入上移、流式输出的光标、过程块展开收起。
- **新会话空状态**：大蝴蝶、「今天想做点什么？」、三张「试试看」卡片（点了填进输入框）、工作区。


## v0.2 阶段 0（2026-10-30）

- **图片输入 bug**：根因是用户的 Pi 全局设置 `~/.pi/agent/settings.json` 里有 `images.blockImages: true`（Pi 终端里的「Block images」），Pi 发给模型前把每张图换成文字 "Image reading is disabled."。窗口 → 后台 → Pi 这几步都没丢图。修法：`core/src/pi/host.ts` 里对每个会话的 SettingsManager 覆盖 `getBlockImages = () => false`（不改用户的设置文件；用实例覆盖而不是 `applyOverrides`，因为设置重新加载会丢掉 overrides）。另外直接请求过 DeepSeek 接口，`deepseek-flash` 确实支持图片。回归测试：`core/test/slots.test.ts`「sends images to the model even when Pi's settings block them」（测试图片必须是真 PNG，Pi 会先解码缩放）；E2E 第 19 步发一张红色图片，问颜色。
- **AI 回复上的操作**：`message_widgets.dart` 的 `ReplyInfo.collect` 把两个问题之间的所有助手消息算一条回复，操作栏放在最后一条下面：复制（Markdown 原文）、重新生成（旁边下拉可换模型，换的模型之后一直生效）、版本切换 `‹ 1/2 ›`、从这里分叉（分叉到下一个问题之前；最后一条回复则复制整个会话）。最新回复的操作栏常显，旧的悬停或键盘聚焦时显示。
- **界面缩放**：`ui/zoom.dart` 的 `AppZoom` 包在 `MaterialApp.builder` 里，按 size/zoom 布局再整体放大绘制，对话框和菜单一起缩放；Ctrl + 加号/减号/0（`HardwareKeyboard` 全局处理），档位在 `Preferences.zoomLevels`，变化时顶部短暂显示「缩放 110%」。入口：导航栏底部新增「外观」按钮（缩放、文字大小、主题），设置页最上面也是「外观」。文字大小也由 `AppZoom` 一起设置。

## 本轮新增（2026-10-28 ~ 29）

- **界面**：左侧导航（对话 / 书桌 / 任务 / 记忆 / 技能 / 设置）。
  - 记忆页 `memory_page.dart`：待确认候选、可折叠的常驻记忆块（锁定）、记忆库（搜索、筛选、编辑、历史版本、导出、清空）、总开关和自动整理开关。
  - 技能与模板页 `library_page.dart`：技能启用/停用/查看/导入/删除，任务模板编辑器（`{{参数}}`）和运行表单，待确认的技能建议（可修改后保存）。
  - 对话页右上角菜单：存成技能、存为模板、查看用到的记忆、刷新记忆快照。每次运行下方有「本次运行」摘要（步骤、耗时、花费、改动的文件），书桌/模板任务顶部有任务横条。
  - 书桌 `desk_page.dart`：资料 / 写笺 / 任务 / 产物四栏；写笺编辑自动保存，「交给 Agent」选动作和资料后建任务，产物自动回到书桌。
  - 任务页 `tasks_page.dart`：待处理收件箱（批准操作、补充信息、上限卡片、候选记忆、技能建议、被中断任务、待批准的定时任务）、全部任务、定时任务（`schedules.dart`）。
  - MCP 页 `mcp_page.dart`（设置里进入）；设置里新增运行上限和「工作区里总是允许的工具」。
- **后台**：
  - `modules/tasks.ts`：每个会话都是任务；写笺/资料/产物；单次运行轮数上限和每日花费上限（超出暂停并出卡片，可继续）；统一收件箱 `inbox.list`。
  - `modules/scheduler.ts`：完整按草案 §8 实现，见文件头注释。到点由 15 秒一次的 tick 触发，`schedules.tick` 也可手动触发（测试用）。
  - `modules/web.ts`：`web_fetch` 工具（只读，免审批）。
  - `modules/mcp.ts`：表单编辑 Pi 的 `mcp.json`，密钥类值 DPAPI 加密，`pi mcp list --json` 检查连接。
  - 辅助模型修复：辅助模型 → 会话的模型 → 默认模型，只在有凭证的模型里选（之前会误用环境变量里的 Anthropic Key，导致自动标题和记忆整理全部失败）。

## 怎么运行应用

```bash
cd app
flutter run -d windows
```

如果编译时出现一大串 `'Matrix4' isn't a type`、`Undefined name 'immutable'` 之类的错误，是测试留下的编译缓存坏了，先 `flutter clean` 再运行（只删除生成的 build 和 .dart_tool）。关窗口不会停后台，换了后台代码后要从托盘完全退出一次。

另外：这个环境里 WebSearch / WebFetch 用不了（它们走一个当前不可用的模型），查资料用内置浏览器（get_page_text）。

## 怎么跑测试

```bash
# 后台测试：199 个（含官方 Showcard 一致性探针），用 Pi 自带的假模型，不联网（要在 PowerShell 里跑：Bash 沙箱启动不了 PowerShell）
cd core && npm test && npx tsc --noEmit
# 窗口单元/组件测试：95 个
cd app && flutter test test
# 场景巡检（v0.3.3）：真窗口、假后台、约 1 分钟：阅读、选字（四档缩放）、拖放、全部页面和主题；清单见 docs/testing/scenarios.md
cd app && flutter test integration_test/scenarios_test.dart -d windows
# 视觉检查：假后台、不联网、约 40 秒（对话页 + 各页面 + 每个主题），截图在 app/build/look_shots/
cd app && flutter test integration_test/look_test.dart -d windows
# Dart 协议层，含启动真实后台的测试
cd packages/pi_rpc && dart test -x integration
# 真实窗口端到端：走用户在应用里配好的 OpenCode Go 渠道（deepseek-v4.1-flash），约 3 分钟；用户的应用要先退出（等待超时会存 zz_timeout.png），截图在 app/build/e2e_shots/（00~31），跑的时候不要最小化窗口
cd app && flutter test integration_test/e2e_test.dart -d windows
# 卡片与富内容（真实 WebView2）：不联网约 10 秒；加 --dart-define=CARDS_MODEL=true 用 DeepSeek 真做卡片和图（约 1.5 分钟），截图在 app/build/card_shots/
cd app && flutter test integration_test/cards_test.dart -d windows
```

## 代码审查（2026-10-29，Codex 只读审查 core/src）

18 个问题全部修复，回归测试在 `core/test/review-fixes.test.ts`、`server.test.ts`、`skills.test.ts`、`tools.test.ts`。要点：

- 列技能时遵守工作区信任（不信任的项目不加载其资源和包）；技能读取/删除按真实路径判断；模板名、技能建议改名都校验，防止路径穿越。
- 定时任务里由调度器先判断工具（记忆工具只能提候选，不能直接写入）。
- 凭证备份文件不再保留明文 Key；MCP 改名时加密值跟着迁移。
- 单实例锁原子创建；同一会话文件并发打开只起一个运行时；打开中的会话可以被关闭。
- 调度器同一计划的启动串行化；被上限暂停的定时运行在卡片处理后正确结束或继续；长时间关机后补做的时间点准确。
- 停止运行会关闭审批弹窗；首轮就中断的任务能恢复；每日花费上限计入正在运行的花费；畸形请求不再抛异常；卡住的通知进程会被结束。

## 踩过的坑（重要）

v0.3.3 起，踩坑和开发规范统一整理在 [dev-guide.md](dev-guide.md)，新坑写在那里。下面是原来的记录，保留备查。

- 在 Bash 工具里用 node -e / sed 写含反斜杠的代码，转义会被吃掉（`\n` 变成真换行）；这类改动用 Edit / Write。
- 第一次构建带 webview_windows 的应用会下载 nuget.exe 和 WebView2 SDK，日志里的「Nuget is not installed」是正常提示。
- 真实窗口测试里让模型做卡片时，它可能先用 write 写文件而弹出审批框；测试里把审批模式设为 off。

- 后台必须先配置 Pi 的网络层（`core/src/pi/http.ts`），否则第一次请求 Connection error。
- 测试里要关掉自动标题和自动提取记忆（harness 已关），否则会抢走假模型预设的回复。
- Pi 模板没有裸写的 `${1}`，参数要写成 `${1:-}`。
- 假模型的错误信息里带 "rate limited" 会触发 Pi 自己的自动重试，测试定时任务重试时要用别的错误信息。
- E2E 注意：
  - 自动标题现在能用了，会话标题会被改名，按标题找会话要用当前标题（`agent.sidebar`）。
  - IndexedStack 里没显示的页面也能被 finder 找到；导航按钮用 `nav('名称')`（导航栏在最前），页面里的元素用 `find.descendant(of: find.byType(某页面) …)`。
  - 切换 Tab 后先 `pumpAndSettle()` 再点按钮。
  - 模型可能连续请求多次审批（先 bash 再 write），要循环处理。
  - 「存为模板」那一步会写进用户真实的 Pi 提示词目录，测试最后会删掉 `e2e周报`。
- agent-bridge 的项目根是别的目录（毕设文件夹），审查/改代码直接用 `codex exec -s read-only -C E:\claude\DreamFlutter`。
- 本机唯一的 node 是 Hermes 自带的 v22.23.2。
- 不允许 `rm -rf` 通配目录，清理交给用户。
- **e2e 的 Flutter 语义树错误**（2026-11-03）：`e2e_test` 36 步全部走通，但开头就有一个 `_RenderObjectSemantics._updateSemanticsNodeGeometry` 的 `Null check operator`（Flutter 框架内部），测试因此判失败。v0.2 时没有。没有任何测试打开语义树，猜是 Windows 上有辅助功能 / 自动化程序时引擎自己打开的；离线的 look 页面强制打开语义树复现不了，所以和真实后台那一段流程有关。用读屏软件的用户可能碰到，0.4 做外壳时查（先在 e2e 里逐步加 `tester.ensureSemantics()` 二分出是哪一步）。
- 在 Bash 里拼含 `${...}` 的 Dart 代码会被 shell 吃掉，改代码用脚本文件（放 scratchpad）或 Edit。还有：跑测试的同时别临时换掉源文件（拆提交时这样做过，导致一批测试读到旧文件失败）。

## 未做 / 可选

- 计划里的「可选」项都没做：B7 订阅登录、B8 本地模型、C7 标签批量、C8 文件检查点、D8 压缩前保存记忆、G5 网页资料与资料地图、H11 手机通知、I3 网页搜索。
- （已做，v0.2 阶段 5）定时任务可以「接着同一个会话」运行：编辑框里选，或对话页菜单「定时接着做」。
- 定时任务产生的会话会出现在对话侧栏里（可以打开看过程），以后可以考虑单独分组。
