# DreamFlutter v0.1.1 开发交接

更新时间：2026-10-27 晚
当前分支：`main`（v0.1.0 已打 tag；v0.1.1 还在开发中，没有打 tag）

## 一句话现状

v0.1.1 按 [v0.1.1-plan.md](v0.1.1-plan.md) 推进：

- **已完成**：阶段 1（后台地基）、阶段 2（模型供应商与会话管理）。
- **阶段 3（记忆、快照、技能、模板）**：后台已完成并测试，**界面还没做**。
- **未开始**：阶段 4（任务、卡片、书桌）、阶段 5（定时任务）、阶段 6（MCP 管理页、网页抓取工具）、Codex 审查、发布。

## 架构（已经定型，下次直接沿用）

```
Flutter 窗口 ──WebSocket(127.0.0.1 + 令牌)── core/（Node 后台，常驻，与窗口分离）
                                              ├─ Pi SDK 在进程内运行会话（每个会话一个 slot）
                                              ├─ SQLite（node:sqlite）：%APPDATA%\DreamFlutter\core.db
                                              └─ 功能模块：src/modules/*
```

- **后台入口**：`core/src/main.ts`。用 Node 22 的类型剥离直接跑 .ts，没有构建步骤。
  - 单实例运行。
  - 启动后写 `%APPDATA%\DreamFlutter\core.json`，内含 port、token、pid。
  - 窗口通过 `CoreLocator.ensureRunning` 连接后台；后台没在运行就以 detached 方式启动它。
- **Slot**（`core/src/slots/slot.ts`）：命令集和 Pi RPC 完全一样，另有扩展命令：
  - `df_navigate_tree`
  - `df_branches`
  - `df_export`
  - `df_set_label`
  - `df_reload`
  - `df_context_usage`

  所以窗口端的 `pi_rpc` 客户端和 Transcript 基本没改，只换成了 `SlotConnection`（`packages/pi_rpc/lib/src/slot_connection.dart`）。
- **模块接入方式**：在 `core/src/app.ts` 里 `core.use(module)`。模块可以：
  - 提供 Pi 扩展（`extensions()`）
  - 订阅运行结束（`onRunFinished`）
  - 注册方法（`core.register("x.y", handler)`）
  - 推送事件（`core.broadcast({event})`）

  不需要审批的工具用 `core.exemptFromApproval(...)` 声明。
- **数据库迁移**：`core/src/schema.ts`，只能往后追加。目前到第 3 版：
  1. 设置、确认卡、运行记录
  2. 会话索引、用量
  3. 记忆、提案
- **窗口端**：`app/lib/state/agent_controller.dart`（会话管理、设置、搜索、版本切换等），后台接口封装在 `app/lib/state/backend.dart`。

## 已完成的功能（都有测试）

- **A 独立后台**：
  - 关窗口后任务继续运行，托盘常驻（tray_manager 0.5）。
  - 后台重启后，被中断的任务显示「继续」卡片。
  - 确认卡持久保存。
  - 没有窗口时弹 Windows 通知。
  - 执行轨迹记在 runs / run_steps 表。
- **B 模型供应商**：
  - 供应商管理页（`app/lib/ui/providers_page.dart`）。
  - 新填的 API Key 用 DPAPI 加密，通过 Pi 的 `!命令`（`core/bin/secret.mjs`）在使用时解密。
  - 测试连接、拉取模型列表。
  - 备用模型链：虚拟模型 `dreamflutter/auto`。
  - 辅助模型、自动标题。
  - 用量统计页（`app/lib/ui/usage_page.dart`）。
- **C 会话**：
  - 全文搜索、置顶、归档。
  - 导出 Markdown / HTML。
  - 会话内版本：编辑重发、重新生成、`‹ 1/2 ›` 切换。
  - 临时对话：只在内存，不保存。
- **D/E 后台**（`core/src/modules/memory.ts`、`skills.ts`）：
  - 记忆块、记忆（含历史版本）、任务开始时的快照注入。
  - 工具：`memory_search` / `save` / `update` / `forget` / `block_edit` / `session_search`。
  - 运行结束后提取候选记忆，等用户确认。
  - 技能：列表、启用/停用（写 Pi 的 settings.json）、导入、删除。
  - `skill_propose` 提案和「从会话整理技能」。
  - 任务模板：存为 Pi 提示词模板，支持命名参数 `{{参数}}`。

## 下次从这里开始

1. **阶段 3 界面**（后台方法都已就绪，直接调用）：
   - 窗口最左侧加导航栏：对话 / 记忆 / 技能与模板 / 设置（以后再加书桌、任务）。
   - **记忆页**，用到的方法：`memory.blocks/setBlock/list/add/edit/remove/history/accept/reject/export/clear`。
   - **技能与模板页**，用到的方法：`skills.list/read/setEnabled/remove/import/draftFromSession`、`proposals.list/accept/reject`、`templates.list/save/remove/command/draft`。
   - 对话页顶栏菜单加入：存成技能、存为模板、刷新记忆快照（`memory.refresh`）、查看本次用到的记忆（`memory.snapshots`）。
   - 控制器里已经加好：
     - `pendingMemories`、`pendingProposals`：导航角标数字。
     - `libraryRevision`：页面据此刷新。
     - `runTemplate()`。
2. **阶段 4**：任务模型（F1，tasks 表）、确认卡收件箱（把 confirmations、候选记忆、技能提案放在一起）、产物卡（runs.files）、书桌与写笺（G1–G4）、运行上限（F6）。
3. **阶段 5**：定时任务。按 v0.1.1-plan.md 第 H 节完整实现，依赖已安装 `croner@9.1.0`。`RunStore.costSince` 已经预留了按 tasks.source 统计的接口。
4. **阶段 6**：MCP 管理页（Pi 自带 MCP，读写 `~/.pi/agent/mcp.json`）、`web_fetch` 工具。
5. 用 agent-bridge 的 `codex_run` 让 Codex 审查 `core/`，修复后跑全量测试和 E2E，更新文档，然后打 tag v0.1.1。

## 怎么跑测试

```bash
# 后台测试：47 个，用 Pi 自带的假模型，不联网
cd core && npm test && npx tsc --noEmit
# 窗口单元测试：33 个
cd app && flutter test test
# Dart 协议层，含启动真实后台的测试（tag: core）
cd packages/pi_rpc && dart test -x integration
# 真实窗口端到端：用 DeepSeek，约 4 分钟，截图在 app/build/e2e_shots/，跑的时候不要最小化窗口
cd app && flutter test integration_test/e2e_test.dart -d windows
```

## 踩过的坑（重要）

- **后台必须先配置 Pi 的网络层**（`core/src/pi/http.ts`），否则第一次请求会报 Connection error。原因是 Node 默认的连接超时只有 250ms。
- **测试里要关掉自动标题和自动提取记忆**（harness 已经关了），否则它们会抢走假模型预设的回复。
- **Pi 模板没有裸写的 `${1}`**，参数要写成 `${1:-}`。
- **agent-bridge 的 `agy_research` 处理长任务会超时**，长任务直接在后台运行 `agy -p`。
- **本机唯一的 node 是 Hermes 自带的 v22.23.2**，满足要求。
- **E2E 失败时可能残留后台进程**：命令行里带 `df_e2e`，现在已经用 `addTearDown` 自动关闭，但遇到时还是可以检查一下。
- **安全检查不允许 `rm -rf` 通配目录**，清理截图之类的事交给用户。

## 未提交 / 未验证

- 最后一次 E2E：第 0–18 步全部通过（阶段 2 的版本切换、搜索、供应商连接测试、用量统计都已用真实模型验证）。最后在用量页返回时失败，原因是测试脚本里找到了两个「Back」按钮，不是应用的问题；脚本已修好，但**还没重跑**。下次先跑一遍 E2E，确认第 19 步（临时对话）通过。
- `agent_controller.dart` 新增的待确认计数和模板运行**还没有测试**（静态检查已通过）。
