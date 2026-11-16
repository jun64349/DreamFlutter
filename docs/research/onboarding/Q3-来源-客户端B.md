# Q3 官方资料：五款客户端的上手方式（B）

检索日期：2026-11-14（Asia/Taipei）。这里只阅读公开官方页面；**没有实际安装、登录、注册、提交表单或运行产品**。文档中的“快速开始”步骤数不等于实际首次启动向导页数；页面示例不等于已确认应用首页空状态。套餐、地区、产品版本及官方页面会变化，请以对应页面和实际产品为准。

OpenAI 部分先检查本机 `openai-docs` 技能及其可用本地资料目录；未找到能回答 ChatGPT 桌面端首次使用的本地事实文档，转而查阅、打开 OpenAI 官方域名页面。下述 ChatGPT 桌面文档区分 ChatGPT 与同一桌面应用中的 Codex，不能把 Codex 的认证选项直接说成普通 ChatGPT 的必经步骤。

## 1. ChatGPT 桌面端

- **官方快速开始**：[ChatGPT desktop app](https://learn.chatgpt.com/docs/app) 的文档列四个阶段：安装、用 ChatGPT 账号登录、选择聊天/项目/文件夹、发送第一条消息。该快速开始路径写用 ChatGPT 账号登录；这不是在断言它是桌面应用唯一的认证方式。这四个阶段是网页教程的组织方式，实际安装向导有几屏未核实。
- **密钥与模型**：上述快速开始路径使用账号，并在最后区分 ChatGPT 与 Codex，没有要求用户输入 API Key。另据 [Authentication](https://learn.chatgpt.com/docs/auth)，桌面应用中的 **Codex 本地工作**支持 ChatGPT 登录或 API Key；API Key 走 API 计费，依赖 ChatGPT 工作区或云服务的部分能力会受限。该认证文档不足以证明 API Key 可用于普通 ChatGPT 的全部功能，也不应把它当作普通聊天的必填条件。免费额度、地区、默认模型和所有版本的可用性未由这两页完整确定。
- **示例与空态**：官方桌面介绍页给出整理工作、分析文件等用例；这些是**网页上的用例**，不能断言桌面新聊天空态会展示同样卡片或文字。[官方桌面介绍](https://learn.chatgpt.com/docs/app)

## 2. Claude 桌面端

- **官方开始方式**：[Install Claude Desktop](https://support.claude.com/en/articles/10065433-install-claude-desktop) 对 macOS/Windows 描述下载、安装、打开并用账号登录；这是安装说明，实际向导页面数、是否有跳过项未核实。
- **密钥与模型**：该页的桌面 Chat 一栏列出 Free 也可使用，普通聊天开始流程是账号登录，没有把第三方 API Key 作为必填步骤；可用能力依计划而异。一般 [Get started with Claude](https://support.claude.com/en/articles/8114491-get-started-with-claude) 说明在聊天中输入请求、桌面端输入框附近显示当前模型并可选择可用模型；免费计划有限额。它是 Claude 通用入门资料，不等于本次亲自验证了桌面默认值。
- **示例与空态**：通用入门页建议从简单、明确的问题开始并逐步追问；本轮未核实桌面首页是否有可点击示例、实际空态文案及具体引导页数。

## 3. Cursor

- **官方开始方式**：[安装指南](https://prod.cursor.com/help/getting-started/install) 说明准备 Cursor 账号、安装并登录，再打开项目文件夹。[快速开始](https://prod.cursor.com/docs/get-started/quickstart) 以五个编号主题引导安装登录、理解代码、尝试改动、审阅结果和更大任务的计划模式；**这是文档教程五部分，不是已核实的首次向导五屏**。
- **密钥与模型**：[计划说明](https://prod.cursor.com/help/account-and-billing/pricing) 表示 Free 计划可有限使用 Agent、Chat 和 Tab，使用 Cursor 提供的模型；额度与供应会变。官方另提供[自带 API Key](https://cursor.com/help/models-and-usage/api-keys) 作为选择，由模型提供方计费；不能把自带 Key 当作每位新用户开始使用的唯一方式。
- **示例与空态**：[第一个项目](https://prod.cursor.com/help/getting-started/first-project) 给出了打开 Agent、输入一个小型界面改动请求、发送并审阅差异的例子；这是**网页教程示例**。未实测或确认新安装后的实际空状态和建议按钮。

## 4. TRAE（中国版官方文档）

- **官方开始方式**：[TRAE 桌面快速开始](https://docs.trae.cn/ide_get-started-with-trae) 介绍下载后首次设置可涉及主题、语言、导入配置、命令行和账号登录，再打开本地项目；页面分别列出多个操作，不足以推断它们实际是否逐屏、是否可跳过。它写有本地文件夹和克隆仓库入口；文档是中国版，国际版可能不同。
- **密钥与模型**：[内置模型](https://docs.trae.cn/ide_trae-built-in-models) 说明 Auto 可在 TRAE 的内置模型间选择，但不调用自定义模型；[自定义模型](https://docs.trae.cn/ide_custom-models) 是另一个配置入口。[套餐与计费](https://docs.trae.cn/ide_plans-and-billing) 称模型可用范围因套餐而异，内置模型消耗积分。截至本次检索，该页列出免费用户每月登录赠 500 积分、新用户注册一次性赠 2000 积分（各有有效期）；这是中国版页面列示的规则，不保证每个账号或地区实际可领，也不是无限免费使用。
- **示例与空态**：快速开始文档列“打开文件夹”“克隆 Git 仓库”等第一步；这是文档中的入口说明，未实际确认客户端的首页空态是否仍一致，也未找到可靠的首次任务示例卡片证据。

## 5. Raycast AI

- **官方开始方式**：[Quickstart](https://manual.raycast.com/quickstart) 按七个编号主题介绍搜索、操作面板、快捷链接、快捷键、AI、扩展及日常功能；AI 部分说明可从 Root Search 按 Tab 进入 Quick AI，或打开 AI Chat。这是**教学路线七项**，不是实际启动向导七屏。账号首次建立路径、实际向导屏数和跳过方式未核实。
- **密钥与模型**：[计费说明](https://manual.raycast.com/billing) 将 Raycast AI 列为付费计划能力，Free 不含 AI；[AI Chat](https://manual.raycast.com/ai/ai-chat) 说明 Auto 从 Raycast AI 模型中选用一个，减少手选模型的需要。官方另有[自带订阅](https://manual.raycast.com/ai/bring-your-own-subscription)与自带 Key/本地模型等可选路径：自带订阅另需对应提供商订阅及命令行工具；不要将它说成 Raycast AI 唯一入门方式。
- **示例与空态**：[自带订阅说明](https://manual.raycast.com/ai/bring-your-own-subscription) 只对选择 Claude 订阅模型的情况说明空输入框可显示建议提示、用 Tab 或右箭头插入。不能推断所有模型、计划或新用户都看到同一空态。Quickstart 的扩展示例是网页中的操作示范，不是已确认的首次启动向导内容。

## 对本项目可用的启发与不能直接推断的事

- **文档可复现的小任务**：Cursor 将首次体验组织成理解项目、做小改动、审阅结果；Raycast 让用户先练习常见操作。这些是公开教程思路，可用于起草可跳过的入门材料；没有证据证明它们一定优于 DreamFlutter 的既有设计。
- **减少首次 Key 概念**：ChatGPT/Claude 账号登录与 Cursor/TRAE 的产品内模型路径显示，存在不要求用户先自行填写第三方 API Key 的产品路径；登录、服务供给、额度、成本和地区可用性仍有各自条件。Raycast 的 AI 还受付费计划限制。
- **空态证据缺口**：除上面明确写出的 Raycast 特定订阅模型占位提示外，本组没有经过应用实测的首页空态和向导屏数。不得把官方网页中的案例、步骤或宣传图写成亲测页面。
- **DreamFlutter 的约束**：这只是调研材料。任何界面方案须由 Claude 依据现有原型和已定型规则设计；涉及已定型交互的建议需用户决定，尚未据此修改设计。
