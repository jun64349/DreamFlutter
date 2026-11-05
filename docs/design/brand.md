# DreamFlutter 品牌（0.4 · 4.1）

记录日期：2026-11-05。本文是品牌方面**已定的事、用户原话、还没做的事**。界面设计语言见 [design-language.md](design-language.md)。

## 一、已定（用户 2026-11-05）

| 项 | 决定 | 用户原话 |
|---|---|---|
| 图标 | 用用户提供的橙色蝴蝶（[assets/butterfly-icon-original.png](assets/butterfly-icon-original.png)，1024×1024，米色圆角底、深棕粗轮廓、橙色到杏色渐变的翅膀边、米白翅心、两根外卷触角） | 「用我给的那只橙色蝴蝶」 |
| 矢量版 | 要做一份 **1:1 完整、完美复刻**原图的矢量图（SVG），用于二次创作和组合设计；**不改造型、不简化、不加变体** | 「我的意思矢量版是请 1:1 完整完美复刻，这样可以方便进行二创和后续组合设计使用，不是说用原图了不然都没有调整空间」「请完美复刻好嘛，不要做更改了」 |
| 颜色跟主题 | 图标的**填充颜色**、界面和 UI 的颜色，都跟着名画主题变化适配 | 「图标的填充的颜色、界面的颜色 ui 的颜色都跟着名画名作来变更适配」 |
| 深色 | 深色场景下，图标的**黑色轮廓线换成白线**（填充仍跟主题） | 「深色场景的话轮廓黑线变成白线就行」 |
| 命名 | 「工作台」「蝶君」先保持这两个名字 | 「『工作台』和『蝶君』就先叫这名字就行」 |

## 二、还没做（下一步，按顺序）

1. **1:1 矢量复刻**：照原图逐段描出 SVG。要求：
   - 和原图叠在一起看轮廓、触角、翅膀分区线、翅心形状、渐变方向都对得上（建议把原图放在底层、半透明叠 SVG 对齐，或用描图工具先出路径再手工修）。
   - 分层、命名清楚，方便换色：`background`（圆角底）、`outline`（所有深色线条，一个描边色）、`wing-band-left/right`（橙色翅边，渐变）、`wing-core`（米白翅心）、`antennae`。颜色全部写成变量（CSS 变量或 `currentColor`），不要写死在路径里。
   - 现有草稿 [assets/butterfly-icon-trace-draft.svg](assets/butterfly-icon-trace-draft.svg)（渲染图 [png](assets/butterfly-icon-trace-draft.png)）**不合格**：是近似重画，上翅形状、翅心、分区线和原图都有出入。只能当分层和变量结构的参考。
2. **随主题换色**：每个名画主题给图标定一组颜色（底色、翅边渐变两端、翅心、轮廓线），和界面主色一起放进主题（`app/lib/theme.dart` 的 `PaintingTheme` / `AppColors`）。浅色主题轮廓用深色线；**深色主题轮廓用白线**。
3. **生成图标文件**：从矢量版导出应用图标 `.ico`（16 / 24 / 32 / 48 / 64 / 128 / 256）、托盘图标（浅色、深色任务栏各一）、安装包图标；替换 `app/windows/runner/resources/app_icon.ico`（exe 图标）和 `app/assets/tray_icon.ico`（托盘，`desktop_shell.dart` 里 `trayManager.setIcon`）。托盘和 exe 图标不随主题变（Windows 只能有一份），用原图配色。
4. **窗口里的标志**：`theme.dart` 的 `ButterflyMark`（顶栏、首页、蝶君页）换成矢量版，按当前主题取色。
5. 「梦蝶」朱印、组合标志（见第三节）是否采用，用户还没表态。

## 三、已出的方案（画布，供参考）

画布：https://claude.ai/artifact/XYxoNwpu9p5mu2zWbVy5xv（私有，用户本人能打开）。源文件存在 [canvases/brand/](canvases/brand/)。

- **方案一「印」**（[scheme1-seal.dc.html](canvases/brand/scheme1-seal.dc.html)）：原图标志 + 宋体「DreamFlutter」+ 一方红底白字「梦蝶」朱印 + 「栩栩然胡蝶也」；各尺寸、托盘（浅 / 深任务栏）、顶栏里的样子；品牌色取自原图：赭橙 #C96A4A、杏 #DDA27F、米 #EEE7D8、墨 #3B352D、朱印 #A8332A；界面颜色跟名画主题。
- **方案二「蝶橙」**（[scheme2-orange.dc.html](canvases/brand/scheme2-orange.dc.html)）：原图标志 + 「梦蝶」大字；新增默认主题「梦蝶」（主色 #C96A4A、文字用 #A9533A、浅 #DDA27F、底 #F6F0E4、侧栏 #EEE7D8、墨 #3B352D；深色版强调色 #E39A78），浅深两版窗口示意。
- 用户最后的回复（第一节）是「颜色都跟名画主题变」，更接近方案一的思路，但多了「图标填充也跟主题变」。两套都没有被明确选中，**以第一节为准**。
- 被否掉的：我先做的矢量「近似重画」和「线描单色」变体（改了造型，用户不要）。

## 四、给之后做设计的人

- 用户给的素材，造型一律不改；要矢量就 1:1 复刻。
- 视觉方向（用户 2026-10-29 定）：参考 HanaAgent 的文艺、简洁大气；蝴蝶元素；主题以世界名画名作为来源（见 [../v0.2-design.md](../v0.2-design.md) 第三节；现有主题 `theme.dart` 的 `PaintingTheme.all`：蛱蝶 jiadie、草蝶 caodie、羽化 yuhua、神思 shensi（日间），墨夜 moye、幽华 youhua、琉光 liuguang（夜间））。
