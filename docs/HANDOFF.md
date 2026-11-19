# DreamFlutter 开发交接

> **到 1.0 的最后路线（用户 2026-11-17 定，按此执行，不要另起规划）**：0.13.0（已完成）→ **0.13.1** 修真实验证剩余问题 → 完整安装与升级验证 → 性能与包体瘦身、启动速度、安装流程（选目录等）→ 降低上手门槛 → **1.0 preview** 打包推送 → preview 阶段做朋友内测 → **1.0 正式版**。详表在 [roadmap 页首★节](roadmap.md)。每步先交用户验收；推送、标签、合并逐次问。**当前（2026-11-19）：第 0–5 步完成，第 6 步朋友内测进行中。内测包 `dist/beta.1` 已交用户自己发；修卸载卡住后发了 1.0.0-preview.2（`eaf4a47`，标签 `v1.0.0-preview.2`，GitHub 最新发布）。`macos_preview_migration` 分支已完成 Apple Silicon（arm64）macOS 内测版迁移开发（`sandbox-exec` 轻量沙箱 + GitHub Actions 自动出 `.dmg` 包，详见 [macOS 内测指南](releases/macos-beta-guide.md)），待验收与打包。文档已整理，总目录 [docs/README.md](README.md)。**


**2026-11-19：第 6 步开工，先做内测专用包（用户定）**

- 包里带沙箱镜像（约 650 MB，`core/sandbox-image/` 有镜像就直接用，不用下载）。
- 模型只走用户的第三方中转站：中转站能给每人建单独令牌（额度、允许模型、到期在中转站后台设），但**没有路由**，路由规则由我们在程序里定（复用渠道 + 模型组 + 四个用途）。
- 大家同一个包，第一次打开填一次用户发的令牌（激活码）；不能把总 key 打进包。
- 同意托管版改定型第 4、5、10、11、16 条（设置布局、渠道编辑、模型组、模型选择器、花费页）；花费页照常显示金额。
- 程序内要有反馈入口；使用前告知后来不要了（第一次启动只有输入激活码，用户 2026-11-19 定）；人数和额度由用户在中转站管。
- 关闭自动更新；不考虑和普通版同机共存。
- 中转站是随想（sui-xiang.com），令牌只能绑一个分组，**只走 GPT Pro**：对话、小任务、看图用 gpt-6.1-terra，大任务用 gpt-6.2-sol，见 [内测模型池](design/beta-pool.md)。
- 只做这一个版本的内测，不考虑更新；反馈由用户自己处理，但程序里要放一个反馈入口（点了在浏览器里打开用户的腾讯文档表单，链接见 beta-pool.md）。
- 真实中转站已验证（测试令牌在用户本机 `C:\Users\21669\Documents\Codex\2026-11-12\https-sui-xiang-com-available-channels\outputs\测试令牌.txt`，不进仓库）：走 Chat Completions；对话、流式、工具、看图、推理档位、缓存都通；查不到余额；额度用完的返回还没测。详见 beta-pool.md 第三节。
- 原型（v1-redesign 顶栏「托管版」）用户看过：第一次启动只有输入激活码，不放说明。已实装内测版（实现见 beta-pool.md「实现」节），测试包 `dist/beta.1`（打包脚本 `-Beta`）。侧栏不加反馈小旗子（用户定）。已提交（用户 2026-11-19 同意）；安装包由用户自己发给朋友，不推送、不建发布页。

**2026-11-19：整理文档**：docs 根目录只留入口文件（NEW-AGENT-START、HANDOFF、roadmap、dev-guide、README 总目录）；后台设计归到 `architecture/`，旧接口说明到 `api/legacy/`，旧版本计划、设计、评审到 `history/`，0.2–0.4 发布说明到 `releases/`，v0.6 / v0.7 调研分进 `research/v0.6`、`research/v0.7`，调研提示词到 `research/prompts/`；HANDOFF 里 0.1–0.12 的旧记录挪到 `history/HANDOFF-0.1-0.12（2026-10-30至11-16）.md`，接手须知顶部的旧状态摘要挪到 `history/接手须知-旧状态摘要.md`。所有链接和代码注释里的路径都跟着改了（坏链接数和整理前一样，只剩第三方技能自带的 4 处）；读这些文件的测试（路由、API 清单等）全过。

**2026-11-19：发 1.0.0-preview.2（用户要求马上修复发布）**：只修卸载（见下条）；pubspec `1.0.0-preview.2+20`，发布说明 `docs/releases/v1.0.0-preview.2.md`，包在 `dist/v1.0.0-preview.2`；正式包自测：盘符下一级安装、带数据和运行中沙箱，卸载 5 秒删净。main 快进、标签 `v1.0.0-preview.2`、发布页设为最新。内测包 `dist/beta.1` 已带同一修复。

**2026-11-19：修卸载卡住（用户 D 盘 0.13.2-test.6 卸载一直转）**

- 原因：清理把待删的树挪到「安装目录的上一级」再删；装在 `D:DreamFlutter` 这种盘符下一级时，上一级是盘符根目录，`safePath` 拒绝，沙箱文件夹和数据都删不掉，钩子返回失败。默认装在 %LOCALAPPDATA% 时没事（0.13.1 验证就是这种），第 3 步新安装器能选位置后才暴露。卸载工具最后弹「卸载完成」窗口等人点确定，窗口在后面，系统设置里就一直转圈。
- 修：`quarantineParent`（上一级是盘符根时挪到安装目录里面）；删沙箱文件夹的重试放宽到 16 次约 13 秒；原生钩子等待 25 秒改 50 秒（Velopack 给 60 秒）；`hook.ts` 先写日志再加载清理代码（D 盘那次 25 秒内一行日志都没有，原因没查到）。
- 测试：`core/test/uninstall.test.ts` 加两条（盘符根安装、WSL 晚放手），去掉修复会失败；卸载相关 14 条全过。实装：装到 `E:df-uninstall-test3`、有数据和运行中的沙箱，卸载 5 秒全部删净。
- 已发的 1.0.0-preview.1 和 `dist/beta.1` 里都还是旧代码。

**2026-11-18 夜：第 5 步 1.0 preview 完成并发布**

- 用户验收预览包后同意提交推送：提交 `bf7389e`，main 从 0.8.3 快进，标签 `v1.0.0-preview.1`，main、标签、v0.12-frontend 已推送。
- 发布页：用户改定为**正式发布（latest）、标题写预览版**，不标预发布——程序内更新只认 GitHub「最新发布」，标预发布的话以后 preview.2 朋友们收不到自动更新。附件：`DreamFlutter-Installer.exe`、`DreamFlutter-1.0.0-preview.1-win-x64-full.nupkg`（程序内更新用）、`SHA256SUMS`。以后每个预览版都照此发。
- 课本第 2 课 DeepSeek 网站上的几步改为只用文字说明，不配截图（用户 2026-11-18：不难，不用教）。
- **2026-11-18 收尾：工作目录清理**（用户逐项确认）：删了 Flutter 编译测试缓存（`app/.dart_tool/flutter_build` 35 GB、`app/build` 3.5 GB，下次编译自动重建）、%TEMP% 里 113 个 df_ 测试残留、旧 worktree `E:\claude\DreamFlutter-v0130`、`%LOCALAPPDATA%\DreamFlutter.preserved-data`（11-17 安装测试残留）、dist 里 test.8 与 0.12.0 / 0.12.1 / 0.8.3 便携包；E 盘可用从约 100 GB 到 146 GB。保留：`dist/v1.0.0-preview.1`、仓库外 `E:\claude\HanaAgent-UI-Audit`、`E:\claude\DreamFlutter-Onboarding-Audit`。没动：D 盘安装版、`E:\DreamFlutter测试版`、3 个 WSL 沙箱。一直没提交的 7 个研究文件按用户意思提交进仓库。

**第 5 步过程记录**

- 用户定：版本号 `1.0.0-preview.1`（pubspec `1.0.0-preview.1+19`）；合并 v0.12-frontend 进 main、打标签 `v1.0.0-preview.1`、推送 main 与标签；建 GitHub 发布页并标预发布，附安装包；打包前补课本截图；仓库 README 和说明文档全部更新。合并、推送、建发布页前要再问一次。
- 一直失败的测试全修好（期望不变）：window_frame 三条和 composer_layout 是 0.12.1 把默认缩放改 110%、字号改 125% 后测试没固定这两项（测试里固定 100%）；首页在矮窗口（150% 缩放）下收起名言和笔触，输入框不再被挤出屏幕；memory_v05 3.4 改成从预设菜单选 0；后台 9 条是 0.12.1 起工作台系统通知默认关，相关测试里打开它。后台 1044 项、窗口全量通过。
- 课本截图：`app/integration_test/v1_compare_test.dart` 加了课本一节（`--dart-define=V1_GUIDE=true`），`scripts/guide/draw-boxes.py` 画红框、本机路径打码、存 JPEG（17 张共 2 MB）。DeepSeek 网站 4 张（02-ds-*）要有账号的人手动截，暂显示「截图待补」。README 首页两张图 `docs/design/assets/readme-*.jpg` 同一次拍。
- 文档：README 重写（下载安装、预览版状态、能力与进度更新）；发布说明 `docs/releases/v1.0.0-preview.1.md`（也作 GitHub 发布页正文）；NEW-AGENT-START、docs/guide 已更新。
- 预览包：`dist/v1.0.0-preview.1/build.ps1`。

**下一窗口从这里开始**

1. 路线第 6 步「preview 阶段朋友内测」**由用户安排的另一个 Agent 接手**（用户 2026-11-18）。接手时开工前先问用户内测名字、中转站、每人额度、反馈方式、托管版边界，不要自己定。
2. 出下一个预览版：pubspec 版本改 `1.0.0-preview.N+…`，照 `dist/v1.0.0-preview.1/build.ps1` 改版本号打包；发布页**设为最新发布、不标预发布**（程序内更新只读 GitHub releases/latest），附 `DreamFlutter-Installer.exe`、`DreamFlutter-<版本>-win-x64-full.nupkg`、`SHA256SUMS`。用户上传速度约 0.3 MB/s，540 MB 约 26 分钟，gh 传完前发布页是草稿。
3. **安装类验证一律在 Claude 终端面板（run_in_terminal）里启动**，不要从 Bash/PowerShell 工具直接装或启动安装版：Claude 应用是 MSIX，从它直接启动的程序写 AppData 会被重定向到 `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache`，结果不算数。点击向导可用 `scripts/v0131-install/window.ps1`（模拟鼠标，作用在真实桌面）；分阶段驱动用 `scripts/v0131-install/drive.mjs`（也要在终端面板里跑）。
4. 打包工具在 `E:\dev\velopack-tools`（.NET 8 + vpk 1.2.161）和 `E:\dev\velopack-sdk`；gh 在 `E:\dev\gh`，用时设 `GH_CONFIG_DIR=E:\dev\gh\config`。每个包约 7 分钟。用户要求一批改动做完、自测后只打一个测试包，别为小改连出多个包。
5. 推送、打标签、合并 main 仍需用户逐次同意。说话一律中文，包括中途进度和收尾小结。

**2026-11-18 第 4 步进行中**：沙箱一键安装写了一半（`core/src/sandbox/wsl-install.ts` 已写，尚未接进 `sandbox.ts`、界面和测试，未提交）；用户随后要求入门教学面向 agent 零基础用户做「手把手、完整详细」的保姆级教学，先出几套方案（原型 `docs/design/prototype/onboarding-options.html`）给用户选，选定前不实装引导部分。用户 2026-11-18 选定入门方案四「课本＋跟着做」（原型 `docs/design/prototype/onboarding-options.html`）：十课共用大纲；必修 5 课在真界面里跟着做（压暗 + 小卡片 + 程序检测完成），每张卡片可打开课本对应页；十课全部有程序内图文课本（设置 › 关于旁），仓库里放带截图的完整版；侧栏加「入门」进度卡，学完或点「不用了」后消失（用户同意动这一处）。先出逐课逐步的文字和画面给用户看，再实装；可分两批：先课本，再跟着做。逐课细化见 docs/design/prototype/onboarding-detail.html；用户已定：第 2 课用 DeepSeek，练习文件夹放数据目录，第 5 课用「查资料写报告」，首页三个示例换成零基础的（只填进输入框）。第一批已做（未提交）：十课课本在 app/assets/guide（docs/guide/README.md 指过去，截图清单在 images/），程序内 设置 › 关于与更新 › 使用说明（lib/ui/guide_page.dart，go:settings/… 与 go:section/… 链接跳转），首页示例已换，测试 app/test/guide_page_test.dart。

**2026-11-18 晚：第 4 步做完，用户试 test.8 验收通过（本地提交 `77fed1c`，未推送）**

- 沙箱一键安装：`core/src/sandbox/wsl-install.ts`（查虚拟化 → 系统自带安装 → 官方 MSI 核签名 → 开 VirtualMachinePlatform）接进 `sandbox.ts`：新状态 `restart-needed`、接口 `sandbox.restartComputer`、RunOnce 重启后自动打开程序并接着建（`after-restart.json`）。界面 `app/lib/ui/sandbox_panel.dart`：没有 WSL 也只一个「建立沙箱」，失败后才出手动命令；重启有「现在重启 / 稍后」。测试 `core/test/wsl-install.test.ts`、`app/test/sandbox_panel_test.dart`。
- 跟着做五课：课程定义和进度 `app/lib/state/onboarding.dart`（进度存偏好 `tour.*`），引导层与侧栏进度卡 `app/lib/ui/onboarding_tour.dart`（`TourAnchor` 标点位置，四块遮罩只留亮处可点，卡片可开课本对应页），`main.dart` 套在整个窗口外。完成检测靠状态（切页、发消息、回复完、沙箱就绪）和程序报的信号（copied / approved / accepted / channel-editor / practice）。第 4 课练习材料 `app/assets/practice/`（乱销售表、三篇短文、一张图），点「用练习文件夹」复制到 `<数据目录>\练习` 并切过去。测试 `app/test/onboarding_tour_test.dart`。
- 引导层细节：同一位置可在多页同时存在（工作台与蝶君页都常驻），亮哪个看 TickerMode 和 IndexedStack 当前页；`anchor` 可写「a|b」取第一个在屏上的（第 2 课 3 步先亮「模型」，进去后亮「添加渠道」；第 5 课 5 步进了「等你处理」就亮整页）；新亮处自动滚进视野；遮罩一张图挖洞，四块透明块挡点击。实窗截图测试 `app/integration_test/onboarding_look_test.dart`（图在 `app/build/onboarding_shots`，亮暗各 15 张）。
- 自测（2026-11-18）：窗口全量 387 过，5 条失败在上次提交 `5bcc947` 上原样就失败（composer_layout 150%、memory_v05 3.4、window_frame 三条尺寸），不是这轮引起；后台全量 1044 条，9 条失败（goals-t102/t106/t99、longtask-goals、notifications-t117/t120、slots），换回旧 `sandbox.ts` 也照样失败，同样不是这轮引起，待另查。
- 测试包：`dist/v0.13.2-step4/build.ps1`，版本 0.13.2-test.8。
- 还没做：课本 21 张截图（清单 `app/assets/guide/images/截图清单.md`，1.0 preview 前补）。

**2026-11-18 第 4 步开工，用户定**

- ①沙箱一键安装——没有 WSL 时点「建立沙箱」→ 管理员确认 → 先 `wsl --install --no-distribution`，失败改用微软 WSL GitHub 发布页的官方 MSI（核对签名）→ 提示重启（现在 / 稍后）→ 重启后程序自动打开并接着建沙箱；BIOS 未开虚拟化只给一句说明。②使用说明与入门指南两边都要：程序内（设置 › 关于旁）放精简版，随包离线可看；仓库里放带截图的完整版。③引导做到「图标按钮悬停简介 + 工作台和蝶君空白页的示例（点一下填进输入框，不自动发送）」，不做强制导览。托管版相关仍留到 preview 阶段。

**2026-11-18 下午：第 3 步做完，用户验收，本地提交 `2cdf749`（未推送）。下一步：路线第 4 步「降低上手门槛」（服务商清单已提前做；待定：沙箱干净快照瘦身）**

- 用户实装 test.6 并建好沙箱：安装包 259 MB、安装后 661 MB、后台启动约 320 ms、整包自动删除、镜像下载约 12 分钟。前后对照见 [性能与包体回执](releases/v0.13.2-性能与包体回执.md)。测试包打法：`dist/v0.13.2-step3/build.ps1`（改版本号）。待定：沙箱干净快照是否改为只留镜像。

**2026-11-18：第 3 步过程记录**

- G、H 用户已定并改完：G 注销沙箱后删开始菜单同名空文件夹（`core/src/sandbox/sandbox.ts` `unregisterSandbox`）；H 删掉 v0.3.1 旧数据迁移触发、旧窗口偏好导入、数据根回落（`core/src/main.ts`、`app/lib/main.dart`、`app/lib/state/installation.dart`）。
- 包体基准（0.13.1 程序目录 1.56 GB）：沙箱镜像 653 MB、语音模型 228 MB、Windows Python 209 MB、Node 依赖 175 MB、Git 92 MB、node.exe 83 MB、窗口 72 MB；安装后另有 Velopack 留在 `<安装根>\packages` 的整包约 1.06 GB。
- 已改：语音模型第一次用本机识别时下载（`core/src/modules/voice/model.ts`，hf-mirror → Hugging Face，续传 + SHA-256；设置 › 语音「本机模型」行显示进度；接口 `voice.modelStatus` / `voice.downloadModel` / 事件 `voice.model`）；沙箱镜像只随包带说明，第一次建沙箱从仓库 GitHub Release `sandbox-image-ff0303e27cc8` 下载，失败回落现场构建（`core/src/sandbox/image.ts`、`sandbox.ts`，共用下载器 `core/src/net/resumable.ts`）；安装版启动 30 秒后删 `packages` 里的整包（`core/src/update/installation.ts` `dropLeftoverPackages`；我们的更新程序用自己的包缓存，不读它）；打包裁剪加 Python 库自带测试（约 25 MB，`scripts/package-trim.mjs`）；`scripts/package-windows.ps1` 不再放语音模型和镜像本体。
- 用户 2026-11-18 再定：镜像由 Claude 装 gh 后上传（用户登录，传前再问）；增量更新先不做，用瘦身后的整包；做一个小安装器，双击先选安装目录再调 Setup.exe --installto，数据位置仍在首启向导里选。
- 2026-11-18 午：用户试装 test.3（装到 D:DreamFlutter，914 MB，其中 packages 整包 251 MB 待启动后删）后要求：渠道清单去掉 Pi 那串（已做，原属第 4 步）；首屏与向导外观统一（已做：首屏改用 `FreshApp`，同样的自绘标题栏、默认缩放 1.1、字号 1.25；窗口标题改大写 DreamFlutter）；Velopack 安装进度换主题启动图（`tools/installer/splash.png`，`make-splash.ps1` 生成）。安装器前端在 `tools/installer/`（原生 Win32 + GDI+，`build.ps1` 编译并拼接 Setup.exe）。Velopack 工具已挪到 `E:developack-tools`、`E:developack-sdk`（临时目录里的被清理过）；gh 在 `E:devgh`，用 `GH_CONFIG_DIR=E:devghconfig`。
- 原待定：镜像先上传到 GitHub Release（需用户同意；本机没装 gh）；增量更新怎么办（更新程序是自写的，做增量要另留一份基础包）；安装目录选择的做法。之后打测试包、在终端面板实装量前后数据。
- 测试：新增 `voice-model-download`、`sandbox-image-download`、`update-leftover-package`、`sandbox.test.ts`「Start Menu」，窗口 `t139` 加一条；相关后台测试（语音、沙箱、卸载、备份、更新、接口清单/契约）和窗口 t88、t139 通过。全量测试未跑。

**2026-11-17 晚：完整安装与升级验证完成，用户验收并提交 `6a81832`（当前状态）**

- 真实环境（Claude 终端面板启动，不受 Claude 应用文件重定向影响）走通：全新安装、向导、造数据、程序内卸载保留数据、重装找回、自动升级 0.13.1→0.13.2-test.1、失败回滚、彻底卸载。发现并修好 7 个缺陷 A–F、I（向导跳过模型、守护进程被 Velopack 结束、升级中断重开卡死、重装不提示找回、找回被拒、Velopack 挪不动 current、等待超时误回滚），详见 [安装升级验证回执](releases/v0.13.1-安装升级验证回执.md)。待定：G 开始菜单空文件夹残留、H 新装搬入本机旧数据。
- 版本号已改 0.13.1+18（app/pubspec.yaml）。安装包在 dist/v0.13.1-install/（含 build-all.ps1），工具在 `%LOCALAPPDATA%\Temp\df-v0131-velopack-tools`，0.13.0 代码 worktree 在 `E:\claude\DreamFlutter-v0130`（版本号改动不提交）。驱动脚本 `scripts/v0131-install/`。已本地提交 `6a81832`，未推送、未打标签。测试安装已卸载；`%LOCALAPPDATA%\DreamFlutter.preserved-data` 是测试留下的保留数据。工作树里 7 个研究文件仍不属于本版，不要顺手提交。

**2026-11-17：0.13.1 修完真实验证剩余 4 条（已验收提交 `2fcea7f`，历史）**

- 第 4 条「N 分钟后」已修（`core/src/modules/schedule-time.ts` 相对时间）；第 6 条工作台自称蝶君已修（工作台会话加 `WORKBENCH_IDENTITY`，蝶君会话不带）；第 7 条乱码是验证测试 `Process.run` 按 GBK 解码，已改测试按 UTF-8 读，产品 pwsh 复核正常；第 5 条日历选中整列加宽是 T-143 用户要的交互，**用户定保持现状**。详见[回执末节](releases/v0.13-真实任务验证回执.md)。
- 测试：新增 `core/test/v0131-fixes.test.ts` 2 项；连同 schedule-time-t140、agent-modes、web-search、api-contract/b-goals、v013-fixes 共 43 项通过；`v013_live_test.dart` 定向分析零问题。未调真实模型。
- 未提交、未改版本号（仍 `0.12.1+16`）。下一步：用户验收 0.13.1 → 问提交 → 进完整安装与升级验证。

**2026-11-17：0.13 真实任务验证完成，已提交、打标签 v0.13 并推送（前序状态）**

- 用户恢复开发，指定本机测试版的 OpenCode Go 渠道、整轮上限 USD 0.50。新增 `core/scripts/v013-live-core.ts`（隔离 Core＋复制渠道＋临时 WSL＋预算闸门）和 `app/integration_test/v013_live_test.dart`（真窗口九个场景）。四轮共 48 次请求，闸门估算 USD 0.0523。
- 结果：首轮技能、日程未过（产品问题）。用户要求修的三项已修：批准前已开的对话用不了新技能；蝶君日程被提示词误导成只读；工具被拦也记完成。回归测试 `core/test/v013-fixes.test.ts`，真实复验后**九项全部通过**，五轮合计 USD 0.0595。详情见 [真实任务验证回执](releases/v0.13-真实任务验证回执.md)；剩余 4 条小问题（相对时间、时令日历列宽、工作台自称蝶君、控制台中文乱码）待用户定。
- **平台默认记忆**（用户 2026-11-17）：新数据目录第一次启动写入 10 条全局「背景」记忆（平台简介、工作台/审批/蝶君/日程/记忆功能、内置工具、内置技能、MCP、模型），工作台和蝶君都可见，可改可删，删了不补；已用过记忆的数据目录不写。内容在 `core/src/memory/platform-defaults.ts`，开关是 `buildCore` 的 `platformMemory`（main.ts 开，测试默认关），测试 `core/test/platform-memory.test.ts`。在记忆页会归在「关于你」组（全局背景都在那里）。
- **短提示统一为「便笺」**（用户 2026-11-17 看过现状截图和样稿 `docs/design/prototype/toast-proposal.html` 后同意）：对话区顶部居中、宽度跟文字、小圆点表状态、最多一个操作、失败不自动消失；规则写进 `v1-redesign-spec.md` 6.1。实现 `app/lib/ui/notes.dart`（`showNote` / `withNoteLayer`），原 46 处 SnackBar 与控制器顶部提示全部改用它，`lib/` 里已无 SnackBar。测试：新增 `test/notes_test.dart` 6 项；受影响组件测试只在挂载处加 `builder: withNoteLayer`（t86/t87/t89，含 t86 守护文件，行为断言未改）；`memory_v05_test` 3.4 改动前就失败；离线端到端 10 项通过；实窗图 `app/build/toast_shots/`（旧样子在 `toast_shots_before/`），截图测试 `integration_test/toast_look_test.dart`。
- **提交与发布**：用户授权后本地提交 `a515046`，打附注标签 `v0.13`（指向 `a515046`），并把分支 `v0.12-frontend`（首次上远程，已设跟踪）和标签推送到 origin，远程核对一致；未合并 main、未建 PR。程序版本号仍是 `0.12.1+16`，没有改版本号、没有重新打包。工作树里 7 个研究文件（`docs/design/memory-kb-notes.md`、`docs/research/agent-memory-large-corpus*.md`、`docs/design/research/` 下 T-143 生图草稿 4 份）仍不属于本版，未提交。
- 改动前就失败的 7 项后台测试（T102、T106×2、T99、T73、重放完成、T120）和组件测试 `memory_v05_test` 3.4 原样保留，未改期望。
- **下一步**：按页首路线做 **0.13.1**——修剩余 4 条（相对时间、时令日历列宽、工作台自称蝶君、控制台中文乱码），处理方式有疑问先问用户；之后进完整安装与升级验收。用户定当前代码即 0.13.0，程序版本号仍是 `0.12.1+16`，出包前要改。以后的推送、标签、合并仍需用户逐次授权。


**更早的记录**：0.1 到 0.12（2026-10-30 至 11-16）的开发交接挪到了 [history/HANDOFF-0.1-0.12](history/HANDOFF-0.1-0.12%EF%BC%882026-10-30%E8%87%B311-16%EF%BC%89.md)，内容原样，按需查。
