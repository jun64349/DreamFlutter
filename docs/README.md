# DreamFlutter 文档总目录

按「要做什么」找：接手开发先看第一组；查某个功能怎么设计、怎么调用看第二、三组；查以前为什么这么定看最后几组。

## 1. 接手与当前状态（先读）

| 文件 | 内容 |
|---|---|
| [NEW-AGENT-START.md](NEW-AGENT-START.md) | 接手须知：用户、规矩、方向、环境，顶部有可复制的开工提示 |
| [HANDOFF.md](HANDOFF.md) | 开发交接：当前状态、到 1.0 的路线以来每一步做了什么、下一窗口从哪开始 |
| [Windows V1.1.0 交付记录](releases/v1.1.0.md) | 本地 DSH、插件、蝶君工作区、Windows 安装包和验收结果 |
| [roadmap.md](roadmap.md) | 路线图：页首★节是到 1.0 的最后路线（必须照做），后面是各版本范围和 1.0 之后的方向 |
| [dev-guide.md](dev-guide.md) | 开发规范：怎么测、怎么打包、怎么交付 |
| [../AGENTS.md](../AGENTS.md) | 给 Agent 的项目规矩（定型体验不能动、推送要授权等） |

## 2. 后台设计 `architecture/`

| 文件 | 内容 |
|---|---|
| [architecture.md](architecture/architecture.md) | Windows V1.1 的 Flutter、Node、DSH 和早期版本架构 |
| [v1.1-system-plugins.md](architecture/v1.1-system-plugins.md) | V1.1.0 的 DSH 后台迁移、内置系统插件与蝶君原生工作空间验收 |
| [agent-modes.md](architecture/agent-modes.md) | Agent 模式（标准、极简、计划） |
| [memory-design.md](architecture/memory-design.md) | 记忆系统 |
| [long-task-design.md](architecture/long-task-design.md) | 长任务、目标与执行 |
| [session-relationships.md](architecture/session-relationships.md) | 会话关系、分支、侧边对话 |
| [security.md](architecture/security.md) | 安全：审批、敏感路径、沙箱边界 |
| [pi-channel-migration.md](architecture/pi-channel-migration.md) | Pi 服务商迁到 DreamFlutter 渠道 |

## 3. 接口 `api/`

- [api/README.md](api/README.md)：后台接口参考（0.11 起，按模块分文件，有契约测试守着）。
- [api/legacy/](api/legacy/)：更早单独写的几份接口说明（更新、请求账本、联网搜索、软件源、记忆上下文），新版以 `api/` 为准。

## 4. 界面设计 `design/`

- [design/README.md](design/README.md)：设计资料索引。
- 当前以 [v1-redesign-spec.md](design/v1-redesign-spec.md) 和原型 [prototype/v1-redesign.html](design/prototype/v1-redesign.html) 为准；概念、流程、用词看 [interaction-design.md](design/interaction-design.md)、[glossary.md](design/glossary.md)。
- 不能动的已定型核心交互逻辑（仅守逻辑，视觉以 1.0 重做版为准）：[settled-behaviors.md](design/settled-behaviors.md)。
- 内测版（模型池、激活码）：[beta-pool.md](design/beta-pool.md)。

## 5. 用户手册 `guide/`

- [guide/README.md](guide/README.md)：十课课本（程序内 设置 › 关于与更新 › 使用说明是同一份）。

## 6. 发布与验收记录 `releases/`

按版本号命名，正式发布、候选包（`-test.N`）和验证回执都在这里：

- 1.0 预览版与内测：[v1.0.0-preview.2](releases/v1.0.0-preview.2.md)（最新）、[v1.0.0-preview.1](releases/v1.0.0-preview.1.md)、[macOS 内测版使用说明](releases/macos-beta-guide.md)
- 0.13 验证：[真实任务验证计划](releases/v0.13-真实任务验证计划.md) / [回执](releases/v0.13-真实任务验证回执.md)、[安装升级验证计划](releases/v0.13.1-安装升级验证计划.md) / [回执](releases/v0.13.1-安装升级验证回执.md)、[性能与包体回执](releases/v0.13.2-性能与包体回执.md)
- 更早：0.12（`v0.12*`）、0.8（`v0.8*`）、0.5–0.7、0.2–0.4（`v0.x-release-notes`）。

## 7. 测试 `testing/`

| 文件 | 内容 |
|---|---|
| [scenarios.md](testing/scenarios.md) | 发布前要走的全场景清单 |
| [autonomy/](testing/autonomy/)、[longtask/](testing/longtask/) | 蝶君自主执行、长任务的实测记录 |
| [computer-use-e2e.md](testing/computer-use-e2e.md)、[v0.7-user-checklist.md](testing/v0.7-user-checklist.md) | 早期的端到端方案和用户验收清单（历史） |

## 8. 调研 `research/`

| 位置 | 内容 |
|---|---|
| [onboarding/](research/onboarding/) | 降低上手门槛、两个版本（开放版 / 托管版）的调研，入口 [07-总结与待定项](research/onboarding/07-总结与待定项.md) |
| [v0.6/](research/v0.6/)、[v0.7/](research/v0.7/) | 两轮版本调研：决策备忘、修复批、各专题报告；v0.7 含路由数据和 T-72 实测证据 |
| `01`–`04-*.md` | 最早的选型调研（服务商与会话、记忆与技能、后台调度、案头卡片） |
| 其余专题 | 记忆（hermes、大语料）、Agent 可靠性与安全、子 Agent、WSL 沙箱、名画主题、Showcard、DeepSeek 用法 |
| [prompts/](research/prompts/) | 派给其他 Agent 做调研时用的提示词原文 |

## 9. 历史资料 `history/`

已经被后来的设计取代、只留作「当时为什么这么定」的记录：

- [HANDOFF-0.1-0.12](history/HANDOFF-0.1-0.12（2026-10-30至11-16）.md)：0.1 到 0.12 的开发交接（从 HANDOFF 挪出）。
- 各版本计划与设计：`v0.1.1-plan`、`v0.2-*`、`v0.3-design`、`v0.3.1-backup-design`、`v0.8.x-plan`、`v0.12-frontend-*`、`v1.0-convergence`。
- 评审：`REVIEW-2026-11-*`、`roadmap-review-2026-11-*`、`T-143-差距清单`。
