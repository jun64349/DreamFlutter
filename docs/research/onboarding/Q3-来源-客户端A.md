# Q3 官方资料摘录：五款 AI 客户端

检索日期：2026-11-14（台北时间）。以下为公开官方资料的文字走查，未安装或启动产品，未登录、注册、提交表单或下载模型。文档描述不等于本机实测；版本、地区、可用模型和额度会变化。这里的「步骤」指文章中记载的动作，不代表首启向导的屏数或所有用户必经路径。

## Cherry Studio

**资料范围：**桌面版官方文档，页面未标明适用的具体客户端版本。平台间差异及当前安装包行为未验证。

- [Desktop Quick Start](https://cherryai.com/docs/en/getting-started/quick-start/) 记载了一条使用外部模型服务的路径：安装后进入设置中的模型服务商，填写该服务商的 API Key，同步或添加并启用模型，选择助手和模型后发送消息。这是文档给出的路径，并不证明每条路径都要求自备 Key。文章按安装、选择服务商、添加并启用模型、发送第一条消息四个主题组织，不能据此认定界面只有四屏。
- [CherryAI（Free）](https://cherryai.com/docs/en/pre-basic/providers/cherryai/) 描述内置预配置的免费模型服务，无需第三方注册或第三方 API Key，通常不需额外配置。文档列出可用模型与额度；实际可用性和限制可能变化。该文字不足以证明任何地区或版本都无需 Cherry 自身账号，也不代表无限免费。
- [Ollama 集成](https://cherryai.com/docs/en/pre-basic/providers/ollama/) 提供另一条本地路径：单独准备并运行 Ollama 服务、配置服务商并选择本地模型。默认 Ollama 配置通常无需 API Key；本地部署仍有硬件和模型文件获取成本，具体环境可能另有认证配置。[Ollama 认证文档](https://docs.ollama.com/api/authentication)另说明本机 API 默认无需认证，也可在登录后通过本机 API 调用云模型；直接访问云 API 需要 Key。因此地址在本机不等于所选模型一定在本机推理，实际数据路径仍须核实。
- **未核实：**全新安装时实际出现的欢迎页、空聊天示例、上述各路径是否在首屏可见，以及不同系统和地区的实际可用性。

## Chatbox AI

**资料范围：**官方入门指南涵盖桌面与移动端，未固定客户端版本；下述引导具体内容来自文档，不是本机首启截图。

- [Your First Chat](https://chatboxai.app/en/guide/getting-started/first-chat) 描述首次启动时提供新手引导或跳过的选择；引导路线介绍托管的 Chatbox AI，转到浏览器登录并授权，回到客户端开始新对话。没有账号的用户可能需要先注册；页面提到登录后可领取有每日额度的免费许可，具体资格和额度以当时服务为准。文章列有六项编号动作，不能当成六个实际界面或所有路径共同步骤。
- [Choose Your Provider](https://chatboxai.app/en/guide/getting-started/choose-provider) 同时介绍托管 Chatbox AI 和自行配置其他服务商的选择。托管路径不要求用户手动填写第三方 API Key，但上述入门路线涉及账号登录；自带服务商的路径可能要求对应的 Key。文档也介绍通过提供商配置连接 Ollama、LM Studio 等本地服务；是否需要认证取决于所连接服务及其配置，不能一概而论。
- **未核实：**实际新用户是否都看到同一向导、聊天空态是否提供示例提示、不同平台的入口差异，以及目前免费额度和地域资格。未进行登录或授权。

## LobeChat / LobeHub

**资料范围：**用户所列 LobeChat 对应查询到的官方项目资料当前使用 LobeHub 名称；[官方项目 README](https://github.com/lobehub/lobehub) 为当前 canary 分支文档，并非固定发行版。其介绍网页、macOS、Windows、Linux 和移动端入口，具体版本未固定。

- README 介绍内置 Lobe AI 可免去配置开始使用，也列有多服务商、本地模型和自托管能力。这些概述不足以确认某个平台首启每一步、是否必须登录，或所有路径都不需自行提供 Key。
- [官方价格页](https://lobehub.com/pricing) 列出有限使用量的免费档和标准模型；它不能单独证明某地区、某桌面版本或未登录用户的可用资格，方案可能变化。
- **资料获取与限制：**较早网页文本通道取得迁移占位；后续普通 HTML 只读取得 [Getting LobeHub](https://lobehub.com/docs/usage/getting-started/get-lobehub) 和 [Introduction](https://lobehub.com/docs/usage/start) 正文。前者描述 Web 使用账户登录，桌面云模型/同步/在线工具需网络；后者介绍 Agent、Topic 与 Task。两页均不能证明首次向导的实际屏数或界面。
- **未核实：**首启具体屏数、空态或示例、各路径完整账号条件与游客资格、本地模型的实际配置步骤，以及产品各版本是否具有一致的内置服务。没有用官方概述推断完整向导。

## Jan

**资料范围：**桌面端官方文档，覆盖 Windows、macOS 和 Linux；[桌面概览](https://docs.jan.ai/desktop) 本次显示 0.8.6，具体 [Quickstart](https://docs.jan.ai/desktop/quickstart) 页面未固定版本，不能保证已安装的其他版本相同。

- Quickstart 描述安装并启动后自动下载默认基础模型，随后可进行本地对话；本地默认模型在设备上运行，无需云服务 API Key。模型文件必须先取得；云服务商路线则按文档配置对应 API Key。本次没有下载模型或测试对话。
- 同一指南提供可用于尝试的提问例子，并介绍在模型中心查看模型与硬件的适配情况。这些例子出现在**文档**中，不能推断应用的空聊天页面一定显示它们。
- [Windows 安装指南](https://docs.jan.ai/desktop/install/windows) 当前列出 Windows 10 及以上、最低 8 GB 内存与 10 GB 可用存储，推荐 16 GB 内存；实际可用模型和性能仍取决于设备及模型。
- **未核实：**实际首次运行的屏幕顺序、模型下载耗时与失败恢复、不同平台首启差异、应用内空态和真实对话效果。

## LM Studio

**资料范围：**桌面应用官方文档，适用于 Windows、macOS 和 Linux 的一般功能；下列页面未固定版本。

- [Get started](https://lmstudio.ai/docs/app/basics) 描述检查硬件、安装，在 Discover 中查找并下载模型，再到 Chat 中选择或载入模型并开始对话；也可使用已有模型文件。它是文档所述的入门路径，不能视为已经验证的固定首启向导或固定屏数。
- [Offline operation](https://lmstudio.ai/docs/app/offline) 说明模型文件与兼容运行时已具备后，本地聊天等核心功能可离线使用；发现和下载新模型或获取运行时可能需要网络，也可导入已有文件。由此可推断，**本地模型聊天路径**不依赖云 API Key；硬件、存储及取得模型文件仍是前提。此推断不覆盖所有云模型或联网功能，也不能证明全部路径的账号要求。
- [Bionic 模型路径](https://lmstudio.ai/docs/bionic/models) 另述云模型服务需要登录 LM Studio 账号并配置计费和额度；这是云服务路径的条件，不应推广成本地聊天的通用前置条件。
- **未核实：**实际首启界面、聊天空态或示例、具体下载速度、模型硬件兼容性及普通本地使用的全部账号条件。

## 可供后续方案使用的观察边界

这些资料显示，官方文档中存在预配置托管服务、自备服务商和连接本地模型等不同入门路径；各路径可能分别引入账号、额度、Key、模型下载或硬件条件。上述条件不能互相替代，也不能直接当作 DreamFlutter 当前实现或真实新手成功率。五款产品均未在本次任务中实机试用；需要比较真实屏数、失败率或理解成本时，应另行安排有权限的用户测试。
