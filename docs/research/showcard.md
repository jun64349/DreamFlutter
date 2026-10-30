> 2026-10-30 委派产出（Antigravity），属待核验素材。用户据此做的决定见 [../v0.2-plan.md](../v0.2-plan.md) 第五节。

# Showcard（魔术卡）开放规范与 OpenHanako 落地调研报告

> **规范版本**：Showcard Specification 1.0（发布/更新日期：2026 年 10 月；最新 Git 提交：`2026-10-09T17:00:36+08:00`；配套 CLI npm 包 `showcard@0.9.2`）  
> **官网与项目主页**：[showcard.org](https://showcard.org)（宣传/品牌域名亦包含 `showcard.ai`）  
> **核心仓库**：
> - 规范与参考实现：[github.com/liliMozi/showcard](https://github.com/liliMozi/showcard)
> - 同源母项目（桌面 Agent）：[github.com/liliMozi/openhanako](https://github.com/liliMozi/openhanako)

---

## 1. 规范概要

**来源**：
- [spec/1.0.md §1](https://github.com/liliMozi/showcard/blob/main/spec/1.0.md#1-卡片包card-package)
- [spec/1.0.md §6](https://github.com/liliMozi/showcard/blob/main/spec/1.0.md#6-文件格式package--sharing)

### 1.1 卡片包的文件结构（Card Package）
Showcard 坚持 **"One Card — 一张卡片就是一个网页"** 原则，卡片在物理上就是一个静态 Web 目录：
- **入口文件**：固定命名为 `index.html`，必须是完整的 HTML 文档（包含 `<!DOCTYPE html>`、`<html>`、`<head>`、`<body>`）。
- **静态资产目录（可选）**：`assets/` 目录，存放入口以外的图片、音视频、独立 `.js`/`.css`、字体或数据文件。
- **相对引用**：包内所有引用必须使用相对路径（如 `<img src="assets/icon.png">`、`<link rel="stylesheet" href="assets/style.css">`），禁止依赖绝对路径。
- **无体积上限与 Range/ETag**：包内资产不设体积上限，规范明确将大文件（如视频、音频）编成 base64 塞入 HTML 视为**反模式**。宿主应当支持 HTTP `206 Partial Content`（Range 请求）与 `ETag`。

### 1.2 清单（manifest）字段规范
卡片通过入口 `index.html` 中内嵌的静态 JSON 脚本块声明其所需能力：
`<script type="application/json" data-card-manifest>`。

| 字段名 | 级别 | 类型与说明 |
| :--- | :--- | :--- |
| `spec` | **可选**（缺省视同 `"1.0"`） | 声明插座契约版本号字符串。 |
| `toolBindings` | **可选**（无工具需求可省略） | 声明卡片需要的工具绑定映射表。每个绑定包含：<br>• `tool`（**必填**，工具名，如 `"fetch.request"`、`"time.now"`）<br>• `input`（**可选**，参数形状边界约束，如 `{"hosts": ["api.example.com"]}`）<br>• `description`（**可选**，人类可读描述） |
| `display` | **可选** | 呈现偏好（非权限，不进工具摘要）：<br>• `preferredWidthPx`：希望的初始内容宽度，有限数值，**取值范围限定在 240–1200 像素之间**。 |
| `stateSchema` | **可选** | 状态快照的结构预期（JSON Schema 风格对象，宿主至少理解 `type`、`properties`、`required`、`enum`、`items`），非权限。 |
| `dataSchema` | **可选** | 宿主扩展声明（描述宿主拥有的外部数据文档结构），非权限，不支持的宿主必须忽略。 |

*注：manifest 必须静态内嵌，禁止运行时动态生成修改；若有多块，仅取文档序第一块，其余视为静态错误但不阻断渲染。*

### 1.3 单文件 HTML 与分享打包方式
- **退化包（Degenerate Package / `*.card.html`）**：当卡片零资产时，可直接写作单个 HTML 文件，文件命名采用双后缀 `*.card.html`。其内容与目录包中的 `index.html` 完全一致，双击即可在任何普通浏览器中打开。
- **跨端分享包（`.card.zip`）**：卡片分享的标准格式为 `.card.zip`。
  - **根即包根**：zip 顶层直接平铺 `index.html` 与 `assets/`，禁止套外层父目录。
  - **导出装备（Export Rigging）**：宿主导出卡片时，必须在入口文档中装备三样内容：
    1. **状态快照块**：将导出瞬间的运行时状态烧录进 `<script type="application/json" data-card-state>`；
    2. **外观自包含**：将宿主主题 CSS 变量当时的计算值静态内联写入，确保离线打开时视觉不崩坏；
    3. **标准替身垫层**：在头部注入轻量替身脚本，确保脱离宿主双击打开时以 L0 降级运行。

---

## 2. 卡片与宿主的通信

**来源**：
- [spec/1.0.md §2](https://github.com/liliMozi/showcard/blob/main/spec/1.0.md#2-卡内运行时-api)
- [reference/src/host.js](https://github.com/liliMozi/showcard/blob/main/reference/src/host.js)
- [reference/src/runtime-source.js](https://github.com/liliMozi/showcard/blob/main/reference/src/runtime-source.js)

### 2.1 通信方式与通信信道
- **注入全局对象**：宿主在服务卡片 `index.html` 时，于 `<head>` 顶部（早于卡片所有自身脚本）注入运行时垫层，暴露全局对象 **`window.card`**。
- **底层传输**：基于标准 **`window.parent.postMessage`**，消息类型固定带有 `card:` 前缀：
  - 卡片向宿主发送：`{ type: "card:request", requestId: string, capability: string, payload: any }`
  - 宿主向卡片应答：`{ type: "card:response", requestId: string, ok: boolean, result?: object, error?: string, code?: string }`
- **信封（Envelope）规范**：所有 API 均返回 Promise，**永不 reject**。成功返回 `{ ok: true, result: {...} }`，失败返回 `{ ok: false, error: string, code: string }`。

### 2.2 核心五件套 API
```typescript
card.state.get(key?: string): Promise<Envelope>
card.state.set(key: string, value: any): Promise<Envelope>
card.state.set(stateObject: object): Promise<Envelope>
card.invoke(bindingId: string, input?: any): Promise<Envelope>
card.emit(name: string, payload?: any, to?: string): Promise<Envelope>
card.request(capability: string, payload?: any): Promise<Envelope>
card.capabilities(): Promise<Envelope>
```

### 2.3 工具调用（`card.invoke`）
卡片只能调用在 manifest 中静态声明过的 `toolBindings`，禁止直接调用未声明的宿主后端函数：
```javascript
// 卡片侧调用
const res = await card.invoke("scores", { team: "Arsenal" });
if (res.ok) {
  renderScores(res.result);
} else {
  showError(res.error, res.code);
}
```
宿主处理逻辑（摘自 `reference/src/host.js`）：
```javascript
async function invoke(payload) {
  const bindingId = payload && typeof payload.bindingId === 'string' ? payload.bindingId : '';
  const binding = Object.prototype.hasOwnProperty.call(bindings, bindingId) ? bindings[bindingId] : null;
  if (!binding) {
    return fail(CARD_ERROR_CODES.TOOL_UNAVAILABLE, `this card declares no binding named ${JSON.stringify(bindingId)}`);
  }
  if (typeof executeBinding !== 'function') {
    return fail(CARD_ERROR_CODES.TOOL_UNAVAILABLE, 'this host has no tool channel wired');
  }
  let result = await executeBinding({ cardId, bindingId, binding, input: payload.input ?? null });
  return ok(isPlainObject(result) ? result : { value: result });
}
```

### 2.4 状态持久化（`card.state`）
- **作用域**：挂载在宿主为卡片分配的**实体身份（Entity Card ID）**上，生命周期与该实体绑定，跨重渲染、跨应用重启存活。
- **大小限制**：合并后的完整状态序列化 JSON **预算严格限制在 64 KiB 以内**。超限时宿主必须显式拒绝并返回 `CARD_HOST_STATE_TOO_LARGE`，**严禁静默截断**。
- **L0 降级**：脱离宿主独立打开时，降级使用浏览器的 `localStorage`，存储 Key 由当前页面路径 `location.pathname` 派生，禁止从卡片标题推导。
- **状态播种**：卡片首次加载时，由 HTML 内嵌的 `<script type="application/json" data-card-state>` 注入初始值；此后完全通过 `card.state` 插座读写。

### 2.5 能否请 Agent 再做一轮对话？
- **规范明确界定非目标（§2.9）**：**没有卡片直呼 LLM 的通道（即不存在 `card.ask`）**！规范设计原则禁止卡片在运行时动态调用大模型补参数或提问。
- **单向事件上报（`card.emit`）**：卡片向宿主上报一次已发生的用户交互事件：
  - `name`：限制 64 字符内（`^[a-z0-9][a-z0-9._-]{0,63}$`）。
  - `payload`：可序列化 JSON，**上限 8192 UTF-8 字节**。
  - `card.emit` 是**发出即忘（fire-and-forget with receipt）**，返回 `ok: true` 仅代表宿主已受理投递，卡片拿不到会话对端或 Agent 的答复。宿主收到后可自主决定是否投递给会话流触发新一轮 Agent 对话。

---

## 3. 安全模型

**来源**：
- [spec/1.0.md §3](https://github.com/liliMozi/showcard/blob/main/spec/1.0.md#3-能力协商与信任梯度)
- [spec/1.0.md §7](https://github.com/liliMozi/showcard/blob/main/spec/1.0.md#7-安全)
- [openhanako server/routes/cards.ts](https://github.com/liliMozi/openhanako/blob/main/server/routes/cards.ts)

### 3.1 沙箱基线与 CSP
1. **隔离源（Opaque Origin）**：必须在 iframe sandbox 中渲染，标准属性为 `sandbox="allow-scripts"`（**绝不给 `allow-same-origin`**，从而形成 Opaque Origin，无法直接访问宿主 DOM、Cookie 或 LocalStorage）。
2. **阻止出站与提权**：必须阻止顶层导航（`navigate-to 'none'`）、弹窗（禁止 `allow-popups`）、表单外发（`form-action 'none'`）。
3. **按实例签发的 CSP（Per-Instance CSP）**：
   - 默认策略：`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'`。
   - 实例隔离：同一份卡片包的不同实例，各自的 CSP 相互独立，放行一个实例不会自动放行另一个。
4. **卡片自带防线（§7.8）**：工具生成的卡片应自带 `<meta http-equiv="Content-Security-Policy">`，在无宿主裸浏览器环境中默认阻断任何第三方网络请求，防止追踪像素。

### 3.2 权限声明与用户授权粒度
- **授权单元**：授权记忆的键值必须是 `(授权种类, 主体)` 二元组，严格绑定卡片实体身份。**禁止以“整张卡”或“单条绑定”为单位粗暴放行**。
- **四类授权种类及主体**：
  1. `网络访问`：主体为目标 **主机名（Host）**；
  2. `程序执行`：主体为被执行的 **可执行程序名**（非完整命令行）；
  3. `工具调用`：主体为 **工具名称**；
  4. `文件范围`：主体为声明的 **目录路径**。
- **三档授权记忆**：支持选择 **“只这一次”**、**“本次会话内”** 或 **“始终放行”**；宿主必须提供显式撤销授权的界面。
- **外送组合警示**：若一张卡片同时申请了“文件读取”和“网络外送”能力，宿主应当给出危险组合提示。

### 3.3 网络访问机制（双轨制）
- **直连网络访问（Direct Network）**：卡片通过原生 `fetch()` 发起，宿主在网络层不代理字节。命中未放行域名时被 CSP 拦截，宿主捕获后弹出权限征询；用户同意后将主机名写入该实例的 CSP 允许列表，**下一次页面加载时生效**。
- **网关代理（`fetch.request` 工具绑定）**：由宿主后端代理发起请求，适用于卡片存在跨域 CORS 限制或宿主需要审计、限流、剥离敏感凭据的场景。

### 3.4 秘密永不入卡（硬性红线条款）
- 卡片包及状态中**禁止包含任何 API Key、Token、密码或私钥**。
- 宿主在铸卡和导入卡片时，**强制执行秘密扫描**，内置 5 条起步正则：
  - AWS Key: `AKIA[0-9A-Z]{16}`
  - OpenAI Key: `sk-[A-Za-z0-9]{20,}`
  - GitHub PAT: `ghp_[A-Za-z0-9]{36}`
  - PEM 私钥: `-----BEGIN [A-Z ]*PRIVATE KEY-----`
  - Bearer Token: `Bearer [A-Za-z0-9._~+/-]{20,}`
- 扫描结果必须模糊化，严禁将命中的秘密原样打印到错误日志中。

---

## 4. 宿主要实现什么

**来源**：
- [guides/host-integration.zh.md](https://github.com/liliMozi/showcard/blob/main/guides/host-integration.zh.md)
- [reference/src/host.js](https://github.com/liliMozi/showcard/blob/main/reference/src/host.js)
- [reference/src/serve.js](https://github.com/liliMozi/showcard/blob/main/reference/src/serve.js)
- [openhanako 仓库实现代码](https://github.com/liliMozi/openhanako)

### 4.1 最小宿主（Minimal Host）能力构成
按照规范第 9 章一致性等级，构建一个生产可用的 L1/L2 宿主必须实现：
1. **HTTP 服务与资源分发（Web Server 语义）**：
   - 必须通过本地 HTTP Server 提供卡片服务（解析入口、相对路径资产，支持 Range / ETag）。
   - 为每个卡片实例分配带票据的独立路径（如 `/cards/:id/t/:ticket/index.html`）。
2. **服务时注入层（Serve-Time Injection）**：
   - 在向客户端输出 `index.html` 的字节流中，于 `<head>` 注入 `window.card` 垫层脚本、CSS 主题变量及高度探测脚本，**禁止回写磁盘包**。
3. **RPC 消息网关与信封包装器**：
   - 监听 iframe 的 `card:request` postMessage，校验 `requestId`。
   - 解析 manifest 中的 `toolBindings`，转发至宿主工具链执行，包裹成 Envelope 信封后以 `card:response` 回显。
4. **状态持久化存储**：
   - 按 Card ID 隔离的持久化存储引擎，实现状态合并与 64 KiB 预算防御拦截。

### 4.2 OpenHanako 是如何渲染卡片的？
OpenHanako 作为 Showcard 标准的同源母体，其桌面端完整实现了这一套卡片渲染链路：
- **前端卡片组件**：[`desktop/src/react/components/chat/InteractiveCard.tsx`](https://github.com/liliMozi/openhanako/blob/main/desktop/src/react/components/chat/InteractiveCard.tsx)
  - 采集当前宿主界面主题 CSS 变量（`--accent`, `--bg-card` 等）；
  - 发送 `PUT /api/cards/:cardId` 将卡片 HTML/SVG 代码与主题变量注册到本地服务端；
  - 渲染 `<iframe src="/api/cards/:cardId?v=..." sandbox="allow-scripts" />`；
  - **重要架构决策**：**坚决不使用 `srcdoc` 或 `data:`/`blob:` URL**！代码注释中明确指出：`srcdoc`/`blob` 会直接继承宿主父页面的 `script-src 'self'` CSP，导致卡片内部的所有内联脚本（ResizeObserver 高度上报、按钮点击事件）全部被浏览器静默阻断！必须通过本地真实 HTTP 响应提供独立 CSP 上下文；
  - 监听 `hana.card-resize` postMessage 调整高度，上限 900px（超出滚动），并在 `iframe.onload` 后主动发送 `hana.card-ping` 消除高度上报的竞态。
- **服务端卡片路由**：[`server/routes/cards.ts`](https://github.com/liliMozi/openhanako/blob/main/server/routes/cards.ts)
  - 基于 Hono 框架构建轻量端点：`PUT /cards/:cardId` 采用内存 LRU（容量 256 张卡，单卡限制 512KB）；
  - `GET /cards/:cardId` 返回拼装好的 HTML，并附带最严格的安全响应头：
    `Content-Security-Policy: default-src 'none'; sandbox allow-scripts; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; navigate-to 'none'`。
- **HTML 包壳与垫层注入**：[`server/cards/card-document.ts`](https://github.com/liliMozi/openhanako/blob/main/server/cards/card-document.ts)
  - 服务端纯字符串拼接注入基础样式、Typography 排版规则、CSS 变量以及基于 `ResizeObserver` 的高度自动上报脚本。

### 4.3 现成宿主 SDK / npm 包及许可证
- **官方 npm 工具包**：[`showcard`](https://www.npmjs.com/package/showcard)（版本 `0.9.2`，代码基于 **MIT 许可证**）。
- **参考实现库**：`reference/src/`（纯 ES 模块，包含 `host.js`、`serve.js`、`runtime-source.js`，代码基于 **MIT 许可证**，规范文本为 **CC BY 4.0**）。
- **SDK 现状**：目前官方 npm 包 `showcard` 主要封装了 CLI 检查工具、静态验证器与一致性测试套件；宿主端的集成主要采用纯 ES 模块直接引入 `reference/src/host.js` 与 `reference/src/serve.js`。

---

## 5. Agent 端：卡片生成与生命周期

**来源**：
- [spec/1.0.md §5](https://github.com/liliMozi/showcard/blob/main/spec/1.0.md#5-宿主侧-agent-操作)
- [spec/1.0.md §8](https://github.com/liliMozi/showcard/blob/main/spec/1.0.md#8-卡片技能card-skill--配方profile)
- [creator/README.zh.md](https://github.com/liliMozi/showcard/blob/main/creator/README.zh.md)
- [openhanako lib/tools/show-card-tool.ts](https://github.com/liliMozi/openhanako/blob/main/lib/tools/show-card-tool.ts)

### 5.1 Agent 如何生成卡片？
规范定义了三种铸造（Minting）形态：
1. **生成铸造（Generative Minting）**：Agent 逐字直接生成全新卡片 HTML 片段或完整包（通用兜底）；
2. **模板实例化（Template Instantiation）**：从已安装的卡片技能模板中直接复制，仅预填初始状态 JSON 快照，实现瞬间出卡；
3. **模板改铸（Template Adaptation）**：以模板为底稿，通过常规文件编辑做局部增量调整。

### 5.2 官方 Skill / 提示词 / 工具定义
- **Card Skill Profile（配方 / Recipe）**：规范第 8 章扩展了标准 Agent Skill 规范，在 `SKILL.md` 的 frontmatter 标记 `profile: card-skill`（或文件后缀 `.recipe`），模板存放在 `assets/` 目录。
- **Recipe Creator（配方创建器）**：仓库 [`creator/`](https://github.com/liliMozi/showcard/tree/main/creator) 目录下提供了一套标准的元技能，包含 5 阶段访谈提示词，教 Agent 如何交互式为用户制作新的卡片配方包。
- **OpenHanako 工具定义**：
  - 工具名：`show_card`（[`lib/tools/show-card-tool.ts`](https://github.com/liliMozi/openhanako/blob/main/lib/tools/show-card-tool.ts)）；
  - 参数：`title`（卡片标识符与导出文件名）、`code`（HTML/SVG 片段，不含 html/body 标签，宿主自动包壳）；
  - 辅助引导工具：`hana_card_guide`（[`lib/tools/card-guide-tool.ts`](https://github.com/liliMozi/openhanako/blob/main/lib/tools/card-guide-tool.ts)），在 Agent 首次绘制前注入设计系统与 CSS 变量规范。

### 5.3 保存、分享与重新打开
- **保存**：会话进行中，状态数据实时保存在宿主数据库/文件中；同时静态快照持久化在入口文档的 `<script type="application/json" data-card-state>` 块中。
- **热更新与防静默提权**：Agent 对已有卡片进行修改时，若 `toolBindings` 的规范化摘要未变，授权保留；若工具声明发生变动，声明纪元单调递增，**该卡所有既有授权全部强制失效**，重新回到首次使用授权。
- **分享与再打开**：打包为 `.card.zip` 或 `.card.html`。任何新宿主导入时，**信任完全归零（§7.6 结构定理）**：自动分配全新实体 ID，继承快照状态，但授权从零开始，确保安全性。

---

## 6. 生态现状

**来源**：
- GitHub 实时仓库与页面元数据核查（2026 年 10 月）

| 调研项 | 实际现状与数据 |
| :--- | :--- |
| **GitHub Stars** | • `liliMozi/showcard`（规范与参考实现）：**22 stars**<br>• `liliMozi/openhanako`（同源桌面 Agent 母项目）：**6.9k stars** |
| **最近提交时间** | • `showcard` 仓库：**2026-10-09**<br>• `openhanako` 仓库：**2026-10-11** |
| **已支持的宿主** | 1. **官方 Reference Host**（纯 ES 模块参考实现）；<br>2. **OpenHanako (HanaAgent)**（桌面个人 Agent 原生深度支持）。目前暂无其它主流第三方商业 Agent 宣布官方接入。 |
| **示例卡片数量** | 官方仓库内置 **5 款核心主题示例卡**：<br>1. 便签（`note` / `note.card.html`）<br>2. 虚拟钢琴（`piano` / `piano.card.html`）<br>3. 待办事项（`todo`）<br>4. 动态天气（`weather` / `weather.card.html` / `weather-package`）<br>5. 宿主测试集成卡（`examples/host/card`） |
| **版本性质标记** | **规范正文已正式定名《showcard 规范 1.0》（spec/1.0.md，明确为 1.0 正式版），全文未标记 Draft / Experimental**；配套 npm CLI 开发包版本为 `0.9.2`。 |

---

## 7. Flutter Windows 落地可行性与踩坑分析

针对当前技术栈（**Flutter Windows 桌面端 + Node 本地后台**），结合 `webview_windows` / `flutter_inappwebview`（基于 Edge WebView2）评估接入 Showcard 的可行性与技术陷阱：

### 7.1 沙箱与通信匹配度：完全可行
Flutter 桌面端配合 Node 后台是实现 Showcard 规范的**天然绝配**：
1. **Node 后台承担 L1/L2 核心职责**：直接复用 OpenHanako 的架构，在 Node 后台用 Hono 或 Express 挂载 `/api/cards/:id`，负责静态卡片包托管、Range/ETag 支持、Per-Instance CSP 签发以及 `toolBindings` 工具网关转发。
2. **Flutter 端作为纯渲染容器**：Flutter 只需要管理窗口生命周期与 WebView 容器大小。

### 7.2 关键工程避坑指南
1. **避免“独立顶层运行”导致的 L0 降级陷阱（致命坑）**：
   - *问题*：Showcard 注入脚本通过探测 `window.parent === window` 判断是否处于无宿主的独立环境（L0）。若直接用 Flutter WebView 加载卡片作为顶级网页，卡片会误判自身处于裸浏览器中，所有 `card.invoke` 恒返回 `CARD_HOST_TOOL_UNAVAILABLE`，状态存储强制降级到 localStorage。
   - *解法*：WebView 加载的必须是一个宿主外壳页（Host Shell HTML），卡片作为外壳页内的 `<iframe>` 挂载；或者由 Node 服务端在注入时做顶层适配。
2. **切忌使用 `loadHtmlString` 或 `srcdoc`/`data:` 协议**：
   - *问题*：直接向 WebView 塞 HTML 字符串不仅会破坏 `assets/` 相对路径资源解析，还会导致卡片继承宿主环境的 CSP，静默杀除所有内联脚本。
   - *解法*：必须走本地 Node HTTP 服务的标准 HTTP URL（如 `http://127.0.0.1:port/cards/...`）。
3. **Flutter Windows 多 WebView 实例性能崩溃**：
   - *问题*：在 Flutter 的 ListView 聊天消息流中，若为每个卡片消息创建一个独立的 `WebView` 控件，Windows 下多个 WebView2 原生 HWND 实例会造成严重的显存暴涨、滚动卡顿、黑屏或销毁重建闪烁。
   - *解法*：**单 WebView 方案或虚拟化离屏捕获**。推荐聊天列表由单一 Web 视图承载，或对话列表中的历史卡片在完成渲染后由 WebView2 截图为静态图片，仅当用户点击交互时才动态激活/唤起活动卡片。
4. **动态高度自适应（ResizeObserver 跨进程时延）**：
   - *问题*：Flutter 无法像普通 Widget 一样感知 WebView 内部的高度变化。卡片通过 ResizeObserver 计算 `scrollHeight` 并 postMessage 传出，再经 Flutter Channel 动态修改容器高度时，可能产生明显的首帧闪烁与高度抖动。
   - *解法*：参考 OpenHanako 做法，设置默认首屏高度预估值与最大高度上限（如 900px，超出滚动）；宿主在 load 后主动发 ping 探测，减少竞态抖动。

---

## 总结（5 行以内）

1. **价值明确**：Showcard 基于标准 HTML+postMessage，零框架捆绑，比复杂 Generative UI 框架更轻量、易沉淀、可离线分享。
2. **母体背书**：虽 Showcard 独立规范星数较少（22 stars），但同源项目 OpenHanako（6.9k stars）已在桌面 Agent 中充分验证其生产可行性。
3. **架构极契合**：与你们当前的「Flutter 窗口 + Node 后台」天然契合，由 Node 端承接 HTTP 服务与工具网关、Flutter 负责 WebView 承载。
4. **最小接入工作量**：约 **3–5 人天**（Node 端直接移植 OpenHanako 的 `cards.ts` 路由与注入包壳，Flutter 端实现单外壳 WebView+高度监听即可上线）。
