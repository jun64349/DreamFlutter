# DreamFlutter：给 Agent 的项目规矩

文档总目录在 [docs/README.md](docs/README.md)。开工前先读 [docs/NEW-AGENT-START.md](docs/NEW-AGENT-START.md)（接手须知：用户、规矩、方向、环境）、[docs/HANDOFF.md](docs/HANDOFF.md) 最上面的当前状态和 [docs/dev-guide.md](docs/dev-guide.md)。界面以 [docs/design/v1-redesign-spec.md](docs/design/v1-redesign-spec.md) 和原型 [docs/design/prototype/v1-redesign.html](docs/design/prototype/v1-redesign.html) 为准（2026-11-14 用户要求整体 UI 重做；概念、流程、用词仍看 [docs/design/interaction-design.md](docs/design/interaction-design.md)）。跟用户说话一律用平实的中文。

## 到 1.0 的最后路线（用户 2026-11-17 定，必须照做）

0.13.0（已完成）→ **0.13.1** 修真实验证剩余问题 → 完整安装与升级验证 → 性能与包体瘦身、启动速度、安装流程（选目录等）→ 降低上手门槛 → **1.0 preview** 打包推送 → preview 阶段做朋友内测 → **1.0 正式版**。详表在 [docs/roadmap.md 页首★节](docs/roadmap.md)。

- **按这条路线逐步做，不要另起规划、不要改顺序、不要插入新阶段或新功能。** 和其他文档冲突时以它为准；没写到的细节先问用户。
- 每一步做完交用户验收再进下一步；推送、打标签、合并 main 每次都要用户明确同意。

## 已定型的核心交互逻辑（1.0 现行）

- **16 条核心交互逻辑不要动（视觉与布局以 1.0 重做版 `v1-redesign-spec.md` / `v1-redesign.html` 为准）。** 清单和守着它们的测试在 [docs/design/settled-behaviors.md](docs/design/settled-behaviors.md)。新功能装进 1.0 现有位置，不改这些地方的交互逻辑和用词；只有用户明确要求改某一条时才动。
- 清单里列出的测试必须一直通过，不能为了让测试通过而改它的期望。后端和测试任务同样适用：后端改动不能让这些表现变样。

## 分工与验证（T-142，用户 2026-11-14 最新决定）

- **2026-11-19 当前状态**：第 6 步朋友内测进行中：内测包 `dist/beta.1`（激活码一步、只走随想 GPT Pro，见 docs/design/beta-pool.md）已交用户自己发；修卸载卡住后发了 **1.0.0-preview.2**（标签 `v1.0.0-preview.2`，最新发布）。推送、标签、合并、发布仍需逐次授权。下一条为前序记录。
- **2026-11-18 状态（历史）**：路线第 0–5 步完成，**1.0.0-preview.1 已发布**（main 快进到发布提交、标签 `v1.0.0-preview.1`、GitHub 发布页设为最新发布）。下一步第 6 步朋友内测，细节等用户定，见 [HANDOFF](docs/HANDOFF.md) 顶部。推送、标签、合并、发布仍需逐次授权。下一条为前序记录。
- **2026-11-17 决定（历史）**：0.13 真实任务验证完成并修复，用户授权提交 `a515046`、打标签 `v0.13`、推送分支 `v0.12-frontend` 与标签（未合并 main）。下一步见 [HANDOFF](docs/HANDOFF.md) 顶部：剩余小问题等用户定，再进安装与升级；推送、标签、合并仍需逐次授权。下一条为前序记录。
- **2026-11-16 试用反馈修正后的决定（历史）**：七项修正已完成且定向验证通过，见 [试用反馈修正回执](docs/releases/v0.12-试用反馈修正.md) 和 11 张实窗图 `app/build/trial-feedback/index.html`。用户授权的本地提交、记录与打包已完成：**0.12.1+16**，代码提交 `55c4d49`，产物 `dist/v0.12.1/DreamFlutter` 与 zip；构建、包体及压缩校验见 [0.12.1 发布记录](docs/releases/v0.12.1.md)。仍不推送、不打标签、不切分支。下次从 [真实任务验证计划](docs/releases/v0.13-真实任务验证计划.md) 开始，须等用户恢复开发并提供指定 API 配置和预算；不用既有私人渠道，不提前跑真实 API。已完成的全量检查不重复跑。
- **2026-11-16 前一版收尾记录（历史）**：用户当时确认本版已无问题，要求完成收尾、本地提交和打包，产物为 0.12.0+15；不推送、不切分支。下一主题集仍仅为调研样稿，未经选定不实装。
- **2026-11-16 前一轮约定（已验收）**：全局中英文字体统一、中英引文各扩充随机候选、现有十二主题归为名作主题集并加强控件和动效。下一主题集只做调研和可交互样稿，选定后再实装。该轮「看效果后再决定提交」已由上条收尾授权解除。
- **2026-11-16 后续决定优先**：用户试用 test.6 后基本接受，要求完成最后的侧栏、首页、案头、过程块、右栏与审批收起修正，展示真实效果，不再打包测试版，并授权整理 0.12 本地提交。子代理以 Sol 为主、必要时 Terra。每次只跑涉及文件、只拍对应场景；不推送、不打标签、不切分支。下面的「完成后再问提交」是此前阶段的约定，本轮提交已有授权。
- 这次整体 UI 重做的原型、设计、Flutter 实现和验收都在当前 Kimi Code 窗口完成，**不再派 Codex**；Codex 留到全部完成后做全量 review。
- 不再每批跑全量测试和守护测试；R1–R6 做针对性检查，R7 全部完成后统一跑一次 `flutter analyze`、窗口全量测试和守护测试。守护测试的行为断言仍不能改。
- 0.12 先不提交、验收后再问的约定属于早期阶段；当前本地提交和打包授权见本节首条，推送仍未授权。
- 原型预览使用用户指定的本机 Edge 扩展，不再使用此前会异常等待的预览工具。

## 界面设计原则

- **1.0 前端设计已定**（2026-11-14 整体 UI 重做定稿）：以 [docs/design/v1-redesign-spec.md](docs/design/v1-redesign-spec.md) 和原型 [docs/design/prototype/v1-redesign.html](docs/design/prototype/v1-redesign.html) 为准（朋友内测版叠加 [docs/design/beta-pool.md](docs/design/beta-pool.md)；早期 `interaction-v2.html` 已作废，仅作历史参考）。新功能装进 1.0 现有页面和位置，不另起页面结构、不换交互方式；放不进去先问用户。

- **Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.**
  避免不必要的次要标签和描述，让布局本身来传达信息。（用户 2026-11-09 定；也写在交互设计第二节第 7 条、设计语言第一节、开发规范第五节）
  - 能靠位置、分组、顺序、图标或状态看懂的，不再加副标题、说明行、提示文字。
  - 要加一行说明之前，先想能不能改布局让它不需要说明。
  - 设计里明确规定的除外：页面诗意标题下的直白名、状态短句下那一行实际在做什么（设计第一节、第七节）。
