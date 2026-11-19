# 内测包：模型池与路由

日期：2026-11-19。状态：**用户已定路由**，界面（填激活码、模型池卡片、使用前告知）待出原型。依据：用户 2026-11-19 的决定（见 HANDOFF 顶部）和用户给的随想价目对照表（`C:\Users\21669\Documents\Codex\2026-11-12\https-sui-xiang-com-available-channels\outputs\随想模型性价比对照.html`，采集时的站方数据）。

## 一、前提

- 中转站：随想（sui-xiang.com），第三方，New API 类。令牌只能绑一个分组，所以**只走 GPT Pro 分组**（×0.25，采集时可用率 98.8%）。
- 每人一个令牌，额度、允许模型、到期由用户在中转站后台设；大家同一个包，第一次打开填一次。
- 中转站没有路由，路由由程序定。
- **只做这一个版本的内测**，不考虑更新、换模型后重新发包这些。
- 反馈由用户自己处理；程序里**要放一个反馈入口**（用户 2026-11-19 定），点了在浏览器里打开用户的表单链接：腾讯文档「1.0preview预览版问题反馈」https://docs.qq.com/doc/DVm1zU2VmU1JIVHZn 。
- **第一次启动只有一张「输入激活码」卡片**，激活成功点「进入」直接到首页，其余几步用默认；**不放使用前告知和其他说明**（用户 2026-11-19 看原型后定）。原型：`prototype/v1-redesign.html` 顶栏「托管版」。
- 设置 › 模型：模型池（激活码、本机已花）+ 四个用途写死；不显示模型组和渠道。关于页：版本写内测版、反馈按钮、无更新。侧栏不加反馈小旗子（用户定）。

## 二、四个用途（用户 2026-11-19 定）

价格是实际扣费（官方基础价 × 0.25），单位是随想价目的 $ / 百万 token。

| 用途 | 模型 | 输入 / 输出 / 缓存读取 | 上下文 |
|---|---|---|---|
| 对话（工作台、蝶君日常） | gpt-6.1-terra | 0.25 / 1.25 / 0.013 | 500K |
| 小任务（标题、记忆、巡查等后台） | gpt-6.1-terra | 同上 | 500K |
| 大任务（长任务、整理上下文、分析） | gpt-6.2-sol（用户 2026-11-19 改用 6.2；分组里没有 6.2-terra，其余仍用 6.1-terra） | 价格待从随想后台核对 | 待核对 |
| 看图 | gpt-6.1-terra | 同上 | 500K |

- 不用千问、矿老板等其他分组。
- 不开 Fast（开了价格 × 2.5）。

## 实现（2026-11-19）

- 开关：窗口 `--dart-define=DREAMFLUTTER_BETA=true`（`app/lib/state/beta_edition.dart`，渠道、模型、价格、反馈链接都在这里）；后台看程序根目录有没有 `beta-edition.json`（`core/src/paths.ts` 的 `BETA_EDITION`，也认环境变量 `DREAMFLUTTER_BETA=1`）。
- 打包：`scripts/package-windows.ps1 -Beta`：窗口打开开关、沙箱镜像 `dreamflutter-sandbox.tar.gz` 随包、根目录写 `beta-edition.json`。
- 第一次启动：内测版没有数据时不问数据位置（跟软件放在一起），直接到 `BetaActivation`（`app/lib/ui/beta_activation.dart`）：粘贴激活码 → 存「随想」渠道（openai-relay、Chat Completions、`https://www.sui-xiang.net/v1`）→ `setup.testChannel` 用 Terra 试连 → 「进入」调 `setup.complete`（称呼空、工作区空、沙箱 now，系统不支持时 later）。
- 设置 › 模型：`BetaPoolRows`（激活码尾号 + 换一个、这台电脑上已花 + 明细）和四个写死的用途、思考深度；模型组、渠道和按用途覆盖都不显示。
- 关于：版本后写「内测版」，「反馈问题 ↗」打开腾讯文档；没有检查更新、自动检查更新和原来的「写给我们」。后台 `updates.check` / `updates.download` 返回 unavailable，也不定时检查。
- 入门课：第 2 课「接上一个模型」本来就因为已有渠道自动跳过；第 1 课最后一句和第 5 课「建好沙箱」在内测版里换了说法（不提下载 650 MB）。
- **不露出中转站**（用户 2026-11-19 看测试包后定）：内测版 `providerLabel` 返回空，各处只写模型名（输入框按钮、悬停、设置里的模型菜单）；渠道名改叫「模型池」。输入框模型菜单里 Terra 后面标「日常对话、工作任务」，Sol 后面标「困难、深度任务」（`betaModelNote`）。设置页按地址认内测渠道。
- 侧栏反馈小旗子：用户 2026-11-19 定**不加**，反馈只在关于页。
- **额度用完（2026-11-19 用用户给的 0.5 美元令牌实测）**：大段输入花完后，随想返回 HTTP 429、`{"code":"API_KEY_QUOTA_EXHAUSTED","message":"API key 额度已用完"}`；后台认成 quota（渠道标为不可用）。改了提示：激活时写「这个激活码的额度已经用完」（`betaActivationError`），对话出错卡片标题写「激活码的额度用完了，请找发给你激活码的人」，Key 停用写「激活码不对或已经停用，请找发给你激活码的人」（`explainModelError` 的内测分支）。对话里 Pi 仍会自动重试约 20 秒才出卡片，没改。顺带算出 gpt-6.2-sol 实际输入价约 0.52 美元/百万，和暂记的 0.5 基本一致。
- 测试：`core/test/beta-edition.test.ts`（内测版不检查不下载更新、普通版不受影响）；`app/test/beta_edition_test.dart`（要加 `--dart-define=DREAMFLUTTER_BETA=true` 跑：坏激活码提示、好激活码进入、setup.complete 的四个用途；关于页）。真实中转站：临时数据里激活 → 用 Terra 读文件答对，坏 Key 返回 401 被认出，花费记账正常。

## 三、真实中转站验证（2026-11-19，用户给的测试令牌，探针在会话草稿区，未进仓库）

- 接口地址 `https://www.sui-xiang.net/v1`。**用 OpenAI Chat Completions 格式**（`/v1/chat/completions`）。
- 不用 Responses 格式（`/v1/responses`）：能通，但每次请求被上游加了约 4,088 token 的隐藏 instructions，照样计费；Chat Completions 没有这个问题（「说你好」只计 12 token）。
- 都通过：terra / sol 普通对话、流式（末尾带 usage）、工具调用（`finish_reason: tool_calls`）、看图（8×8 红图答「红色」）。
- 推理档位透传：同一道题 low 77、high 100 个 reasoning token，usage 里有 `completion_tokens_details.reasoning_tokens`。
- 缓存有效：约 4K 的相同前缀第二次 `cached_tokens: 3840`。
- 模型列表（GPT Pro 分组）里有 gpt-6.2-sol、gpt-6.2-astra，没有 gpt-6.2-terra。gpt-6.2-sol 实测对话、工具、看图都通，用户定大任务用它。
- 随想后台是 **Sub2API**（开源中转系统）：用户接口在 `https://sui-xiang.com/api/v1`，登录 `/auth/login` 拿 JWT，令牌在 `/keys`（列出、新建、修改、删除），新建可设名字、分组、额度（quota）、5 小时 / 1 天 / 7 天限额、到期、IP 白名单；用量在 `/usage`。用户 2026-11-19 决定**不做号池后台**，令牌直接在随想网站上建和管。
- 出错返回：
  - 令牌无效或停用：HTTP 401，`code: "INVALID_API_KEY"`，中文提示带站方客服 QQ。
  - 请求分组外的模型：HTTP 503，「当前分组暂不支持您请求的模型…」。
  - 额度用完：**没测**（要把令牌额度用光），实装时按 401 / 403 / 429 和「额度」「余额」字样认；内测前可让用户建一个额度极小的令牌实测一次。
- 余额查询：`/api/usage/token`、`/v1/dashboard/billing/*` 都 404，程序里**查不到令牌剩余额度**；花费页按本机账本和上面的价格算。
