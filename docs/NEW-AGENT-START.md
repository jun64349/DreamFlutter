# 新 Agent 接手须知（换平台用，2026-11-14）

> **到 1.0 的最后路线（用户 2026-11-17 定，唯一有效顺序，不要另起规划）**：0.13.0（已完成）→ 0.13.1 修真实验证剩余问题 → 完整安装与升级验证 → 性能与包体瘦身、启动速度、安装流程 → 降低上手门槛 → 1.0 preview 打包推送 → preview 阶段做朋友内测 → 1.0 正式版。详表见 [roadmap 页首★节](roadmap.md)。本文第五节「到 1.0 还要做的事」是旧写法，以这里为准。
>
> **2026-11-19 当前状态**：路线第 0–5 步完成，第 6 步朋友内测进行中。内测包 `dist/beta.1`（激活码一步、只走随想 GPT Pro、不露出中转站、不检查更新，设计 [beta-pool](design/beta-pool.md)）已交用户自己发给朋友。修了「装在盘符下一级文件夹时卸载卡住、删不干净」后发了 **1.0.0-preview.2**（标签 `v1.0.0-preview.2`，GitHub 最新发布 https://github.com/jun64349/DreamFlutter/releases/tag/v1.0.0-preview.2 ）。文档 2026-11-19 整理过，总目录见 [docs/README.md](README.md)。先读 [HANDOFF](HANDOFF.md) 顶部。

> **可直接复制给下一窗口的开工提示**：
>
> ```text
> 在 E:\claude\DreamFlutter 接手 DreamFlutter。先按顺序读 docs/NEW-AGENT-START.md 顶部、AGENTS.md、docs/HANDOFF.md 顶部「下一窗口从这里开始」、docs/roadmap.md 页首★节和 docs/dev-guide.md；文档总目录在 docs/README.md。1.0.0-preview.2 已发布，朋友内测进行中（内测包设计见 docs/design/beta-pool.md）；照到 1.0 的最后路线做，内测反馈怎么处理先问用户。推送、标签、合并、发布每次都要用户同意。跟用户一律说平实的中文。
> ```

> 2026-11-14 到 11-18 各次交接时写在这里的状态摘要（都已过时）挪到了 [history/接手须知-旧状态摘要](history/接手须知-旧状态摘要.md)。


> 用户从 2026-11-14 起换一个 Agent 平台，把 DreamFlutter 一直开发到 **1.0 正式发布**。本文把之前只记在 Claude 私人记忆里的规矩和经验搬进仓库，接手的 Agent 先读完本文，再读 `docs/HANDOFF.md` 最上面两段。
> 读的顺序：本文 → `AGENTS.md` → `docs/HANDOFF.md`（顶部）→ `docs/design/v1-redesign-spec.md` → `docs/roadmap.md`（第一节、v0.13、v1.0）→ `docs/dev-guide.md`。

---

## 一、项目是什么

- **DreamFlutter（梦蝶）**：用户自己的 AI 助手桌面软件，Windows。两个空间：
  - **工作台**：用户主导的对话、改文件、跑命令；
  - **蝶君**：自主的助手，像真人一样，在 WSL 沙箱里干活，会主动找用户。
- **技术**：
  - 窗口是 Flutter Desktop（`app/`），协议层在 `packages/pi_rpc/`；
  - 后台是 Node/TypeScript（`core/`），内嵌 Pi SDK（`@earendil-works/pi-coding-agent`）；
  - 两边通过本地带令牌的 WebSocket 通信，窗口关了后台的会话照样跑。
  - 架构见 `docs/architecture/architecture.md`，接口见 `docs/api/README.md`。
- **用户的模型**：DeepSeek 等，配置在 DreamFlutter 自己数据目录下的 Pi `models.json`，不在 `~/.pi/agent`。不要用开发环境里继承来的其他平台密钥做测试。

## 二、用户是谁、怎么和他合作

- **用户不是程序员**，是做可靠性系统工程和测试的。
  - **跟用户说话一律用平实的中文**：进度、提问、总结、最后的报告都用中文。之前两次漂成英文，被用户点名。代码注释照代码原来的风格。
  - 给用户命令时写完整，先 `cd` 到目录，比如 `cd E:\claude\DreamFlutter\app`。
- **用户最在意的三件事**：
  1. **以前提过的要求一条都不能丢。** 动界面前，对照 `docs/roadmap.md`（尤其 11.2 和附录 D）和过去的测试报告，不能只看最新的设计文档。设计文档和用户早先的要求冲突时，问用户。
  2. **界面要和原型一模一样。** 0.12.0-test.1 被打回，原话是「跟你做的原型差距太大了」。验收方法：真窗口灌和原型**完全相同的演示数据**，按原型尺寸截图，和原型并排对照，浅色、深色都对过才算完。不要拿测试样本数据去对原型，那样看不出差距。
  3. **交付前自己先把场景走一遍。** 用户实测一个坏版本代价很高（v0.3.2 被说「不收敛」）。要跑：
     - 全场景清单 `docs/testing/scenarios.md`；
     - 宽窗口（1600）和小窗口各截一遍图看；
     - 组合场景：缩放不等于 100% + 长对话 + 流式输出等。
- **可以直接做的**：需要跑的测试、全量测试、花费很小的真实模型复跑，直接跑，跑完汇报结果和花费。
- **必须先问的**：提交、推送、打标签、合并、超出已批准额度的花费、删除用户的东西。各版本到现在都**只推分支，不合并、不打标签、不出安装包**，除非用户另说。
- 外部标准（比如 Showcard 卡片协议）要照官方仓库原文和官方一致性测试做，偏离的地方逐条列给用户。
- 用户给的素材要 1:1 照用：品牌蝴蝶只用 `docs/design/assets/butterfly.svg`（这是 1:1 描下来的矢量，颜色跟着名画主题换，深色主题描边变白）。用户设计资料包里的「签名蝶精灵」**不能用在 DreamFlutter**。

## 三、已经定下的产品方向（不要推翻）

- **蝶君就是对话**：
  - 消息直接给蝶君，它在回复里说打算并开工；打招呼就正常聊；
  - 只有真缺信息时才进「等你处理」；
  - 绝不再加「先复述任务」的单独步骤或分类器。
- **蝶君的人格和自主**：
  - 性格只给预设选（静 / 暖 / 利落 / 灵动），不让用户自由描述；
  - 沙箱里什么都能做，出沙箱要用户明确要求；
  - 扩大权限才问，在已批准的范围内或缩小范围就直接做；
  - 主动性强、频率高，可以主动找用户聊天；
  - 「做完了」由程序按客观证据判断，主观质量由另一家族的模型复核，蝶君只提出完成和说明。
- **记忆**：
  - 平台模型按「弱模型」对待，所以保持固定的记忆类型、规则和程序校验，不放松；
  - 蝶君有经验循环（失败 → 假设 → 验证 → 规则）；
  - 只有用户说记错了、不高兴时，才回头重读对话记录。
  - 细节见 `docs/design/memory-kb-notes.md`（这份没提交，不属于 0.12）。
- **已定型的核心交互逻辑**：`docs/design/settled-behaviors.md`，16 条加守护测试。
  - **2026-11-14 用户已要求整体 UI 重做，1.0 视觉与页面布局一律以 `docs/design/v1-redesign-spec.md` 和 `docs/design/prototype/v1-redesign.html` 为准**，`settled-behaviors.md` 只守 16 条核心交互逻辑和对应测试，不代表沿用旧版界面。
  - 守护测试的行为断言不能为了通过而改；截图类守护可以按新样子重拍。
- **让布局自己说话**：不加多余的副标题、说明行、提示文字（`AGENTS.md`）。
- **HanaAgent 是样板**：它的交互逻辑和整体观感（布局、平衡、美观）是我们学的对象。我们有的功能照它优化，没有的存档以后用。
  - 调研归档在本机 `E:\claude\HanaAgent-UI-Audit\`，有用户私人内容，**不要复制进仓库、不要上传**。
  - 提炼在 `docs/design/hana-study.md`。
- **1.0 出两个版本**（方向已定，细节等用户决定）：
  - **开放版**：推到仓库，模型配置完全自由；
  - **托管版**：内置模型池、强制路由，用户的中转站付费，发给零基础的人实测。
  - 绝不能把中转站总密钥打进安装包，要用每人一个、可吊销、有额度的子令牌或激活码。
  - 调研和方案在 `docs/research/onboarding/`（入口 `07-总结与待定项.md`）；roadmap 的 v1.0 一节。
- **2.0 是模块化平台**（像 MC 的 mod），1.0 不做；见 roadmap 第七节。

## 四、2026-11-14 当时的进度（历史快照，当前状态看页首）

- **分支**：`v0.12-frontend`，**0.12 的全部实现都还没提交**（几十个文件）。最近一次提交是 `2953a14`（0.11 后台）。
- **用户手上的包**：`dist\v012-candidate-test.5\DreamFlutter`（纯净版），说明在 `docs/releases/v0.12.0-test.5.md`。
- **最新的大方向**：用户 2026-11-14 要求**整体 UI 重做**，对标 HanaAgent，大刀阔斧，追求独特的美，覆盖全部前端。
  - 原型（R0 已修订）：`docs/design/prototype/v1-redesign.html`（加 `v1-art.css`、`v1-motifs.js`、`v1-redesign.js`、`v1-settings.js`、`v1-pages.js`），20 张参考截图在 `docs/design/prototype/v1-shots/`；
  - **实现规格（完整报告）**：`docs/design/v1-redesign-spec.md`；
  - **任务卡**：`Claude Codex Bridge/2026-11-14-01-T-142整体UI重做.md`。R0、R1、R2 已完成，R2 相关检查 25 项通过；**下一步是 R3 对话、计划、过程块和右栏**，由当前窗口直接实现。
  - 旧的 `docs/design/prototype/v0.12-additions.html` 的内容已并入新原型，作废。
- **已经完成的调研**（只读参考）：
  - HanaAgent 全界面调研：`E:\claude\HanaAgent-UI-Audit\`；
  - 降低上手门槛和两个版本：`docs/research/onboarding/`；
  - 设计提炼：`docs/design/hana-study.md`；
  - 悬停提示规则：`docs/design/hover-tips.md`。

## 五、到 1.0 还要做的事（2026-11-16 旧写法；顺序以页首「最后路线」和 roadmap ★节为准）

1. **已完成项不要重做**：T-142/T-143 整体 UI、名作主题集、全局字体及后续七项试用反馈修正已完成。0.12.1 的本地提交与包体结果看页首链接；不要重新开启 UI 返工或重跑已完成的全量检查。
2. **真实完整任务验证（当前停在这里之前）**：等用户恢复开发，提供本轮指定 API 配置和预算后，按 `docs/releases/v0.13-真实任务验证计划.md` 跑一次。覆盖工作台、蝶君、沙箱、审批、记忆、日程、技能和模型；结果按实际产物与日志判断。禁止读取或擅用既有私人渠道密钥。
3. **完整安装与升级**：真实任务验证之后，再做干净环境安装、升级、回滚、卸载与数据保留验收；便携包启动检查不能替代这些流程。
4. **性能、包体和降低上手门槛**：按用户选定的内测形式收敛，参考 `docs/research/onboarding/`；问题分成「1.0 前必须修」与「1.x」。
5. **1.0 正式版和朋友专属内测**：名字、中转站、每人额度、反馈方式及托管版边界尚需用户决定；不把总密钥内置，不先改尚未授权的定型行为。完成安装包、使用说明和发布说明后交用户验收。下一主题集继续只保留调研样稿。

本地收尾授权不包含推送、打标签或切分支。保留未纳入本轮的 `docs/design/memory-kb-notes.md`、`docs/research/agent-memory-large-corpus*.md` 及生图研究草稿，不擅自提交或清理。

**还要用户定的事**，汇总在 roadmap 的附录 C 和 `docs/research/onboarding/07-总结与待定项.md` 的决定表里。

## 六、工作方式

- **T-142 的历史分工（用户 2026-11-14 定）**：原型、设计、Flutter 实现和验收当时由 Kimi Code 窗口完成；当前接手按页首状态执行。
- T-142 在 R1–R7 前增加 R0：修计划展开错位，补足名画材质、控件反馈和适度动效。美术要有细节、有呼吸，不过分华丽，也不贫瘠。
- R1–R6 只做针对性检查；全量测试和守护测试在 R7 全部完成后统一跑一次，不再每批跑。守护测试的行为断言不能改。
- 原型预览使用用户指定的本机 Edge 扩展，不再使用此前会异常等待的预览工具。
- 0.12 先不提交属于历史阶段；本轮本地提交与打包已获授权，推送仍未获授权。其他任务如果还要派给别的执行 Agent，给用户的提示词要做成可以直接复制的代码块，每个窗口一块。
- 每次交付前更新 `docs/HANDOFF.md` 最上面一段（现在在哪、下一步、注意事项），换窗口的人先读它。
- 新踩的坑写进 `docs/dev-guide.md`，新场景写进 `docs/testing/scenarios.md`。每个修复都要有一个「没修就会失败」的回归测试。

## 七、开发环境（这台电脑）

- Flutter 3.47.8 在 `E:\dev\flutter`，已在 PATH 里；VS 2022 Build Tools 在 `E:\dev\VSBuildTools2022`。
- 用户的系统代理是 `127.0.0.1:12450`。从微软的服务器下载会很慢，需要时请用户临时关掉。没有 winget，不是管理员权限。
- **从短路径构建**：深目录会撞 Windows 的 MAX_PATH。
- 不要对现有文件跑 `dart format`：项目没有统一格式化，会改乱无关的代码。
- `flutter run` 报出几百个 SDK 内部错误（比如「'Matrix4' isn't a type」）时，`flutter clean` 能修。
- 后台测试和会启动 PowerShell 的东西，用 PowerShell 跑，Git Bash 的沙箱起不了 powershell.exe。
- WSL：
  - 读 `wsl.exe` 的输出要设 `WSL_UTF8=1`；
  - Git Bash 里先 `export MSYS_NO_PATHCONV=1`；
  - **绝不能** `ip link set eth0 down`，所有发行版共用一个网络。
- 这台电脑的网络偶尔会整个断掉，先用 curl 试一下主机再下结论。不走代理时阿里云镜像能用，清华、中科大不行。
- 用 shell 的 heredoc、`sed`、`node -e` 改代码时，反斜杠会丢，曾经悄悄把 TS 和 Dart 改坏过。带反斜杠的内容用编辑器工具写。
- 用户的 `~/.pi/agent/settings.json` 里 `images.blockImages: true`，DreamFlutter 在 `core/src/pi/host.ts` 里按会话覆盖了它，不要去改用户的文件。
- 截图和对比：
  - 0.12 用的是 `app/integration_test/v012_compare_test.dart`，截图在 `app\build\v012_compare\`，对照页 `dist\v012-对照.html`；
  - v1 重做要新建 `v1_compare_test.dart`，见规格第 11 节；
  - T-142 原型预览用用户指定的本机 Edge 扩展；扩展不能直接读本地文件时，用临时只读页面服务，核对完关闭。后台标签页可能暂停 `requestAnimationFrame`，布局读取用同步 `evaluate` 或 `wait selector`，不要 await 动画帧。
