# DreamFlutter 开发交接（v0.1.1 → v0.2）

更新时间：2026-10-30
当前分支：`main`（v0.1.0、v0.1.1 都已打 tag；下一阶段是 v0.2，计划见 [v0.2-plan.md](v0.2-plan.md)）

## 一句话现状

[v0.1.1-plan.md](v0.1.1-plan.md) 的 6 个阶段的「必做」项都已完成并有测试：

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | 后台地基（A1–A6、索引底座） | 完成 |
| 2 | 供应商与会话（B1–B6、C1–C6） | 完成 |
| 3 | 记忆与技能（D1–D7、E1–E3），含界面 | 完成 |
| 4 | 任务、卡片、书桌、运行上限（F1–F6、G1–G4） | 完成 |
| 5 | 定时任务（H1–H10） | 完成 |
| 6 | MCP 管理页、`web_fetch`（I1–I2） | 完成 |
| 7 | 可选项 | 未做 |
| 8 | 审查 → 修复 → 全量测试 → 发布 | Codex 审查的 18 个问题已全部修复并加了回归测试；全量测试和 E2E 通过；未打 tag |

下一步：**v0.2**。阶段 0 已完成（2026-10-30，见下面「v0.2 阶段 0」）。阶段 1 的调研、信息架构和三套视觉方向已完成，写在 [v0.2-design.md](v0.2-design.md)，设计稿在 Artifact「DreamFlutter 视觉方向」（https://claude.ai/artifact/6YEFyrT1H7voDESb7SkvDf ）。**等用户选方向**（A 蛱蝶 / B 草间 / C 图谱，或混搭），选定后进入阶段 2（设计系统落地 + 对话页重做）。用户试用 v0.1.1 的反馈已整理在 v0.2-plan.md 第一节。视觉方向：用户在 2026-10-29 给出方向：参考 HanaAgent（openhanako），文艺、简洁、大气，融入蝴蝶元素，蝴蝶造型参考世界名画和艺术品；以后的主题都以世界名画和艺术品为主题。所有视觉参数集中在 `app/lib/theme.dart`（AppTokens / AppColors）。

## 架构（沿用）

```
Flutter 窗口 ──WebSocket(127.0.0.1 + 令牌)── core/（Node 后台，常驻，与窗口分离）
                                              ├─ Pi SDK 在进程内运行会话（每个会话一个 slot）
                                              ├─ SQLite（node:sqlite）：%APPDATA%\DreamFlutter\core.db
                                              └─ 功能模块：src/modules/*
```

- 后台入口 `core/src/main.ts`，Node 22 类型剥离直接跑 .ts。模块在 `core/src/app.ts` 里接入。
- 模块钩子（`CoreModule`）：`extensions`、`onSlotEvent`、`onSlotChanged`、`onRunStarted`、`onRunFinished`、`resolveTaskId`、`toolPolicy`、`start/stop`。
- 数据库迁移 `core/src/schema.ts`（只能往后追加），目前第 5 版：1 设置/确认卡/运行记录，2 会话索引/用量，3 记忆/提案，4 任务/写笺/资料/产物/上限卡片，5 定时任务/执行记录/交付记录。
- 窗口：`app/lib/state/agent_controller.dart`（会话、任务、收件箱计数、各页刷新信号 `libraryRevision` / `workRevision`），左侧导航 `app/lib/ui/home_page.dart`。

## v0.2 阶段 2 前半（2026-10-30，用户选了 A「蛱蝶」）

- **设计系统**：`app/lib/theme.dart` 全部换成「蛱蝶」：纸绢底、墨色字、石绿强调、赭石、朱砂印；浅色和「墨夜」深色两套。字体用 Windows 11 自带的 Noto Serif SC（标题和回复正文）/ Noto Sans SC（界面），回退到雅黑/宋体。`ButterflyMark`（工笔蝴蝶，CustomPainter）和 `SealStamp`（梦蝶朱印）也在 theme.dart。`context.serif()`、`context.label` 是常用样式。
- **导航栏**：蝴蝶标志、对话/书桌/任务/记忆/技能，底部仪表盘（暂时打开用量统计页，阶段 3 换成真正的仪表盘）/外观/设置。
- **会话栏**：「对话」标题 + 工作区小标签（点开切换），石绿「新会话」，运行中的会话是呼吸点，底部竖排「栩栩然胡蝶也」和朱印（窗口够高时）。「Skills 与命令」移到了输入框的闪电按钮。
- **对话页**：三栏（会话栏 | 对话 | 右栏「本次运行」，右栏可收起，记在偏好里，窗口窄于 940 自动隐藏）。底部状态栏取消：模型和思考级别进了输入框，上下文用量变成输入框里的小圆环（点开是原来的上下文面板），压缩中/扩展状态显示在输入框上方。
- **回复的呈现**（`message_widgets.dart`）：两个问题之间的所有助手消息合成一行（`ChatRow` / `ReplyRow`）。思考和工具调用合成「过程」块（`WorkBlock`），一行总结「思考了 12 秒 · 读取 2 个文件 · 运行 1 条命令」，运行中展开、结束后收起；命令是终端样式（只显示最后 12 行，可展开），修改文件显示差异（用 Pi 返回的 `details.patch`，运行中用参数里的 edits），读取/搜索是一行、点开看输出。回复正文是宋体 15px、行高 1.85（`markdown_view.dart`），代码块有语言标签、复制按钮和高亮（`highlight` 包）。每条回复下面一行数据：模型 · 输入/输出/缓存 token · 首字延迟 · token/秒 · 耗时 · 花费 · 时间（实时计时只有窗口看着的回复才有，历史只显示 token 和时间）。
- **协议层**：`Transcript` 记录 turn_start / 首个 token / 结束时间和每段思考时长（可注入时钟测试）；工具结果带上 `details`。
- **动效**（`motion.dart`）：呼吸点、新内容淡入上移、流式输出的光标、过程块展开收起。
- **新会话空状态**：大蝴蝶、「今天想做点什么？」、三张「试试看」卡片（点了填进输入框）、工作区。

还没做（阶段 2 后半）：右栏的「书桌」「分支」标签和分支树、输入框拖放/粘贴文件和 @ 书桌资料、数学公式、首次打开的引导、深色版的检查。

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
# 后台测试：87 个，用 Pi 自带的假模型，不联网
cd core && npm test && npx tsc --noEmit
# 窗口单元/组件测试：50 个
cd app && flutter test test
# Dart 协议层，含启动真实后台的测试
cd packages/pi_rpc && dart test -x integration
# 真实窗口端到端：用 DeepSeek，约 4~5 分钟（等待超时会存 zz_timeout.png），截图在 app/build/e2e_shots/（00~31），跑的时候不要最小化窗口
cd app && flutter test integration_test/e2e_test.dart -d windows
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

## 未做 / 可选

- 计划里的「可选」项都没做：B7 订阅登录、B8 本地模型、C7 标签批量、C8 文件检查点、D8 压缩前保存记忆、G5 网页资料与资料地图、H11 手机通知、I3 网页搜索。
- 定时任务目前只支持「每次新会话」，后台支持绑定会话（`sessionMode: bound`），界面还没有入口。
- 定时任务产生的会话会出现在对话侧栏里（可以打开看过程），以后可以考虑单独分组。
