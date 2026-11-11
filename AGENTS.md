# DreamFlutter：给 Agent 的项目规矩

开工前先读 [docs/HANDOFF.md](docs/HANDOFF.md) 最上面的当前状态和 [docs/dev-guide.md](docs/dev-guide.md)。界面以 [docs/design/interaction-design.md](docs/design/interaction-design.md) 为准。

## 已定型的操作和体验（v0.8.3 起，用户 2026-11-11 定）

- **现在的操作逻辑和体验已经不错，不要动。** 清单和守着它们的测试在 [docs/design/settled-0.8.3.md](docs/design/settled-0.8.3.md)。新功能装进现有位置，不改这些地方的交互、布局和用词；只有用户明确要求改某一条时才动。
- 清单里列出的测试必须一直通过，不能为了让测试通过而改它的期望。后端和测试任务同样适用：后端改动不能让这些表现变样。

## 分工（用户 2026-11-11 定）

- 前端（界面、交互、视觉）由 Claude 做。
- 后端和测试派给 Codex：Claude 按 `Claude Codex Bridge/任务模板.md` 写派工单，用户贴进 Codex 窗口。派工单要写明不碰「已定型」清单里的表现，并列出要跑的守护测试。

## 界面设计原则

- **1.0 前端形态已定**（用户 2026-11-10）：体验版原型 [docs/design/prototype/interaction-v2.html](docs/design/prototype/interaction-v2.html)。新功能装进它已有的页面和位置，不另起页面结构、不换交互方式；放不进去先问用户。

- **Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.**
  避免不必要的次要标签和描述，让布局本身来传达信息。（用户 2026-11-09 定；也写在交互设计第二节第 7 条、设计语言第一节、开发规范第五节）
  - 能靠位置、分组、顺序、图标或状态看懂的，不再加副标题、说明行、提示文字。
  - 要加一行说明之前，先想能不能改布局让它不需要说明。
  - 设计里明确规定的除外：页面诗意标题下的直白名、状态短句下那一行实际在做什么（设计第一节、第七节）。
