# Raycast AI：从安装到首次任务的官方资料拆解

> 检索日期：2026-11-14（台北时间）。来源为 Raycast 公开产品页面和手册，主要是当前手册中的 v2 路径；手册页面未统一标注构建号与更新时间。本次没有安装、下载、登录、注册、提交请求或输入密钥。下述是文档教程，不等于实机向导屏数、空态或亲测结果；区域、账户、版本和计划可能改变路径。

## 官方路径

| 环节 | 文档所述 | 必要性与未核实之处 |
| --- | --- | --- |
| 1. 系统和安装 | [Windows 产品页](https://www.raycast.com/windows)主文标示 Windows 10+，FAQ 更具体列 Windows 10 21H2+ 和 Windows 11；[产品首页](https://www.raycast.com/)列出当前 Mac 产品所需系统和芯片，并另有旧版。 | 本次只看公开页；不同构建、旧设备、地区的安装及初次启动情况未知。不能把 Mac 当前版本要求推成所有历史版本或 Windows 的要求。 |
| 2. 唤出主搜索 | [Quickstart](https://manual.raycast.com/quickstart)介绍呼出 Raycast 主搜索、搜索命令和使用快捷操作。 | 文档的章节或教程步骤数不是首次启动的向导屏数；快捷键实际配置、首次界面及系统权限请求未实测。 |
| 3. 账户与可用计划 | [计费手册](https://manual.raycast.com/billing)介绍创建账户、付费计划及符合条件的 Pro 试用；[额度说明](https://manual.raycast.com/ai/ai-credits)写明 Free 不包含 AI。 | 具体地区能否注册、支付方式是否受限、基础免费功能是否可完全不登录、每个用户能否试用及试用需不需要预先提供支付方式，均未核实。 |
| 4. 提交首个问题 | [Quick AI](https://manual.raycast.com/ai/quick-ai)说明在主搜索输入问题后按 Tab 会把文字交给 Quick AI 并提交；空搜索按 Tab 可打开空输入，再输入并按 Enter。也可从 [AI Chat](https://manual.raycast.com/ai/ai-chat)发起对话。 | Tab 在已有文字时包含提交动作，不能把它描述成始终只打开空界面；官方文档还描述答复出现后 Enter 默认把答复粘贴到先前应用，这是不同状态且可调整，不是输入问题时的发送动作；额度、网络与计划符合条件仍不保证响应成功。本次没有发送问题。 |
| 5. 选择和调整 | [Quick AI](https://manual.raycast.com/ai/quick-ai)描述 Auto、模型切换和上下文附件；[AI Chat](https://manual.raycast.com/ai/ai-chat)说明聊天方式。 | 默认模型、可见选项、联网与附件行为可能因版本、计划和配置变化；是否首屏即显示这些选项未验证。 |

## 计划、Key、额度与隐私

- [计费手册](https://manual.raycast.com/billing)将 7 天 Pro 试用和 500 试用积分作为所述条件下的试用规则；已在结账时开通 Pro 订阅的用户，试用结束后可能按所选周期扣费。不要把试用当作所有地区、所有账号永久享有的承诺，也不要推断所有试用都必须先填支付信息。
- [AI Credits](https://manual.raycast.com/ai/ai-credits)列出付费计划的月额度，积分用量依模型及请求内容变化；积分不是固定对话条数。额度耗尽与供应商限流不同，文档给出各自处理方向；金额、有效期和模型可用性应以当时账户页面为准。
- [Bring Your Own Key](https://manual.raycast.com/ai/bring-your-own-key)把自带 Key 列为 Pro 专享，模型调用费用由相应供应商按其规则收取；Raycast 自身计划与供应商收费不能混为一谈。无需据此断言内置服务必须填第三方 Key，本次没有输入任何凭据。
- [Local Models](https://manual.raycast.com/ai/local-models)描述通过 Ollama 使用本地模型，并要求 Raycast 付费计划；另需本地运行环境、模型文件和足够硬件，本次均未安装或下载。模型在本地推理不代表所有附加功能和数据处理均离线；[官方隐私说明](https://manual.raycast.com/ai/raycast-ai-privacy-security)另列云处理与附件相关条件，具体应按功能与设置核对。

## 文档冲突、故障和未核实项

- [AI Credits 的 v1 过渡说明](https://manual.raycast.com/ai/ai-credits)写到 2026-12-17 起额度耗尽后的例子，却在同一示例给出更早的 2026-10-15 等待日期；这两个日期在示例中前后不一致，不能将示例日期当作实际个人重置日。当前账户、v1/v2 与未来规则须再核实。
- [Quick AI 故障栏目](https://manual.raycast.com/ai/quick-ai)列出快捷键、模型选择、同步、额度或上下文限制等类别；尚未测试这些故障的实际提示、恢复过程和草稿保留。网络或地区限制、Windows 与 macOS 的功能差异及首个任务失败后的可见状态也未核实。

## 对 DreamFlutter 的待验证建议

1. 让用户在现有位置理解发送动作、当前使用的服务与可用额度；提交前是否确有疑惑须通过后续用户研究验证。Raycast 在主搜索已有问题时按 Tab 立即提交是其文档行为，不应因此改变 DreamFlutter 已定型输入交互。
2. 将额度不足、上游限流、网络失败、自带服务商验证失败分开设计可恢复提示；任何权限、附件传输或额外费用应在相关操作附近按需说明，避免堆叠无必要说明。
3. 遵守 [已定型清单](../../design/settled-behaviors.md)、[0.12 前端规格](../../history/v0.12-frontend-spec.md)和避免多余说明原则；前端设计由 Claude 负责。以上仅为建议，尚未据此修改设计或证明已获批准。
### 本地推理的数据边界补充

依据 [Local Models](https://manual.raycast.com/ai/local-models) 与 [隐私说明](https://manual.raycast.com/ai/raycast-ai-privacy-security)：文档所述本地 Ollama 对话本身不消耗 Raycast AI 积分，但图像生成等由云端完成的步骤仍需要联网并消耗积分；也可以把 Ollama Host 指向另一台机器，不能一律称为本机处理。厂商说明 Cloud Sync 开启时可能同步聊天；图片附件默认可能上传，但关闭 Cloud Sync 或不同步 AI Chat History 时，发送给本地模型的图片保留在设备上。AI Memory 开启时，近期聊天可能由 Raycast 托管模型处理。此处仅转述官方文档的条件，未进行网络抓包或隐私审计，也不保证绝无其他数据流。
