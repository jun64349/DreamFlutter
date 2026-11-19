# docs/design：设计资料

**设计原则**见 [interaction-design.md](interaction-design.md) 第二节，所有界面都按它做。其中第 7 条（用户 2026-11-09 加）：Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining. 避免不必要的次要标签和描述，让布局本身来传达信息。

| 文件 / 文件夹 | 内容 |
|---|---|
| [v1-redesign-spec.md](v1-redesign-spec.md) | **1.0 前端实现规格（当前唯一视觉/布局依据）**：2026-11-14 整体 UI 重做定稿 |
| [prototype/v1-redesign.html](prototype/v1-redesign.html) | **1.0 视觉主原型（当前为准）**：外壳、首页、对话、右栏、十二名作主题、内测激活模式 |
| [settled-behaviors.md](settled-behaviors.md) | **已定型的核心交互逻辑（1.0 现行）**：只守 16 条交互行为和回归测试，视觉已按 1.0 重做版更新 |
| [beta-pool.md](beta-pool.md) | **朋友内测版规格**：单卡激活码启动、随想 GPT Pro 固定模型池、关于页与反馈入口 |
| [interaction-design.md](interaction-design.md) | **概念、用词与核心交互流程**：设计原则、40 项概念表、12 个流程（视觉与页面架构已按 1.0 重做版更新） |
| [glossary.md](glossary.md) | 界面用词表：每个概念在界面上统一叫什么、哪些词不出现 |
| [prototype/interaction-v2.html](prototype/interaction-v2.html) | 历史早期体验版原型（已由 1.0 重做版 `v1-redesign.html` 替代，仅供参考） |
| [prototype/interaction-v1.html](prototype/interaction-v1.html) | 历史早期交互原型（已由 1.0 重做版 `v1-redesign.html` 替代，仅供参考） |
| [design-language.md](design-language.md) | 历史早期 0.4 设计语言（视觉与布局已由 `v1-redesign-spec.md` 替代） |
| [brand.md](brand.md) | 品牌：已定的事和用户原话、做法（1:1 矢量图标、随主题换色、深色白线、ico、窗口里的标志，都已做）、两套方案 |
| `assets/butterfly-icon-original.png` | 用户提供的图标原图（1024×1024），品牌的唯一依据 |
| `assets/butterfly.svg` | 原图的 **1:1 矢量复刻**（分层、可换色；做法和精度见 [brand.md](brand.md) 第二节第 1 步），由 `scripts/brand/trace_butterfly.py` 生成 |
| `assets/butterfly-trace-check.png` | 矢量版和原图的比对图 |
| `assets/butterfly-theme-preview.png` | 图标在 7 个名画主题下的配色预览（用户已同意，见 [brand.md](brand.md) 第二节第 2 步） |
| `assets/0*.png` | 0.4 界面截图（测试数据） |
| `canvases/frame-0.4/` | 窗口框架设计稿源文件（`.dc.html`，Claude 设计画布格式；`canvas.json` 是画布索引）。线上画布 https://claude.ai/artifact/NYpoVANRPEKZPmMgkhKYuS |
| `canvases/brand/` | 品牌方案设计稿源文件。线上画布 https://claude.ai/artifact/XYxoNwpu9p5mu2zWbVy5xv（图片引用的是画布里上传的原图） |

更早的设计资料：[history/v0.2-design.md](../history/v0.2-design.md)（三套视觉方向、信息架构）、v0.2 设计画布 https://claude.ai/artifact/6YEFyrT1H7voDESb7SkvDf。
