---
name: office-docx
description: 创建、修改中文 Word DOCX，把 Markdown、文本、表格或图表整理成可交付文档，或处理 DOC 旧格式和 Word 导出 PDF。适用于实际文件制作与批量文档处理；普通文字回答无需加载。
---

使用默认 `python`（蝶君用 `python3`）和已随包的 python-docx。先看实际输入、用途、必保留的文字/表格与输出路径；用户有模板时沿用其字体、样式和页眉页脚。技能目录为加载结果给出的 baseDir，读取资源用真实绝对路径，勿把相对脚本路径当成用户工作区路径。

## 制作与排版

- `.docx` 用 python-docx 读写；Markdown/文本先按标题、段落、列表、表格组织，使用真正的 Word Heading 样式，保留标题层级和原文事实。不能把原始 Markdown 标记直接粘成正文来冒称排版。
- 无模板时用 A4、约 2 cm 页边距；中文正文约 10.5–11 pt，标题形成明确层级；微软雅黑/等线等可用中文字体与西文分开设置 eastAsia，避免只设置 Latin font 后中文被随机替换。
- 表格留足正文宽度，表头有对比、跨页重复，数字按列统一精度和对齐；长表允许分页，避免靠重复空行、空格和巨大空白撑版。图表按页面可用宽度等比插入并加来源/单位说明，不能拉伸。
- 按需读取 [DOCX 示例与核对](references/docx.md)，其中有中文字体、重复表头和图片尺寸代码。内容/字段由本次材料决定，不机械套固定章节。

## 批量与交付

先处理一两个代表文件并重开核对，再继续已授权批次；输出到独立目录，保留源文件，不静默覆盖同名文件。多文件逐一处理，输出成功/失败清单和原因。对非常大的文本分章，不一次把全部材料塞进一个巨表。

保存后重开，比较关键段落、表格行数、图片数量及标题层级；必要时检查 OOXML。python-docx 的结构检查不能证明 Word 的实际分页已经看过。回执给可打开文件路径、做了哪些检查和未验证的版式事项。

## 旧格式与 PDF

`.doc`→`.docx` 或 Word→PDF 使用本技能的 [转换入口](scripts/convert_office.py)：

```text
python <本技能绝对目录>/scripts/convert_office.py --probe --app word
python <本技能绝对目录>/scripts/convert_office.py --input <源文件绝对路径> --output <新DOCX或PDF绝对路径>
```

辅助脚本通过随包的共享 Office 转换器调用本机 Microsoft Word；不安装转换程序，不覆盖源/既有输出。JSON 的 `ok=true` 且目标存在才算转换成功。`not_available` 必须如实说明“本机没有可用的转换程序”；蝶君没有 Office，同样报告。`office_busy` 请用户结束正在使用的对应 Office 会话后重试，不关闭用户程序；`timeout`/`conversion_failed` 保留原因，不改安全设置绕过。不要把更改扩展名当格式转换。

扫描版 PDF OCR、公式重算首版不支持；不承诺 PDF→Word 的高保真还原。要把提取到的 PDF 文字整理成 Word，可按实际文本重排并明确这是重建版式。
