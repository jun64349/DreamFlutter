# DreamFlutter 开发交接（v0.1.1 → v0.2）

更新时间：2026-11-01（v0.2.0 发布）
当前分支：`main`（v0.1.0、v0.1.1、v0.2.0 都已打 tag；v0.2 做了什么见 [v0.2-release-notes.md](v0.2-release-notes.md)；接下来按 [roadmap.md](roadmap.md) 做 v0.3–v0.9）

**下一步**：E2E 改成复用用户在应用里配好的 OpenCode Go 渠道（用户 2026-11-01 决定以后测试都走 OpenCode Go；不要在测试里新建渠道），然后开始 v0.3。

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

v0.2 的 6 个阶段都已完成，2026-11-01 打 tag v0.2.0（阶段 6：Codex 审查修复、全量测试、真实 DeepSeek E2E 通过）。用户 2026-10-31 决定不再做 computer-use 人工测试。

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
- 数据库迁移 `core/src/schema.ts`（只能往后追加），目前第 5 版：1 设置/确认卡/运行记录，2 会话索引/用量，3 记忆/提案，4 任务/写笺/资料/产物/上限卡片，5 定时任务/执行记录/交付记录。
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
# 后台测试：151 个（含官方 Showcard 一致性探针），用 Pi 自带的假模型，不联网（要在 PowerShell 里跑：Bash 沙箱启动不了 PowerShell）
cd core && npm test && npx tsc --noEmit
# 窗口单元/组件测试：70 个
cd app && flutter test test
# 视觉检查：假后台、不联网、约 40 秒（对话页 + 各页面 + 每个主题），截图在 app/build/look_shots/
cd app && flutter test integration_test/look_test.dart -d windows
# Dart 协议层，含启动真实后台的测试
cd packages/pi_rpc && dart test -x integration
# 真实窗口端到端：用 DeepSeek，约 4~5 分钟（等待超时会存 zz_timeout.png），截图在 app/build/e2e_shots/（00~31），跑的时候不要最小化窗口
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

## 未做 / 可选

- 计划里的「可选」项都没做：B7 订阅登录、B8 本地模型、C7 标签批量、C8 文件检查点、D8 压缩前保存记忆、G5 网页资料与资料地图、H11 手机通知、I3 网页搜索。
- 定时任务目前只支持「每次新会话」，后台支持绑定会话（`sessionMode: bound`），界面还没有入口。
- 定时任务产生的会话会出现在对话侧栏里（可以打开看过程），以后可以考虑单独分组。
