# 加深 06C：Cursor 从首次安装到第一个任务

检索日期：2026-11-14（Asia/Taipei）。只读 Cursor 官方公开网页；**未下载、安装、注册、登录、提交表单或运行 Cursor**。下文是文档中描述的路径和条件，不是本轮实机走查。官方站点可能针对不同版本、地区或订阅体系提供不同说明，发行前应重新核实。

这是一条**从安装、理解项目到完成和审阅改动的教程路径**：教程按主题组织，不能把段落或操作数当成首次向导屏数；网页中的示例请求也不是证据证明应用空状态显示了这些示例。[官方安装帮助](https://prod.cursor.com/help/getting-started/install)宣称几分钟内可运行软件；这是其宣传性定位，不是本轮实测时长，也不保证完成首次完整任务。

## 1. 逐步路径与证据

| 步骤与前提 | 官方说明或教程中的用户动作 | 可见反馈 / 失败 / 尚未核实 | 官方直链 |
|---|---|---|---|
| 1. 准备系统、账号与费用 | 官方快速开始列出 Windows 10 及以上和对应安装器；安装帮助以 Cursor 账号作为前提。先确认系统、版本、计划及所需服务。 | 当前安装包下载量、磁盘、地区访问、注册方式、所有系统版本和实际界面未核实；文档说可免费开始，不等于无限使用或所有功能免费。账号授权与数据处理需要用户自行查看当时政策。 | [Quickstart](https://cursor.com/docs/get-started/quickstart)、[安装帮助](https://prod.cursor.com/help/getting-started/install)、[方案与价格](https://prod.cursor.com/help/account-and-billing/pricing) |
| 2. 安装并登录 | 帮助文档描述获取对应系统安装程序，Windows 运行安装器后启动应用，并在提示时登录账号。之后选择一个项目文件夹。 | 本轮不下载和启动。安装画面顺序、是否必须重启、安装失败提示和登录完成后的界面均未实测。此前检索曾记录旧安装文档的不同描述，但该地址现重定向到文档首页，原文无法直接复核；无账号时的实际可用范围未知。 | [安装帮助](https://prod.cursor.com/help/getting-started/install)、[Quickstart](https://cursor.com/docs/get-started/quickstart) |
| 3. 打开项目 | 官方“第一个项目”指导在应用的 File > Open Folder 中选择项目目录，然后打开 Agent。 | 文档描述正常路径，没有为本次研究提供选错目录、无权限或空文件夹的具体屏幕；索引状态、项目安全边界、可用文件和上传政策应先核实。项目文件夹不是教程中的 AI 服务账号。 | [第一个项目](https://prod.cursor.com/help/getting-started/first-project) |
| 4. 先理解项目 | Quickstart 建议打开 Agent，询问代码库的主要入口、关键模块和改动前应看的内容；官方项目帮助记载 Windows/Linux 的面板快捷键 Ctrl+I。另有 Ask 模式用于不修改文件地理解代码。 | 预期得到搜索/阅读后的项目概述；内容是否完整、准确、引用是否可核实由用户判断，不能把 AI 概述当验收。快捷键属于 Cursor 文档，不能套用 DreamFlutter。具体模式切换与版本须核实。 | [Quickstart](https://cursor.com/docs/get-started/quickstart)、[第一个项目](https://prod.cursor.com/help/getting-started/first-project)、[Agent 模式](https://cursor.com/help/ai-features/agent) |
| 5. 补充上下文或排查缺失文件 | 项目帮助描述输入 `@` 指向文件或文件夹；故障帮助建议检查忽略规则、检查索引或提供具体文件。 | 不能据此认为 Agent 已读取所有文件；回答未提到某文件不等于它不存在。访问限制影响检索；文档特别说明忽略规则不能阻止终端或 MCP 工具读取，因此不能把忽略文件当作绝对安全边界。本轮没有创建、读取或更改任何项目忽略文件。 | [第一个项目](https://prod.cursor.com/help/getting-started/first-project)、[Agent 故障排查](https://prod.cursor.com/help/troubleshooting/agent-issues)、[Ignore file](https://cursor.com/docs/reference/ignore-file) |
| 6. 选小任务并说明要求 | Quickstart 先建议让 Agent 给出几个小改进、解释取舍，再由人选择一个；也可直接描述明确目标。网页举的改文案、修小界面等是教程示例。 | 用简单任务降低首轮复杂度是该教程的建议，不是有对照实验支持的效果结论；网页示例**不是应用首页空状态截图**。项目是否适合修改、有没有测试与备份应由使用者确认。 | [Quickstart](https://cursor.com/docs/get-started/quickstart)、[理解代码库](https://prod.cursor.com/learn/understanding-your-codebase) |
| 7. 提交请求并观察 Agent 工作 | 官方帮助描述在 Agent 输入需求、发送后，Agent 可搜索、编辑并展示变化；可用 Stop 中断。 | **区别审阅与落盘**：官方帮助及安全文档说工作区文件可能在操作过程中直接写入；不是必须先点击“接受”才第一次写文件。配置文件、终端、MCP 的审批取决于具体版本及配置，不能假设所有变更都需要先批准。自动重载可能在审阅前执行变更。 | [Agent 模式](https://cursor.com/help/ai-features/agent)、[Agent 安全](https://prod.cursor.com/docs/agent/security) |
| 8. 查看差异、验证、必要时恢复 | 完成后 Quickstart 建议检查 diff，并请 Agent 运行项目已有测试、类型检查、lint 或构建；官方帮助说明可审阅差异或拒绝不想要的改动。Agent 文档还描述从检查点恢复文件。 | 检查点和 diff 不等于测试通过，也不代表所有外部副作用能撤销；官方说明检查点恢复的是文件，不删除聊天消息。旧的逐文件审阅文档链接现重定向至首页，具体粒度待对应版本复核。测试命令可能改变文件或运行程序，实际审批和边界须按配置判断；本轮未运行任何命令或变更。 | [Quickstart](https://cursor.com/docs/get-started/quickstart)、[第一个项目](https://prod.cursor.com/help/getting-started/first-project)、[Agent 模式](https://cursor.com/help/ai-features/agent) |
| 9. 下一步：复杂任务先规划 | Quickstart 把 Plan Mode 作为更大、跨文件任务的下一步：先研究、澄清和提出计划，再由人审阅。 | 这是教程中的可选后续，不是首次任务成功的必要条件；计划准确性和审批默认值随产品版本及设置可能不同。 | [Quickstart](https://cursor.com/docs/get-started/quickstart)、[Agent 模式](https://cursor.com/help/ai-features/agent) |

## 2. 账号、模型 Key、订阅和数据边界

- **账号：**目前的[安装帮助](https://prod.cursor.com/help/getting-started/install)将 Cursor 账号列为前提，并说安装后登录；此前旧安装说明的地址现重定向首页，无法直接复核旧说法；因此这里只把“官方当前教程路径要求登录”作为结论，不保证登录前的全部能力或不同时点的登录流程。
- **自带还是自配 Key：**官方 Quickstart 的首次使用步骤没有要求先填写第三方模型 API Key；[自带 Key 说明](https://cursor.com/help/models-and-usage/api-keys)另描述用户可自行接入部分服务商密钥、自付提供商费用，但有模型及功能范围限制。这支持“账号和可用方案下存在不先填第三方 Key 的教程路径”，**不能推出安装包内有可提取的通用 Key、无限额度或所有账号地区均可使用**。自带 Key 文档也说明请求经 Cursor 后端，并区分相关数据保留政策；平台侧费用或额度还需按账号、计划和模型另核，具体条款以实际账号/版本为准。
- **免费/付费与版本差异：**本轮较早检索曾见旧方案口径；2026-11-14 再次核对时，[方案帮助页](https://prod.cursor.com/help/account-and-billing/pricing)同时区分当前新方案与标明 legacy 的旧方案，[价格页](https://cursor.com/pricing)展示当前方案。免费使用有条件和限制；账号适用体系、资格、额度、模型、额外费用和地区须按当时条款核实，不能推断所有用途免费。
- **审批规则有版本/页面差异：**[Agent 安全页](https://prod.cursor.com/docs/agent/security)写终端命令默认需批准；[终端帮助](https://prod.cursor.com/help/ai-features/terminal)对 3.6 及以后版本描述默认 Auto-review，[Run Modes](https://cursor.com/docs/agent/security/run-modes)说明该模式可能自动运行允许项或在沙箱运行，不保证所有命令都人工确认。不得将其中一种写成所有版本统一默认；Auto-review 官方明确不是安全边界。工作区文件可能立即保存，审阅后拒绝与“执行前批准”不同。
- **隐私不是零风险断言：**[官方安全说明](https://www.cursor.com/security)描述请求处理和隐私模式；[忽略规则](https://cursor.com/docs/reference/ignore-file)另说明索引范围与限制，并明确终端和 MCP 不受该规则完整约束。不同模式/服务商的日志与数据处理应按实际政策核实，不能凭“有忽略文件”推断私有代码绝不会外发。

## 3. 路径中的失败点与未查证内容

1. **安装或启动失败：**[官方故障页](https://prod.cursor.com/help/troubleshooting/install-issues)提供不同系统的排查建议；其中包括管理员运行、卸载或清理等高影响步骤。此处只记录有该文档，未在用户电脑执行，也不把它们当作本任务建议。
2. **登录失败：**[官方登录网络说明](https://prod.cursor.com/help/troubleshooting/sign-in-domains)讨论企业网络允许列表和登录域名迁移；这是特定网络条件下的说明，不代表本机故障原因，更未验证地区可用性。未改变系统、代理或防火墙。
3. **Agent 没找到文件：**[Agent 故障排查](https://prod.cursor.com/help/troubleshooting/agent-issues)给出检查忽略规则、索引和明确引用文件的思路；索引完成时间、实际遗漏和错误文案都没有在本轮测得。
4. **改错文件或未通过检查：**文档提供差异审阅、拒绝和文件检查点；未证明所有命令副作用、网络请求、外部服务和用户数据均可自动回滚。需要核实操作范围和保存情况。
5. **未核实：**首次向导真实屏数、能否跳过每一步、截图中的空态和示例、免费计划精确限额、各地区支付及网络条件、后台模型具体密钥与路由、实机耗时、任何真实项目的成功率和错误恢复。

## 4. 对 DreamFlutter 的待验证建议

**建议，尚未据此修改设计。** 面向 DreamFlutter 的用户与 Cursor 开发者不完全相同；以下是对照假设，不是证实有效的经验数据：

1. 利用既有工作台首页示例与输入框，以一个低风险文字任务帮助用户完成首次交流；先通过安全隔离副本确认示例点击是否自动发送。保留已定型第 15 条首页标题/引文关系和第 1–2 条蝶君直接对话；不另起页面或增加常驻说明。
2. 使用指南可按“知道想做什么 → 描述任务 → 查看结果 → 处理失败”组织，并说明文件操作、审批与风险；不要照搬 Cursor 的编辑器术语或快捷键。工作区仍位于侧栏，右栏文件预览与审批保留已定型第 6–7 条。
3. 项目读取、云模型及托管服务的数据去向、费用和必要权限在任务发生前提供已核实的信息；不能只靠悬停。开放版与托管版的模型配置差异、服务方、预算和隐私仍须用户决定，不能借 Cursor 的账号模式推定实现。
4. 当前 DreamFlutter 文档中已有变更与右栏预览设计；先实测真实反馈、恢复与审批边界，再由 Claude 评估是否有新手不懂的部分。不能据 Cursor 的“先落盘再审阅”改变 DreamFlutter 的已定型流程，也不能声称现有回滚覆盖命令/网络副作用。
5. 证据仍以 Q1 安全隔离后的走查和真实初学者测试为准；本次网页教程及示例不是产品 UI 实测，也不证明某方案能提升完成率。

## 公开方案页面的模型描述差异

2026-11-14 只读核对时，[Cursor 价格页](https://cursor.com/pricing)对 Plus 写仅含 Grok 模型；[官方方案帮助](https://prod.cursor.com/help/account-and-billing/pricing)则称付费方案包含的模型池列有 Grok 与 Composer，并称 Plus 可用这些模型的固定设置。两页的具体表述并不完全一致；是否涉及更新时点、不同计划或其他条件，本轮无法判断。用户实际账户适用方案、可用模型和费用需在使用前依据当时账户和官方说明核实；不从任何一页推断所有账户都有同一模型、统一免费额度或地区资格。本轮未登录、购买或请求模型。
