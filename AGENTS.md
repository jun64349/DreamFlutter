# DreamFlutter：给 Agent 的项目规矩

开工前先读 [docs/HANDOFF.md](docs/HANDOFF.md) 最上面的当前状态和 [docs/dev-guide.md](docs/dev-guide.md)。界面以 [docs/design/interaction-design.md](docs/design/interaction-design.md) 为准。

## 界面设计原则

- **Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.**
  避免不必要的次要标签和描述，让布局本身来传达信息。（用户 2026-11-09 定；也写在交互设计第二节第 7 条、设计语言第一节、开发规范第五节）
  - 能靠位置、分组、顺序、图标或状态看懂的，不再加副标题、说明行、提示文字。
  - 要加一行说明之前，先想能不能改布局让它不需要说明。
  - 设计里明确规定的除外：页面诗意标题下的直白名、状态短句下那一行实际在做什么（设计第一节、第七节）。
