# 加深 06A：Chatbox AI 首次使用——官方文档逐步拆解

检索日期：2026-11-14（Asia/Taipei）。资料为 Chatbox AI 官方英文公开站点；主要依据 [First Chat](https://chatboxai.app/en/guide/getting-started/first-chat)、[Download & Install](https://chatboxai.app/en/guide/getting-started/download)、[Choose Your Provider](https://chatboxai.app/en/guide/getting-started/choose-provider) 和对应设置指南。页面未给出适用的具体客户端版本号；入门文章包含桌面和移动端示意，以下以文档标注的**桌面路径**为主，必要时单独说明移动端。产品、账号政策、地区、模型与额度均可能变化。

**证据边界：**本次只读公开网页，未安装或启动客户端，未登录、注册、授权、提交表单、购买、输入密钥或下载模型；没有 Chatbox 实机首启截图、成功对话、可用性测试或逐屏耗时。文档里的编号是教学动作，不等于实际向导屏数。文档中的示意图和例句是官方文档内容；没有证据证明例句出现在应用空态。

## 1. 安装与选择路径

| 序号 | 前提 | 文档描述的行动 | 文档所述结果或分支 | 密钥、账号、费用与未知 | 来源 |
|---|---|---|---|---|---|
| 0 | 选择系统及安装形式。 | 官方安装指南列 Windows 10 及以上、macOS 11 及以上，以及 Linux AppImage / deb；下载页另列 Windows 64 位和 Linux 架构。 | 官方文档让用户按平台安装并启动。 | 本次没有下载或安装；安装向导屏数、发行版本、权限和升级过程未验证。iOS/Android 有独立入口，不把桌面步骤等同移动端。 | [安装指南](https://chatboxai.app/en/guide/getting-started/download)、[下载页](https://chatboxai.app/en/download) |
| 1 | 文档中的首次启动。 | 官方 First Chat 说主页欢迎界面介绍功能，给出“我是新手”和“跳过引导”两张卡片。 | 前者走对话式引导，后者转向自行配置。 | 这是官方文档的描述，不代表本次见到真实卡片；具体版本、文案语言、是否默认出现及可否重开均未知。 | [First Chat：Welcome Screen](https://chatboxai.app/en/guide/getting-started/first-chat) |

**官方页面间须区分的表述：**安装页的 First Launch 概述说新用户注册、领取免费许可或购买后登录开始聊天；更详细的 First Chat 同时明确列出跳过引导和自备提供商路径。前一句不应被扩写为“Chatbox 的所有模型路径都必须先注册 Chatbox 账号”；BYOK 或本地路径是否在所有版本、地区都能完全免 Chatbox 账号，本次未核验。([安装指南](https://chatboxai.app/en/guide/getting-started/download)、[First Chat](https://chatboxai.app/en/guide/getting-started/first-chat))

## 2. 路径 A：对话式引导和托管 Chatbox AI

以下逐条对应官方文档的六个编号动作；编号不是屏数或本次实操记录。([First Chat：Guided Setup](https://chatboxai.app/en/guide/getting-started/first-chat))

| 步骤 | 前提与行动 | 文档描述的结果 / 分支 | 未知与证据边界 |
|---|---|---|---|
| A1 | 文档中的欢迎页面；选择“我是新手”。 | 进入官方称为对话式的引导。 | 引导是否可在中途退出、返回、重开、何时保存进度均未查到。 |
| A2 | 引导介绍 Chatbox AI 服务。 | 文档称出现登录按钮。 | 页面如何展示价格、隐私和授权范围未核实。 |
| A3 | 点击登录。 | 文档称浏览器自动打开进行授权；没自动打开时可用显示的链接。 | 本次没有打开登录页或使用链接；不同浏览器失败、取消和重试的实际体验未知。 |
| A4 | 在浏览器以邮箱登录。 | 如果没有账号，文档另列先到官网注册的分支。 | 未注册或登录；实际验证方式、地区支持、账号与设备要求和错误页面未知。 |
| A5 | 在浏览器授权客户端访问账号。 | 文档描述授权后返回客户端。 | 授权范围、可撤销方式、隐私提示和失败/拒绝分支未验证。 |
| A6 | 返回客户端。 | 文档称显示已登录状态及“新对话”按钮。 | 这不是本轮实测；有无默认模型、何时第一次发送及实际回复仍未知。 |

**新用户许可及成本：**First Chat 称无账号者注册后可领取每日刷新免费额度，也可购买更多额度的计划；额度用尽后的文档选项包括订阅或使用自备 Key。官方[首页 FAQ](https://chatboxai.app/en)补充该免费试用面向尚未购买计划的新用户；[价格页](https://chatboxai.app/en/pricing)显示免费档与付费档。领取资格、额度数字、可用模型、地区和价格会变化；不能声称人人都能领、永久免费、无限用或所有能力均免费。

**Key 与登录是两回事：**[服务商选择指南](https://chatboxai.app/en/guide/getting-started/choose-provider)称托管 Chatbox AI 不需要用户自行配置第三方 API Key；上述官方引导仍描述邮箱登录和客户端授权。价格比较将该服务写作订阅，同时 First Chat 和首页说明新用户有限免费额度；应合并理解为**存在有限免费试用与付费方案的官方描述**，不把“无需手填第三方 Key”写成“无需账号/无需付费/无需授权”。

## 3. 路径 B：跳过引导后的手动配置

### B1：手动连接 Chatbox AI 托管服务

[First Chat：Manual Configuration](https://chatboxai.app/en/guide/getting-started/first-chat) 描述：

1. 前提：选择跳过引导或已经完成引导；桌面从左下设置进入，移动端文档要求先展开侧栏。
2. 选择设置导航中的 Chatbox AI；文档展示有登录入口。
3. 打开浏览器、邮箱登录并授权；返回后文档称显示登录状态和账户用量。
4. 关闭设置并开始对话。免费/付费资格仍按实际服务政策；没有实测是否有其他授权分支。

这是一条官方文档中的手动路线，与 A 的账号和托管服务相关，并非证明所有使用者都要走两遍。准确屏数、返回失败、用量显示的具体 UI 及可访问性未实测。

### B2：自备服务商 Key 的示例

- **前提**：已有被支持的第三方服务商及其账号、额度或付款安排。First Chat 描述进入设置里的 Model Provider，选择服务商并填写其 Key；[OpenAI 例子](https://chatboxai.app/en/guide/byok/openai)进一步描述注册/账单、创建密钥、在 Chatbox 中添加提供商、填写配置、保存并选模型。名称、实际提供商支持及步骤随版本变化，不能据此推广到所有服务商。
- **结果与分支**：官方文档预期保存后选模型开始对话；密钥无效、额度不足和网络问题各有建议。这个预期不是本轮连接成功证据。是否需要 Chatbox 自身账号、选择何种服务的具体费用、权限与地区要求均需按版本及各服务规则另核。
- **费用与安全**：文档将外部服务描述为按使用量计费的选项，但实际套餐、订阅或其他计费模式以所选提供商为准；不能把第三方服务的价格当 Chatbox 收费，也不能认定所有服务都免费。不得公开分享密钥，本次未获取或填写任何凭据。([服务商选择](https://chatboxai.app/en/guide/getting-started/choose-provider)、[OpenAI 示例](https://chatboxai.app/en/guide/byok/openai))

### B3：连接本地模型的可选路径

[Chatbox 官方 Ollama 指南](https://chatboxai.app/en/guide/byok/ollama) 描述另行准备并运行 Ollama、取得本地模型文件，在 Chatbox 设置中添加 Ollama、填写本地服务地址，保存后选择模型聊天。[服务商选择页](https://chatboxai.app/en/guide/getting-started/choose-provider)也列 LM Studio 等本地方案。文档的本地例子不要求先填写云服务 API Key；具体本地服务是否配置认证由环境决定。准备模型需要硬件、磁盘和取得模型文件的条件；不证明 Chatbox 自带模型或首次使用完全离线，也不证明无 Chatbox 账号要求适用于全部版本。远程开放服务涉及额外网络与权限边界，本次没有配置网络、下载、运行命令或连接任何服务。

## 4. 首次对话、示例、错误与求助

- [界面概览](https://chatboxai.app/en/guide/getting-started/interface-overview)描述侧栏、新对话、设置、帮助、会话区和底部输入框；输入框可用于消息、附件、模式和模型选择。这是官方文档说明，不证明所有版本与地区都一样，也不证明本轮成功发送。
- First Chat 的 A6 只把“新对话”按钮作为引导完成后的下一步；未提供足以确认**应用空态**示例、示例点击是否发送、回答成功与否或失败恢复的证据。Ollama/OpenAI 指南中的模型及使用示例是文档教学内容，不能当成应用内推荐任务或首屏文案。
- [常见错误文档](https://chatboxai.app/en/guide/faq/errors)与[额度说明](https://chatboxai.app/en/guide/chatbox-ai/quota)提供排查与用量信息；额度页面对付费周期的描述不能覆盖免费日刷新或各类套餐。未触发任何错误，不能宣称某一错误卡片或恢复按钮已存在。官方文档列有设置、Help、FAQ 等入口，但具体应用内目标、离线可用性和版本行为未测试。([界面概览](https://chatboxai.app/en/guide/getting-started/interface-overview)、[First Chat](https://chatboxai.app/en/guide/getting-started/first-chat))

## 5. 账号、地区、费用和数据：已查到什么、仍未知什么

| 问题 | 官方资料与限定 | 未核实 |
|---|---|---|
| 平台 / 版本 | 安装指南覆盖 Windows、macOS、Linux 与移动端，First Chat 有 Desktop/Mobile 示意。 | 实际安装包版本、屏幕顺序、移动和桌面是否完全一致。 |
| 账号 / 登录 | 官方托管引导描述邮箱登录、浏览器授权与新用户注册分支。([First Chat](https://chatboxai.app/en/guide/getting-started/first-chat)) | 是否所有本地或自备服务路径都要求 Chatbox 账号、可用地区、验证方式、账号删除及授权撤销。 |
| Key | 托管路径不手填第三方 Key；BYOK 示例需服务商 Key；本地 Ollama 示例有独立运行服务与模型前提。([服务商选择](https://chatboxai.app/en/guide/getting-started/choose-provider)、[Ollama](https://chatboxai.app/en/guide/byok/ollama)) | 每条路径的身份策略、用户设备权限、凭据真实存储和泄漏风险未经审计。 |
| 费用 / 配额 | 官方说部分新用户可领取每日刷新额度，也有付费方案；外部服务及本地运行各有条件。([首页](https://chatboxai.app/en)、[价格](https://chatboxai.app/en/pricing)) | 实际购买价格、税费、地区资格、模型及功能限制、额度重置的具体地域时区；不填静态猜测。 |
| 数据 | [官方数据 FAQ](https://docs.chatboxai.app/en/faq/faq/data-storage)称聊天/设置存设备；使用其托管服务时消息、上下文及用户上传的图片或文件会传至服务，并可能临时存储；第三方服务另看其政策。这些是**服务方声明**。 | 本次未观察真实流量、实际存储、日志、保留期、后台权限或数据删除；不能把声明当安全审计结果，也不套用到 DreamFlutter。 |

## 6. 对 DreamFlutter 的启发：假设与参考，尚未修改设计

1. **路径分明**：把“由项目提供模型”和“自行连接渠道”作为使用说明中的两种路径分别解释，交代各自的账号、费用和数据流向。参考的是 Chatbox 文档对两种选择的组织，不等于其新手成功率更高；DreamFlutter 开放版/托管版目前是设计方向，具体实现、服务及运营待定。（[Choose Your Provider](https://chatboxai.app/en/guide/getting-started/choose-provider)、本目录 `06-方案-两个版本.md`）
2. **对话式帮助仅作待验证选择**：Chatbox 官方文档以对话式引导解释托管服务，允许跳过引导进入手动配置；可供 Claude 研究是否有助解释 DreamFlutter 的“连接一个模型”。没有用户研究支持“对话式一定更好”，也不能因不同产品有跳过项就断言 DreamFlutter 现有向导能跳过密钥。（[First Chat](https://chatboxai.app/en/guide/getting-started/first-chat)、`01-新手走查记录.md`）
3. **写清代价和失败分支**：在实际决策前准确说明服务方、授权、额度、费用及数据去向；不要把账号/注册或本地下载成本隐藏在“免 Key”说法背后。实际恢复方式应与未来已验证能力一致。（[First Chat](https://chatboxai.app/en/guide/getting-started/first-chat)、[数据 FAQ](https://docs.chatboxai.app/en/faq/faq/data-storage)）
4. **本地模型不是现成方案**：Chatbox 文档有外接 Ollama 示例，但 DreamFlutter `roadmap.md` 第七节注明本地大语言模型暂不做；语音识别模型另有规划。不能把外部示例直接转为本项目新增本地大模型任务。

## 7. 已定型冲突与待验证

- 保留现有页面结构、交互与用词；界面设计由 Claude 负责，**以上均为建议，尚未据此修改设计**。任何改变定型行为须逐条提出并由用户明确决定，不能以 Chatbox 的流程替代 DreamFlutter 原设计。
- DreamFlutter `interaction-design.md` 4.1 有数据位置、称呼、连接模型、工作区、蝶君五步；如果改为 Chatbox 式对话或去掉模型配置，会改变该流程，需单独决定；`v0.12-frontend-spec.md` B1/F2 的蝶君选择和保留数据处理仍须遵守。
- 托管版隐藏/锁定渠道与模型组可能触及 `settled-behaviors.md` 第 4、5、10 条；变更模型选择器涉及第 11 条；把钱或模型显示移位涉及第 8、16 条。仅更换文字或保留外观不能证明原有操作仍然满足。具体冲突及双版测试见 `06-方案-两个版本.md`。
- 不为完成调研而登录、注册、授权、发送、下载或安装；若未来安排实机观察，须另行确认隔离环境、凭据和隐私边界，记录具体版本和现场证据。当前 DreamFlutter 副本因隔离未证实而未启动，不能把本记录当双产品操作对照。
