## Antigravity 调研结果
- 状态：成功
- 耗时：357.9s
- 工作目录：`E:\claude\DreamFlutter`
- 权限：只读预期

### 最终回复
# 桌面 AI Agent 安全管理调研报告（2024–2026）

> **报告属性**：桌面端/本地 AI 代理（Desktop / Local AI Agent）安全防护与架构设计基准报告  
> **时间范围**：2024 年至 2026 年最新架构与标准  
> **调研基准**：严格依据各产品官方文档、技术白皮书、官方代码仓库；凡无官方明确背书或仅属社区猜测的内容均标注「**未证实**」。

---

## 目录
1. [调研对象与官方参考矩阵](#1-调研对象与官方参考矩阵)
2. [分主题多维技术对比](#2-分主题多维技术对比)
   - 2.1 [权限模型与审批机制（工具级/命令级/路径级）](#21-权限模型与审批机制工具级命令级路径级)
   - 2.2 [沙箱与操作系统隔离（Windows 实现与网络出站）](#22-沙箱与操作系统隔离windows-实现与网络出站)
   - 2.3 [提示注入防护（网页、代码、文件与 MCP 间接注入）](#23-提示注入防护网页代码文件与-mcp-间接注入)
   - 2.4 [密钥与凭据管理（存储、上下文脱敏、日志打码）](#24-密钥与凭据管理存储上下文脱敏日志打码)
   - 2.5 [操作审计日志与溯源体系](#25-操作审计日志与溯源体系)
   - 2.6 [MCP 与第三方技能/插件的信任与隔离](#26-mcp-与第三方技能插件的信任与隔离)
   - 2.7 [敏感路径保护（.ssh、凭据、浏览器与系统目录）](#27-敏感路径保护ssh凭据浏览器与系统目录)
3. [现状对比与差距分析（Gap Analysis）](#3-现状对比与差距分析gap-analysis)
4. [「我们缺什么、建议做什么」优先级路线图](#4-我们缺什么建议做什么优先级路线图)

---

## 1. 调研对象与官方参考矩阵

| 调研对象 | 定位与形态 | 官方出处与权威文档链接 |
| :--- | :--- | :--- |
| **Claude Code** | Anthropic 官方终端 Agent CLI | [Anthropic Claude Code Docs](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code) / [GitHub: claude-code](https://github.com/anthropics/claude-code) |
| **OpenAI Codex CLI / 桌面版** | OpenAI 官方代码 Agent CLI 及桌面端集成 | [OpenAI Developers Docs](https://platform.openai.com/docs) / [OpenAI Codex Repo](https://github.com/openai/codex) / [Work with Apps](https://help.openai.com/en/articles/10119602-work-with-apps-on-macos-and-windows) |
| **Cursor** | Anysphere 开发的 AI 原生 IDE（含 Composer/Agent） | [Cursor Security Overview](https://docs.cursor.com/cloud-agent/security) / [Cursor Sandbox Reference](https://docs.cursor.com/reference/sandbox) / [Cursor Run Modes](https://docs.cursor.com/agent/security/run-modes) |
| **OpenHands** | All-Hands AI 开源软件开发 Agent（原 OpenDevin） | [OpenHands Documentation](https://docs.all-hands.dev) / [GitHub: OpenHands](https://github.com/all-hands-ai/OpenHands) |
| **Goose** | Block 开源并捐赠给 Linux 基金会 AAIF 的本地 Agent | [Goose Documentation](https://block.github.io/goose/) / [GitHub: goose](https://github.com/block/goose) |
| **Cline** | 开源自主编码 Agent（VS Code 插件，原 Claude Dev） | [Cline 官方站点](https://cline.bot) / [GitHub: cline](https://github.com/cline/cline) |
| **Windsurf** | Codeium 推出的 AI 原生 IDE（核心 Agent 为 Cascade） | [Windsurf by Codeium](https://codeium.com/windsurf) / [Codeium Security Whitepaper](https://codeium.com/security) |
| **OWASP 安全标准** | 国际 Web 与生成式 AI 安全权威标准项目 | [OWASP Top 10 for LLM (2025/2026)](https://genai.owasp.org/llm-top-10/) / [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/agentic-security-initiative/) |

---

## 2. 分主题多维技术对比

### 2.1 权限模型与审批机制（工具级/命令级/路径级）

在自主 Agent 系统中，权限控制已从粗粒度的“单次确认”演进为**工具（Tool）、命令（Command/Shell）、路径（Path）三层复合防护**。

```
[用户授权边界]
  ├── 工具级（Tool-level）：限制是否允许调用 Bash / Edit / Fetch / MCP
  ├── 命令级（Command-level）：正则/AST 匹配命令白名单（如 npm test:*）与黑名单（如 rm -rf）
  └── 路径级（Path-level）：限定文件读写作用域（仅允许 workspace，拒绝 .env / ~/.ssh）
```

- **Claude Code**：
  - **三态规则集**：支持 `allow`、`ask`、`deny` 三种细粒度规则，配置于 `.claude/settings.json` 中。
  - **工具与命令级白名单**：支持语法形如 `Bash(npm run test:*)` 的模式放行，禁止未申报命令；对高危命令默认落入 `ask`。
  - **路径级**：支持 `Read(./.env)`、`Read(./secrets/**)` 的显式拒绝。
  - **「总是允许」与企业管控**：提供 `--dangerously-skip-permissions` 参数，但企业管理员可通过 MDM 下发的 `managed-settings.json` 强行锁定并禁用该参数，不可被本地覆盖（来源：[Claude Code Settings Docs](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code)）。
- **OpenAI Codex CLI / 桌面版**：
  - **Profile 与策略分级**：支持只读模式（`net-readonly`、`fs-readonly`）与交互确认模式。
  - **企业强策略**：引入 `requirements.toml` 策略配置机制，企业管理员统一配置安全约束，开发者本地无法提权（来源：[OpenAI Platform Security](https://platform.openai.com/docs)）。
  - **桌面端（Work with Apps / Operator）**：将权限按应用程序隔离，读屏幕/按键注入需系统 Accessibility 显式授权，高风险外发和写操作保留人工阻断机制（来源：[OpenAI Work with Apps Help](https://help.openai.com/en/articles/10119602-work-with-apps-on-macos-and-windows)）。
- **Cursor**：
  - **Run Modes（运行模式）**：包含 `Manual Approval`（手动逐项审批）、`Allowlist / Auto-review`（白名单自动执行）、`YOLO Mode / Run Everything`（无阻断自主运行）。
  - **权限配置文件**：使用 `permissions.json`，提供 `Shell(git)`、`Shell(npm)` 等命令白名单，支持对 `Shell(rm)` 等进行显式 `deny`；针对读写提供 Glob 路径限制（来源：[Cursor Run Modes Security](https://docs.cursor.com/agent/security/run-modes)）。
- **OpenHands**：
  - **内置审批策略（Confirmation Policies）**：
    - `AlwaysConfirm()`：所有操作必须经过人工确认；
    - `ConfirmRisky()`（默认）：通过规则与内置安全分析器判断命令危险等级，仅拦截高风险操作；
    - `NeverConfirm()` / `--always-approve`：全自主放行。
  - **智能二次审查**：支持集成 `LLMSecurityAnalyzer`，利用轻量级独立模型对 Agent 计划执行的 Shell 行为进行二次风险评级（LOW/MEDIUM/HIGH）（来源：[OpenHands Confirmation Modes](https://docs.all-hands.dev)）。
- **Goose**：
  - **审批模式**：支持 `Manual Approval`（每次工具调用手动确认）与 `Autonomous Mode`（自动连贯执行多步工具）。
  - **配置机制**：由 `permission.yaml` 管理工具调用放行状态；命令内部判断相对偏弱，主要依赖上层 MCP 工具维度的放行（来源：[Goose Permissions](https://block.github.io/goose/)）。
- **Cline**：
  - **分类 Auto-Approve 开关**：在 UI 设置中分项提供独立开关：
    - Read files（仅工作区 vs 任意路径）；
    - Edit files；
    - Execute terminal commands（细分为 `Execute safe commands` 与 `Execute all commands`）；
    - Browser Actions 与 MCP tools。
  - **安全判断缺陷**：官方 issue 讨论中指出，其 `safe commands` 依赖内置固定列表与模型启发式推断，对拼接命令、反引号及管道缺乏严格语法解析防护（来源：[Cline GitHub Repo](https://github.com/cline/cline)）。
- **Windsurf (Cascade)**：
  - **四档执行策略**：`Disabled`（全手动）、`Allowlist Only`（仅白名单自动执行）、`Auto`（模型智能判断只读状态并放行安全命令）、`Turbo Mode`（除黑名单外全部自动放行）。
  - **全局白/黑名单**：通过 `windsurf.cascadeCommandsAllowList` 与 `windsurf.cascadeCommandsDenyList` 自定义命令过滤；企业端可由 Admin Portal 强制锁定最大允许模式（禁止员工开启 Turbo Mode）（来源：[Codeium Windsurf Docs](https://codeium.com/windsurf)）。
- **OWASP 标准映射**：
  - **ASI02: Tool Misuse & Exploitation**（工具滥用）
  - **LLM06: Excessive Agency**（过度自主性/过度授权）
  - 核心要求：**Principle of Least Agency**（最小代理原则），禁止未经限制的全局放行。

---

### 2.2 沙箱与操作系统隔离（Windows 实现与网络出站）

在 Windows 上实现本地代码执行隔离是当前桌面 AI Agent 最薄弱的环节。各家方案呈现显著分化：

```
[Windows 隔离层级技术梯队]
 Level 4: 独立 MicroVM / 云端执行环境 (Cursor Cloud Agent)
 Level 3: 本地容器隔离 - Docker Desktop / WSL2 (OpenHands, Claude Code)
 Level 2: Windows 内核机制 - Restricted Token + AppContainer (OpenAI Codex CLI / MXC)
 Level 1: 无内核沙箱 - 宿主机裸进程直接执行 (Cline, Goose, Windsurf 本地端)
```

- **Claude Code**：
  - **Windows 原生情况**：**不支持原生 Windows 内核沙箱**。官方明确说明：在原生 Windows PowerShell/CMD 环境下执行命令为 **完全无沙箱（unsandboxed）**。
  - **Windows 推荐方案**：必须运行在 **WSL2**（Windows Subsystem for Linux 2）内部，借助 Linux 命名空间工具 `bubblewrap`（隔离文件系统）与 `socat`（代理网络）实现沙箱。
  - **网络出站控制**：沙箱内部网络被切断，流量强制经由宿主本地 HTTP 代理，仅允许访问通过 `allowedDomains` 声明的域名白名单，阻断数据外发（来源：[Claude Code Sandbox Docs](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code)）。
- **OpenAI Codex CLI / 桌面端**：
  - **Windows 原生实现**：探索并应用 Windows 原生内核级机制：**Restricted Token（受限安全令牌）**、**Synthetic SIDs** 以及 **AppContainer**。剥离高危特权 SID，并将写入访问限制在指定的工作区 DACL 范围内。
  - **微软架构协同（MXC）**：微软基于此场景提出了 Microsoft Execution Containers (MXC) 规范，在 Windows 11 上将进程分为轻量级 Process Container (AppContainer)、桌面隔离的 Session Container 以及 MicroVM。
  - **网络控制**：支持网络只读（`net-readonly`）配置，通过底层防火墙规则或代理管道隔离网络出站（来源：[OpenAI Codex Architecture](https://github.com/openai/codex)）。
- **Cursor**：
  - **本地执行**：通过 `sandbox.json` 提供 `workspace_readwrite`、`workspace_readonly`、`insecure_none` 模式。在 Linux/macOS 上依托系统隔离，在原生 Windows 上缺乏完整的内核级 AppContainer/Token 封装 [未证实 Windows 原生具备内核级落地，主要依赖工作区文件拦截与 Dev Containers]。
  - **云端 Cloud Agent**：将任务委托至独立的远程微型虚拟机（Linux MicroVM/Docker），与宿主机物理隔离，并通过 `networkPolicy` 严格配置出站域名白名单/黑名单（来源：[Cursor Sandbox Reference](https://docs.cursor.com/reference/sandbox)）。
- **OpenHands**：
  - **控制面与执行面彻底解耦**：Agent 控制器（Python/Node）与代码执行环境物理分离。
  - **Windows 实现方式**：必须在 Windows 上安装 Docker Desktop（基于 WSL2 引擎），代码和 Shell 操作全部在专用 Docker 容器（如 `ghcr.io/openhands/agent-server`）中运行。
  - **网络控制**：继承 Docker 网络隔离机制，可指定 Docker `--network none` 实现无网络隔离，或通过容器代理网关控制外网通信（来源：[OpenHands Architecture Docs](https://docs.all-hands.dev)）。
- **Goose**：
  - **无内置 OS 级沙箱**：Goose 作为本地 CLI/桌面应用，在宿主机上直接以当前用户的完整身份和权限运行 Shell 脚本。
  - **官方安全警示**：官方文档明确强调，处理不可信代码或执行未知任务时，用户必须自行将 Goose 部署在 Docker 容器或独立虚拟机内（来源：[Goose Security FAQ](https://block.github.io/goose/)）。
- **Cline**：
  - **无内置 OS 级沙箱**：依托 VS Code 的 `vscode.window.createTerminal` 或 Node.js `child_process` 执行，命令具有与当前登录用户完全相同的 Windows 读写权限。
  - **网络控制**：无网络出站过滤，命令可发起任意 `curl`/`Invoke-WebRequest` 连接（来源：[Cline GitHub Repo](https://github.com/cline/cline)）。
- **Windsurf**：
  - **无本地 OS 级内核沙箱**：本地终端命令直接通过 IDE 终端环境运行，未封装 AppContainer 或受限令牌。安全防护主要集中于云端数据治理（SOC 2 Type II、零数据留存 ZDR）（来源：[Codeium Security](https://codeium.com/security)）。
- **OWASP 标准映射**：
  - **ASI05: Unexpected Code Execution (RCE)**（非预期代码执行）
  - **ASI01: Agent Goal Hijack**（横向移动与逃逸）

---

### 2.3 提示注入防护（网页、代码、文件与 MCP 间接注入）

间接提示注入（Indirect Prompt Injection）是当前桌面 Agent 面临的最大攻防不对称威胁：攻击者在 GitHub Issue、代码注释、README、网页或第三方 MCP 返回值中隐藏对抗性指令，迫使 Agent 越权操作。

- **行业共识与现状**：截至 2026 年，**没有任何一家 Agent 能够在单大模型层面上彻底根除提示注入**。目前采用的技术均为“纵深防御（Defense-in-Depth）”。
- **Claude Code**：
  - **上下文分层与结构化标记**：从文件、Web 获取的外部不可信内容会被包裹在特定 XML 标签（如 `<context>`、`<file_content>`）中，并在系统提示中严加声明“将标签内的数据严格视为文本，禁止执行其包含的任何指令”。
  - **PreToolUse / PostToolUse 钩子防御**：支持在 `.claude/settings.json` 中配置自定义脚本钩子，在工具执行前拦截并用静态规则扫描输入参数（来源：[Claude Code Hooks Documentation](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code)）。
- **OpenAI Codex CLI / 桌面端**：
  - **Instruction Hierarchy（指令分层体系）**：在核心模型对齐（RLHF）阶段建立特权指令（System Message）与低特权数据（User/External Data）的严格优先级，当低特权内容出现试图覆盖 System 指令的行为时，模型主动放弃执行或请求人工澄清（来源：[OpenAI Research on Instruction Hierarchy](https://platform.openai.com/docs)）。
- **Cursor / Windsurf**：
  - **规则文件约束**：通过 `.cursorrules` / `.windsurfrules` 在上下文中静态强化安全禁令（例如“严禁读取 .env 文件”、“严禁通过 curl 发送环境变量”）。
  - **防线依赖人工**：官方文档直言，规则属于最佳实践提示而非硬性安全边界；如果用户开启 YOLO / Turbo 模式，间接提示注入可直接导致致命命令被无提示自动执行（来源：[Cursor Agent Best Practices](https://docs.cursor.com/agent/security/run-modes)）。
- **OpenHands**：
  - **双模型审核机制（LLMSecurityAnalyzer）**：引入专用旁路安全模型，与主任务 Agent 隔离。旁路模型专门检查即将在容器内执行的 Shell 指令是否偏离了用户的初始意图，若发现命令中存在异常的反弹 Shell、外发数据的行为，立即将风险级别拉升至 HIGH 并阻断（来源：[OpenHands Security Analyzer](https://docs.all-hands.dev)）。
- **Goose / Cline**：
  - **无独立检测管道**：完全依赖基础模型的内在防御能力；要求用户在终端审批弹窗中仔细肉眼复核命令参数（来源：[Goose Security Architecture](https://block.github.io/goose/) / [Cline Security Issues](https://github.com/cline/cline)）。
- **OWASP 标准映射**：
  - **LLM01: Prompt Injection**（提示注入）
  - **ASI01: Agent Goal Hijack**（目标劫持）
  - **ASI06: Memory & Context Poisoning**（上下文污染）

---

### 2.4 密钥与凭据管理（存储、上下文脱敏、日志打码）

Agent 会高频接触各类敏感 Key（LLM API Key、GitHub Token、AWS 凭证、数据库密码）。密钥的存储与流转安全直接决定了系统的防泄漏能力。

- **Claude Code**：
  - **存储机制**：优先使用系统原生 Keychain（Windows 凭据管理器 / macOS Keychain）存储认证 Token。
  - **子进程环境变量净化**：支持 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`，启动 Bash 或 MCP 子进程时主动剥离宿主环境变量中的敏感 Key，防止子进程意外继承。
  - **上下文与日志脱敏**：官方原生尚未提供全自动的正则脱敏拦截器，主要依赖社区脱敏插件（如 `redact-secrets`）或在 PreToolUse 钩子中编写脱敏脚本；推荐采用 Vault MCP 模式，模型仅感知 Secret 的占位别名，底层请求由本地代理直接注入真实 Key（来源：[Claude Code Security Discussions](https://github.com/anthropics/claude-code)）。
- **OpenAI Codex CLI**：
  - **存储机制**：基于平台 OAuth 与操作系统凭据管理。
  - **企业数据脱敏**：企业端管理控制台内置 PII 过滤与敏感凭据遮盖，防范数据被模型记忆或打入训练集（来源：[OpenAI Enterprise Controls](https://platform.openai.com/docs)）。
- **Cursor**：
  - **Runtime Secrets（前称 Redacted Secrets）**：提供专门的运行时机密管理。环境变量注入到执行环境中供编译/运行，但在**模型交互上下文、工具返回值、终端输出回显、Git Commit 信息以及会话日志中，全部自动强制替换为 `[REDACTED]`**，杜绝模型回显泄密（来源：[Cursor Secrets & Network Config](https://docs.cursor.com/cloud-agent/security-network)）。
- **OpenHands**：
  - **集中静态凭证库（`Settings > Secrets`）**：在 Web UI 统一加密管理，安全注入至容器环境变量中。
  - **动态密钥请求工具（`request_secret`）**：当 Agent 发现缺少某项 Key（如部署缺少 AWS Key）时，不会向用户索要明文文本，而是调用专门的 `request_secret` 工具，在 UI 渲染独立密文字段；用户提交后，该 Key **直接挂载入底层容器环境，绝对不会进入聊天历史、EventStream 事件流或模型上下文**（来源：[OpenHands Secrets Management](https://docs.all-hands.dev)）。
- **Goose**：
  - **存储机制**：优先调用系统凭据存储（macOS Keychain / Windows Credential Manager）；当系统密钥环不可用或显式配置 `GOOSE_DISABLE_KEYRING=1` 时，降级到本地配置文件 `%APPDATA%\Block\goose\config\secrets.yaml`。
  - **脱敏机制**：无全自动内置的提示词过滤机制（来源：[Goose Configuration](https://block.github.io/goose/)）。
- **Cline**：
  - **存储机制**：严格采用 VS Code 的 `ExtensionContext.secrets` API（底层由 Windows DPAPI、macOS Keychain 或 Linux libsecret 支撑），绝不将 API Key 明文保存在 `globalState.json` 等配置中。
  - **脱敏机制**：主要依赖 `.clineignore` 避免将 `.env` 纳入读取上下文；对于 Shell 命令标准输出中回显的 Key 暂无强制自动打码拦截 [未证实具备终端输出流自动正则打码]（来源：[Cline Secret Storage](https://github.com/cline/cline)）。
- **Windsurf**：
  - **存储机制**：基于 VS Code 平台 `SecretStorage`。
  - **传输与审计**：商业化版本提供 SOC 2 Type II 合规支撑，支持企业密钥集中托管（来源：[Codeium Security](https://codeium.com/security)）。
- **OWASP 标准映射**：
  - **LLM02: Sensitive Information Disclosure**（敏感信息泄露）
  - **ASI03: Identity & Privilege Abuse**（身份特权滥用）

---

### 2.5 操作审计日志与溯源体系

当 Agent 具备多步执行能力时，审计日志必须满足**不可篡改、强类型回放与企业 SIEM 导出**要求。

- **Claude Code**：
  - **本地日志**：全量持久化交互会话、Tool 执行参数与执行耗时于 `~/.claude/` 目录下。
  - **企业标准导出**：全面支持 **OpenTelemetry (OTel)** 协议，可直接将 Agent 的操作链路、工具审批记录、Token 消耗和执行结果实时打入企业集中 SIEM 系统（如 Datadog、Splunk）（来源：[Claude Code OTel Integration](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code)）。
- **OpenAI Codex CLI / 桌面端**：
  - **标准化遥测**：同样基于 OpenTelemetry (OTel) 规范输出结构化审计追踪日志；企业管理后台提供集中式审计视图（来源：[OpenAI Enterprise Telemetry](https://platform.openai.com/docs)）。
- **Cursor**：
  - **本地与云端双轨追踪**：本地记录完整会话与 Diff 变更；Cloud Agent 提供云端任务交互时间线、完整的 Tool 调用入参与退出码、全量 Git Diff 快照，企业管理员可统一下载或接入审计管道（来源：[Cursor Security](https://docs.cursor.com/cloud-agent/security)）。
- **OpenHands**：
  - **EventStream（事件流）核心架构**：系统底层完全建立在事件溯源（Event Sourcing）模式之上。每一次用户的输入、Agent 的思考（Thought）、发起的动作（Action）以及环境的反馈（Observation）都作为强类型的 JSON Event 永久落盘，支持逐帧回放与秒级审计验证（来源：[OpenHands Architecture Docs](https://docs.all-hands.dev)）。
- **Goose**：
  - **会话持久化**：会话日志保存在本地用户数据目录（如 `%APPDATA%\Block\goose` 或 `~/.local/share/goose/sessions`），采用 SQLite/JSON 存储，可通过 `goose session list` 查询回放；缺乏原生 OTel 企业导出规范（来源：[Goose Sessions](https://block.github.io/goose/)）。
- **Cline**：
  - **扩展本地持久化**：保存在 VS Code 扩展目录的 `ui_messages.json` 与全局状态中，记录每一步工具调用的参数、用户点击审批的状态及终端输出，供 UI 前端完整重现会话；无企业级集中推送机制（来源：[Cline State Storage](https://github.com/cline/cline)）。
- **Windsurf**：
  - **IDE 与企业团队控制台**：本地保留 Cascade 交互记录；Enterprise 客户可通过 Admin Portal 统一拉取组织内所有成员的 Cascade 命令执行记录与敏感操作合规日志（来源：[Windsurf Team Settings](https://codeium.com/windsurf)）。
- **OWASP 标准映射**：
  - OWASP Agentic Security 核心指导原则：**Strong Observability & Traceability**（强可观测性与可追溯性）
  - **ASI08: Cascading Failures**（级联故障的根因定位）

---

### 2.6 MCP 与第三方技能/插件的信任与隔离

Anthropic 主导的 **Model Context Protocol (MCP)** 已成为桌面 AI Agent 的事实标准协议。但 MCP 的安全性目前处于“协议不设防、风险下沉至宿主”的阶段。

- **MCP 官方安全规范（Model Context Protocol Specification）**：
  - **协议本身不提供沙箱隔离**：MCP 官方文档明确说明，MCP 是通信协议而非安全边界。
  - **Roots 机制已废弃**：协议早期设计的 `roots`（用于告知 MCP 服务器工作区路径）仅属**信息指导性（Informational）**，协议不强制限制服务器越界访问。且在最新协议规范修订（SEP-2577）中，`roots` 特性已被标记为 **Deprecated（已废弃）**，推荐由客户端在工具参数中显式传递受限资源路径（来源：[MCP Specification](https://modelcontextprotocol.io)）。
- **各桌面 Agent 对 MCP 的防护措施**：
  - **Claude Code**：支持集中配置 MCP 服务器；要求 MCP 工具调用前向用户展示参数并获得许可；支持通过 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` 清洗父进程传递给 MCP 子进程的环境变量（来源：[Claude Code MCP Docs](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code)）。
  - **Goose**：**Extension-First 架构**（核心能力全基于 MCP 扩展构建）。官方安全规范严厉警告：**“仅安装经过个人逐行代码审查的 MCP 扩展”**，因为本地 stdio 模式启动的 MCP 插件就是宿主机上的一个普通原生子进程，能访问用户所有的本地资源（来源：[Goose MCP Extensions](https://block.github.io/goose/)）。
  - **Cline**：通过 `cline_mcp_settings.json` 管理外部 MCP。支持在 UI 中对每个 MCP Server 的每个 Tool 单独设置 Auto-Approve 开关；社区已开始讨论引入 OAuth 与 `streamableHttp` 远端模式，以替代在本地配置文件中明文存放第三方法定 Token 的做法（来源：[Cline MCP Integration](https://github.com/cline/cline)）。
  - **OpenAI**：桌面端逐步兼容 MCP 协议，企业管理端通过 `requirements.toml` 统一维护白名单，禁止员工挂载未经企业安全评估的第三方 MCP 服务（来源：[OpenAI Enterprise Security](https://platform.openai.com/docs)）。
- **OWASP 标准映射**：
  - **ASI04: Agentic Supply Chain Vulnerabilities**（代理供应链漏洞，如恶意 MCP 服务注入）
  - **ASI02: Tool Misuse & Exploitation**（第三方扩展工具劫持）

---

### 2.7 敏感路径保护（.ssh、凭据、浏览器与系统目录）

桌面环境与云端容器最大的区别在于：宿主机上存在大量高价值个人凭据。Agent 一旦发生路径逃逸，将直接读取 SSH 私钥、AWS 配置或浏览器 Cookie。

- **Claude Code**：
  - **Explicit Deny Rules**：支持通过 Glob 规则在配置文件中将敏感路径加入黑名单：
    ```json
    "permissions": {
      "deny": ["Read(~/.ssh/**)", "Read(./.env)", "Read(~/.aws/**)", "Read(./secrets/**)"]
    }
    ```
  - **沙箱内核级阻断（WSL2/Linux）**：写操作被强行限制在工作区，向 `~/.bashrc` 或系统目录写入会直接抛出 OS 内核层 `Operation not permitted`。
  - **弱点**：在原生 Windows 无沙箱模式下，如果 Agent 自主生成并执行 `cat ~/.ssh/id_rsa` 这类 Shell 命令，文件读取工具层的过滤会被底层 Shell 绕过（来源：[Claude Code Settings](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code)）。
- **Cursor**：
  - **`.cursorignore` 过滤**：防止本地代码索引工具和文件读取工具把敏感文件加载进模型上下文。
  - **`sandbox.json` 强限制**：提供 `readBoundary: "workspace"` 配置项，将读取边界限制在工作区内，禁止 Agent 读取跨目录文件（来源：[Cursor Sandbox Reference](https://docs.cursor.com/reference/sandbox)）。
  - **弱点**：若关闭沙箱且在 YOLO 模式下，Shell 命令行调用依然可绕过 `.cursorignore`。
- **OpenHands**：
  - **物理隔离（Physical Isolation）**：默认仅将用户明确选定的宿主机项目目录挂载（Volume Mount）进 Docker 容器的 `/workspace`。
  - **天然免疫**：宿主机的 `C:\Users\<User>\.ssh`、浏览器目录、Windows `System32` 等**根本没有挂载进容器内部**，容器内的恶意命令在物理层面上无法访问宿主敏感目录（除非用户主动进行高危错误挂载）（来源：[OpenHands Docker Best Practices](https://docs.all-hands.dev)）。
- **Cline**：
  - **`.clineignore` 机制**：支持在工作区配置 ignore 文件；但 GitHub Issue 记录了多次通过 `@/folder` 符号或特定提示诱导导致忽略规则被穿透读取的漏洞 [已部分修复，但仍需谨慎]（来源：[Cline GitHub Issues](https://github.com/cline/cline)）。
- **Windsurf**：
  - **工作区边界与黑名单**：默认只对打开的 Workspace 文件夹建立索引，结合黑名单阻断高危删除，但缺乏系统关键路径（如 `C:\Windows`）的底层硬拦截（来源：[Codeium Windsurf](https://codeium.com/windsurf)）。
- **OWASP 标准映射**：
  - **LLM02: Sensitive Information Disclosure**（敏感信息泄露）
  - **ASI03: Identity & Privilege Abuse**（特权与路径滥用）

---

## 3. 现状对比与差距分析（Gap Analysis）

将我们现有的 Windows 桌面 Agent 与业界先进方案及 OWASP 准则逐一比对：

### 现状盘点
- **系统环境**：Windows 桌面应用（原生环境）。
- **审批机制**：三档审批（全部放行 / 修改和命令需确认 / 全部需确认）。
- **命令判断**：按文本内容启发式判断是否只读。
- **工具授权**：工作区维度可设置「总是允许的工具」。
- **密钥存储**：使用 Windows DPAPI 加密存储 API Key；MCP 密钥加密存储。
- **配额管理**：具备每日/每月花费上限（防范 OWASP LLM10 资源耗尽）。

### 关键差距（Security Gaps）

```
[我们现存的 6 大核心安全短板]
 1. 命令只读判断依赖粗糙文本启发式 ──────> 极易被管道、重定向、混淆脚本绕过 (高危)
 2. 缺乏 Windows 原生进程沙箱/令牌隔离 ──> 确认放行后，命令以宿主完全特权执行 (高危)
 3. 缺乏出站网络拦截与白名单机制 ────────> 受到间接注入后，敏感数据可任意外发 (高危)
 4. 缺乏敏感系统路径的底层硬隔离 ────────> 允许读取 ~/.ssh、浏览器数据、.env (高危)
 5. 缺乏上下文和日志动态脱敏 (Redaction) ─> 命令输出中的 Token 直接明文入库入网 (中危)
 6. MCP 子进程全特权裸奔运行 ────────────> 子进程可反向刺探宿主内存与环境 (中危)
```

1. **命令判断机制脆弱（启发式文本匹配 vs AST 语法解析与沙箱隔离）**：
   - *风险*：仅按命令字符串内容做启发式只读判断。在 Windows PowerShell / CMD 下，攻击者可以通过多命令连接符（`;`、`&&`）、管道输出重定向（`dir > file.txt`）、Base64 编码（`powershell -enc ...`）或子 Shell（`cmd /c ...`）轻松伪装成只读命令，绕过确认机制在后台写入或删除文件。
2. **操作系统级执行沙箱缺失（Windows 原生裸奔）**：
   - *风险*：一旦用户点击放行或命令被误判为安全，子进程以当前 Windows 用户的完整权限执行。没有采用 OpenAI/微软提倡的 **Restricted Token（受限令牌）** 剥离管理员特权，也没有使用 **AppContainer** 或容器对写操作进行工作区硬限制。
3. **出站网络控制空白（无 Egress Filtering）**：
   - *风险*：没有像 Claude Code / Cursor 那样建立本地代理与域名白名单（Domain Allowlist）。Agent 执行由恶意代码注入的 `curl`、`Invoke-WebRequest`，可将 DPAPI 解密后的密钥或本地源码直接 POST 到外网公网服务器。
4. **缺乏敏感路径硬防护机制**：
   - *风险*：没有针对 `~/.ssh`、`~/.aws`、Chrome/Edge `User Data`、Windows 凭据以及系统目录的默认拒绝拦截。一旦被注入，Agent 可遍历用户隐私目录。
5. **动态脱敏（Redaction）缺失**：
   - *风险*：虽然 Key 在静态存储时经过了 DPAPI 加密，但在运行时，一旦命令输出或被读取的代码中包含了 API Key/密码，系统没有实时正则过滤，直接明文送入 LLM 模型上下文并记录到日志中。
6. **MCP 扩展缺乏子进程隔离**：
   - *风险*：MCP 密钥虽加密，但启动本地 MCP 服务时未清洗父进程敏感环境变量（缺少类似 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` 的机制），第三方 MCP 服务能直接读取宿主机所有数据。

---

## 4. 「我们缺什么、建议做什么」优先级路线图

按**安全重要程度（紧急与致命程度）**排序，综合考虑 Windows 桌面应用的技术实现路径，标注实现难度：

| 优先级 | 建设维度 | 现状短板与建议解决方案 | 实现难度 | 对应 OWASP 项 |
| :---: | :--- | :--- | :---: | :--- |
| **P0** | **敏感路径硬性拦截底线** | **缺硬性目录黑名单**。<br>**建议**：<br>1. 内置**全局默认拒绝路径表**：强制拦截对 `.ssh/`、`.aws/`、`.gnupg/`、`AppData\Local\Google\Chrome\User Data`、`C:\Windows` 等高危目录的读取；<br>2. 规范化路径检查（Canonicalization），解析并阻止 `..\..\` 跨目录逃逸；<br>3. 实现工作区 `.ignore` 规则机制，默认屏蔽 `.env*` 等凭据文件入模。 | **低 (Low)** | ASI03<br>LLM02 |
| **P0** | **重构命令解析引擎（语法 AST + 精准白名单）** | **缺可靠的只读安全判断**。<br>**建议**：<br>1. 废弃简陋的字符串子串判断，引入 PowerShell/CMD **词法/抽象语法树（AST）解析器**；<br>2. 严格检测并阻断管道重定向操作符（`>`、`>>`、`|`）；<br>3. 建立**精准只读命令白名单**（如仅放行 `git status`、`git diff`、`cargo check` 等明确无副作用子命令）；凡带未知参数、脚本调用或拼接语法一律降级必须人工二次确认。 | **中 (Medium)** | ASI02<br>ASI05 |
| **P1** | **运行时敏感数据流动态脱敏（Redaction）** | **缺运行时密钥过滤与日志打码**。<br>**建议**：<br>1. 借鉴 Cursor 的 Runtime Secrets 机制，在 Tool 返回结果装配进模型 Context 以及持久化到本地日志之前，执行流式正则脱敏；<br>2. 维护常用敏感模式库（OpenAI/Anthropic Key、AWS 访问凭证、私钥头部、JWT Token 等），统一替换遮盖为 `[REDACTED]`；<br>3. 防止模型产生数据幻觉并泄露回显。 | **中 (Medium)** | LLM02<br>ASI03 |
| **P1** | **MCP 环境变量清洗与权限降级** | **缺第三方插件的环境隔离**。<br>**建议**：<br>1. 启动本地 stdio MCP 子进程时，**主动剥离系统环境变量**（清空包含主程序配置、DPAPI 凭据、敏感 Token 的变量），仅传递该 MCP 声明所需的最小配置；<br>2. MCP 返回内容强制以结构化数据（而非可执行指令）渲染，并在调用前在 UI 清晰展示完整参数。 | **低至中** | ASI04<br>ASI02 |
| **P2** | **Windows 原生受限令牌与 Job Object 沙箱** | **缺 OS 级内核进程隔离**。<br>**建议**：<br>1. 利用 Windows Win32 API `CreateRestrictedToken`，为终端命令执行进程生成受限令牌（剥离 Administrator SID，降低完整性级别至 Low Integrity Level）；<br>2. 结合 Windows **Job Object** 限制子进程的最大 CPU、内存开销及孙进程创建权限；<br>3. 进阶路线：中长期可探索 Windows AppContainer 或以 WSL2/轻量级 Docker 为备选沙箱环境。 | **高 (High)** | ASI05<br>LLM06 |
| **P2** | **出站网络控制与域名白名单（Egress Proxy）** | **缺网络流量出站拦截**。<br>**建议**：<br>1. 借鉴 Claude Code 架构，为 Agent 派生的子进程配置本地轻量级透明代理；<br>2. 默认限制子进程随意直连外网，建立工作区**出站域名白名单（Domain Allowlist）**（如仅允许官方代码仓库、常用包管理器源）；未授权的外网访问请求强制在 UI 弹出网络访问阻断提示。 | **中至高** | ASI01<br>ASI02 |
| **P3** | **结构化审计追踪体系（EventStream）** | **缺标准化不可篡改审计流**。<br>**建议**：<br>1. 参考 OpenHands EventStream 架构，将用户的每次确认/拒绝、模型生成的 Action 计划、命令实际执行的参数与退出码，以强类型 JSONL 格式落盘；<br>2. 预留标准 OpenTelemetry (OTel) 遥测接口，便于未来面向企业客户提供集中式安全审计导入。 | **低 (Low)** | ASI08<br>强可观测性 |

---

### 总结建议

作为一款 **Windows 原生桌面 AI Agent**，最立竿见影且性价比最高的安全加固组合为：
1. **立即行动（1–2 周，低/中难度）**：实施 **P0 的敏感路径硬拦截**、**重构命令 AST 语法解析**，以及 **P1 的运行时动态脱敏（Redaction）**。这一步能彻底堵死常见的提示注入逃逸与明文密钥泄露；
2. **纵深防御（1–2 个月，中/高难度）**：推进 **P1 的 MCP 环境变量清洗** 与 **P2 的 Windows Restricted Token 受限令牌隔离**，将命令执行权限在 OS 层面切实下压至最低权限（Least Privilege），构筑行业第一梯队的桌面 Agent 安全防护体系。