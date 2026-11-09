---
name: office-pptx
description: 用材料、Markdown、表格或图表创建和修改 PowerPoint PPTX，编排中文演示文稿、批量汇报，或处理 PPT 旧格式与演示导出 PDF。用于实际演示文件，不用于普通文字提纲。
---

使用默认 Python 和已随包 python-pptx；图表可先用 matplotlib 画 PNG 后等比插入。先读材料，确定听众、时长、页面数和必须保留的数据；已有模板时沿用其母版与主题。

## 版式

- 无模板采用 16:9；一页一个明确结论，标题约 28–32 pt、正文约 18–22 pt，页边留白一致，中文使用可用的微软雅黑/等线等字体。正文过多时拆页，不靠缩小到难读来塞内容。
- 建立统一标题/图/表位置；表格短列优先、数字列对齐，必要时把明细拆到附页。图像保持纵横比，提供清晰图注和单位，页面内不能越界、重叠或把标题遮住。
- 表格/图表进 PPT 要保留真实列名、数值和来源，不把截图当可编辑表格；如果用户要编辑，使用 PPT 原生表格。按需读 [PPTX 片段与核对](references/pptx.md)。

## 批量和验证

先做一个代表样稿并检查文本、边界，再继续已授权批次；逐个文件落盘和重开，不在内存保留整批演示。保存新文件保留原件；核对页数、标题、表格数值、图片和所有 shape 的页面边界。只能做结构检查时如实报告，不能声称已经在 PowerPoint 逐页看过。

## 转换与限制

`.ppt`→`.pptx` 或 PowerPoint→PDF 用 [本机 Office 转换入口](scripts/convert_office.py)：

```text
python <本技能绝对目录>/scripts/convert_office.py --probe --app powerpoint
python <本技能绝对目录>/scripts/convert_office.py --input <源文件> --output <新PPTX或PDF>
```

用本机 Microsoft PowerPoint，`not_available`（包括蝶君）明确说“本机没有可用的转换程序”。不安装 LibreOffice，不擅自关闭用户已打开的演示；`office_busy` 报告原因后等待用户结束其会话。复杂动画、宏、视频与字体替换的保真不能只凭保存成功就保证。公式重算、扫描 PDF OCR 首版不支持。
