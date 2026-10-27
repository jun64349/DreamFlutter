# DreamFlutter 架构设计

> 基于 Pi Agent 原生 Runtime 的个人 Agent 桌面客户端。
> 状态：**v0.1.0**（M1 + M2）已完成并通过端到端验收。最后更新：2026-10-27

## 1. 已确定的决策

| 决策 | 结论 | 理由 |
|---|---|---|
| GUI 技术栈 | Flutter Desktop（先 Windows） | 轻量、原生性能、跨平台 |
| 对接方式 | `pi --mode rpc` 子进程，JSONL over stdio | 进程隔离、官方稳定协议、任何语言可接 |
| Pi 版本 | `@earendil-works/pi-coding-agent@1.4.0`，锁定在 `runtime/` | Pi 迭代快（已改过包名），升级需显式进行并回归 fixtures |
| 能力扩展方式 | 一律做成 Pi 扩展 / Skill / 提示模板，不写进 GUI | 不重复造轮子；TUI 与 GUI 共用同一套能力 |
| 状态管理 | Flutter 自带的 ChangeNotifier + InheritedNotifier，没有用 Riverpod | 核心状态只有一个控制器，引入框架的收益抵不上复杂度 |

## 2. 分层

```
app/                              Flutter Windows 应用
├── lib/theme.dart                所有视觉设定（颜色、字体、圆角、间距），视觉改版只改这里
├── lib/state/
│   ├── agent_controller.dart     多会话管理：哪个会话在前台、何时复用或新开进程、侧栏列表、
│   │                             工作区、设置、后台回收
│   ├── session_runtime.dart      一个会话 = 一个 Pi 进程：消息流、模型、统计、扩展弹窗、
│   │                             压缩、分叉、复制、重命名
│   ├── project_trust.dart        工作区信任判断（见 §5）
│   └── preferences.dart          记住的选择 + 写给 Pi 扩展读取的设置文件
└── lib/ui/                       侧栏、聊天区、输入框、消息组件、设置页、上下文面板、
                                  Skills 面板、扩展弹窗（含工具审批）

packages/pi_rpc/                  纯 Dart 包，唯一接触协议的层（dart test 即可测，不依赖 Flutter）
├── jsonl.dart                    按字节 LF 分帧，再 UTF-8 解码；坏行不会中断流
├── events.dart / messages.dart / models.dart   协议类型（sealed class + 未知类型兜底）
├── client.dart                   PiRpcClient：启动进程、id 关联、超时、事件流、扩展 UI 回复、
│                                 压缩 / 分叉 / 复制等命令
├── transcript.dart               把事件流折叠成可显示的消息列表和工具状态
├── session_store.dart            直接读会话 JSONL 文件列出历史会话；删除（移到回收站）
└── launcher.dart                 找 node、Pi CLI，以及 Windows 上正确的 Git Bash

runtime/                          锁定版本的 Pi（npm）
├── extensions/dreamflutter-approval.ts   工具审批扩展（随每个 Pi 进程用 --extension 加载）
├── scripts/                      冒烟脚本：rpc-smoke.mjs、approval-smoke.mjs
└── fixtures/                     录制的真实协议记录（单元测试数据）

~/.pi/agent/                      Pi 自己的配置、模型、凭证、会话、skills、extensions、trust.json
%APPDATA%\DreamFlutter\pi-settings.json   GUI 写、审批扩展读的设置（目前只有审批模式）
```

## 3. 多会话并行（M2）

**一个运行中的会话 = 一个 Pi 进程**，切走不会中断它。为了不浪费进程，复用规则是：

| 操作 | 当前会话空闲 | 当前会话正在运行 |
|---|---|---|
| 新会话 | 在同一个进程里 `new_session`（快） | 当前会话留在后台继续跑，新开一个进程 |
| 打开历史会话 | 该会话已有进程 → 直接切过去；否则同进程 `switch_session` | 同上；没有进程就带 `--session` 新开一个 |

- 新开的进程一启动就切到前台，显示启动转圈，不会让旧会话的内容停留在新工作区的标题下。
- 后台会话：侧栏转圈 = 运行中；手形 = 在等你确认（并弹出提示）；蓝点 = 后台跑完了还没看；状态栏显示「后台运行 N 个」。
- 回收：后台**空闲**超过 5 分钟的进程会被关闭（会话内容在磁盘上，点开会重新加载）；运行中的从不回收；进程数超过 8 个时先关最久没用的空闲进程。

## 4. RPC 能力映射

| GUI 功能 | RPC |
|---|---|
| 发送消息 / 图片 | `prompt`（`images` 为 base64；运行中带 `streamingBehavior: steer` 即「插话」） |
| 停止 | `abort` |
| 流式渲染 | `message_update`（增量）→ `message_end`（权威完整消息，替换增量结果） |
| 一轮结束 | `agent_settled`（不能用 `agent_end`，它之后还可能重试或压缩） |
| 工具卡片 | `tool_execution_start / update / end` |
| 模型与思考级别 | `get_available_models`、`set_model`、`get_available_thinking_levels`、`set_thinking_level` |
| 状态栏、上下文面板 | `get_state`、`get_session_stats`（tokens、费用、上下文占用、消息计数） |
| 手动压缩 / 自动压缩开关 | `compact`（可带 `customInstructions`）、`set_auto_compaction` |
| 新建 / 打开会话 | `new_session`、`switch_session`，或启动参数 `--session` |
| 历史会话列表 | **RPC 没有对应命令** → 直接读 `~/.pi/agent/sessions/<cwd编码>/*.jsonl` |
| 分叉 / 复制会话 | `get_fork_messages` + `fork`（返回原消息文本，放回输入框）、`clone` |
| 重命名 | `set_session_name` |
| 删除会话 | RPC 没有 → GUI 把会话文件移到回收站 |
| 斜杠命令 / Skills | `get_commands`，以 `/name` 通过 `prompt` 触发 |
| 扩展弹窗 | `extension_ui_request` ↔ `extension_ui_response`（select / confirm / input / editor 显示为对话框；notify → 提示条；setStatus → 状态栏；setWidget → 输入框上方；set_editor_text → 填入输入框） |

## 5. 安全：工具审批与工作区信任

**工具审批**由 Pi 扩展 `runtime/extensions/dreamflutter-approval.ts` 完成，GUI 只负责显示对话框：

- 扩展在 `tool_call` 钩子里按模式决定要不要问：全部放行 / **修改和命令需确认（默认）** / 全部需确认。只读工具（read、grep、find、ls）在默认模式下不问。
- 用 `ctx.ui.select` 提问，选项是「允许 / 本会话内总是允许该工具 / 拒绝」。没回答或取消一律拦下（fail closed）。
- 模式写在 `%APPDATA%\DreamFlutter\pi-settings.json`，扩展每次调用都重新读，所以改设置立即生效，不用重启会话。
- 因为是标准 Pi 扩展，在终端里用 Pi 时也可以加载它。

**工作区信任**：工作区里有 Pi 项目配置（`.pi/settings.json`、`.pi/skills`、`.pi/extensions`、`.agents/skills` 等）时，Pi 需要先决定是否信任。实测 RPC 模式下 Pi 启动时扩展还没有界面通道（`hasUI` 为 false），Pi 会**默默跳过**这些配置。所以由 GUI 在启动 Pi 之前处理：

1. 用和 Pi 相同的规则（`core/trust-manager.js`）判断是否需要信任；
2. Pi 的 `~/.pi/agent/trust.json` 里已经有决定（含上级目录）就交给 Pi 自己处理；
3. 否则弹窗问你：信任并记住 / 仅这次信任 / 这次不信任 / 不信任并记住。「记住」写入 Pi 自己的 trust.json，终端里的 Pi 也认；然后用 `--approve` 或 `--no-approve` 启动。

## 6. 已验证的事实

由 `runtime/scripts/*.mjs` 和集成测试验证，真实记录保存在 `runtime/fixtures/*.jsonl`：

- 事件顺序：`agent_start → turn_start → message_start/update*/end → tool_execution_start/end → turn_end → … → agent_end → agent_settled`。
- 事件流里有 `role: "system"` 的消息（系统提示词分段），界面不显示。
- 默认模型来自 Pi 的设置与环境，不一定是你想用的；GUI 记住你的选择，新会话启动后显式 `set_model`。
- 分帧：stdout 按 LF 切分，不能用 Node 的 `readline`（它把 U+2028/U+2029 也当换行）。
- 手动压缩：Pi 只压缩「完整的较早轮次」，一个会话只有一轮对话时会返回 `Nothing to compact`，界面显示为「会话内容还不多，暂时不需要压缩」。默认保留最近 20k tokens 不压缩（`compaction.keepRecentTokens`）。
- 审批扩展：在真实 Pi 上验证了「弹出选择 → 回答拒绝 → 工具被拦下，模型收到拒绝原因」。

## 7. Windows 注意事项

- Pi 的 `bash` 工具按 `shellPath` 设置 → `%ProgramFiles%\Git\bin\bash.exe` → PATH 上的 `bash.exe` 的顺序找 Bash。本机没有标准 Git for Windows，而系统 PATH 里有 `System32\bash.exe`（WSL 启动器）。GUI 启动 Pi 时会找到 `git.exe` 对应的 Git Bash 并放到 PATH 最前面。
- Pi 要求 Node ≥ 22.19（本机 22.23）。分发给别人时再考虑随包内置便携版 Node。
- 构建工具链：Flutter 3.47.8 / Dart 3.13.7（`E:\dev\flutter`），VS 2022 生成工具 17.14 + MSVC 14.44（`E:\dev\VSBuildTools2022`）。构建带插件的应用需要开启 Windows「开发人员模式」。
- MSBuild 受 260 字符路径限制，Flutter 工程要放在短路径下。
- 本机系统代理（127.0.0.1:12450）访问微软 CDN 很慢，升级 VS 组件时先切直连。

## 8. 测试体系

| 层级 | 位置 | 内容 | 调用模型 |
|---|---|---|---|
| 协议单元测试 | `packages/pi_rpc/test` | 分帧边界、协议类型、客户端 id 关联/错误/超时/退出、真实 fixtures 回放折叠、会话文件读取与删除（35 个） | 否 |
| 协议集成测试 | `packages/pi_rpc/test/integration_test.dart` | 启动真实 Pi：查询、错误、新会话、关闭；设 `PI_RPC_LIVE_MODEL` 后再跑一轮真实对话（5 个） | 可选 |
| 审批扩展冒烟 | `runtime/scripts/approval-smoke.mjs` | 真实 Pi 加载扩展，验证弹窗与拒绝拦截 | 是 |
| 应用单元/组件测试 | `app/test` | 控制器（单会话、并行会话、回收、扩展弹窗、图片、压缩、分叉、删除、审批设置文件）、工作区信任规则、审批对话框只关一次的回归测试（26 个） | 否 |
| 端到端验收 | `app/integration_test/e2e_test.dart` | 真实窗口 + 真实 Pi + 真实模型：工作区信任弹窗 → 读文件 → 后台长文 + 新会话 → bash 审批 → 切回后台会话并停止 → 分叉 → 手动压缩 → Skills 面板 → 设置页 → 切换工作区；截图在 `app/build/e2e_shots/` | 是 |

端到端测试的经验：
- 测试窗口**不能最小化**（最小化后 Flutter 不出帧，测试会一直等）；被挡住没关系。
- 点过别的控件后输入框会失焦，测试要先点输入框再输入。
- 列表是懒加载的，要点的内容滚出屏幕时，测试要先滚回去。
- 模型不一定按提示行事（被要求「直接写」时仍可能调用工具），断言只依赖协议层面的事实。

端到端测试找出并修复的真实问题：回答审批对话框后，对话框在关闭动画里又执行了一次「关闭」，把主页面也关掉了，导致白屏；切换工作区时旧会话内容短暂留在新工作区标题下；设置页的开关和单选项点击效果不可见。

## 9. 里程碑

- **M0 技术验证** ✅：锁定版本的运行时、裸 JSONL 客户端、真实 fixtures。
- **M1 端到端闭环** ✅：流式聊天（文本 / 思考 / 工具卡片）、停止、插话、模型和思考级别、新建 / 列出 / 恢复会话、状态栏统计、崩溃提示与重启。
- **M2 原生能力补全** ✅（v0.1.0）：
  1. 多会话并行：运行中新建或切换会话，原会话在后台继续跑（§3）。
  2. 工作区管理：显眼的切换入口、最近使用的工作区、打开其他文件夹、在资源管理器中显示。
  3. 设置页：默认模型与思考级别、服务商概况与配置文件夹、重新加载 Pi 配置、审批模式、自动压缩默认值、主题、文字大小、运行环境诊断、版本。
  4. 上下文管理：占用详情与消息统计、手动压缩（可附加要求）、本会话自动压缩开关、快满时提醒、压缩记录显示在对话里。
  5. 扩展弹窗与工具审批、工作区信任（§5）、`/` 命令补全与 Skills 面板、图片输入、从消息分叉、复制会话、重命名、删除（回收站）。
- **视觉设计**（下一步）：3～4 种风格方向供选择，选定后通过 `theme.dart` 统一换上。
- **M3 个性化**：自有扩展和 Skill 包（记忆、自定义工具、MCP）、导出。
- **M4 平台化**：定时任务、多 Agent、远程访问。

## 10. 已定与待定

- 已定：默认模型 DeepSeek（`cc-switch-deep-seek/deepseek-flash`，用户选过别的模型后以用户选择为准）；默认审批模式「修改和命令需确认」；v0.1.0 完成后再建 git 仓库。
- 待定：Agent 定位偏写代码还是通用个人助理（影响默认工具集和系统提示词）。
- 已知限制：会话树只做到「分叉 / 复制 + 侧栏标记」，Pi 的 RPC 没有在同一会话内切换分支的命令，所以没有做分支树的图形化浏览；应用目前依赖仓库里的 `runtime/` 目录和本机 Node.js，还不是可单独分发的安装包。
