---
name: office-pdf
description: 合并、拆分、检查 PDF 或提取其中已有文字，以及检测本机 Microsoft Office 将 Word、Excel、PPT 导出 PDF。用于实际 PDF 文件处理；扫描 OCR 和 PDF 到可编辑 Office 的高保真还原不在首版范围。
---

默认 Python 已带 pypdf，工作台和蝶君均可直接处理已有 PDF。先核对页数、页码口径、是否加密与输出路径；用户看到的页码从 1 开始，代码索引从 0 开始，输出前明确转换。按需读 [PDF 示例](references/pdf.md)。

运行本地脚本用当前会话实际列出的执行工具：工作台是 `pwsh`，在其中调用 `python <脚本路径>`；蝶君是 `bash`，在其中调用 `python3 <脚本路径>`。`python` 是程序名。不要编造执行工具名，也不需要用 `tool_search` 搜索已随包的本地库；执行工具确实不可用时如实说明。

- 合并/拆页：保留原件，按用户指定顺序选页，写新文件后重开核对页数和首末页内容；未知密码/损坏文件如实失败，不改名冒充转换。
- 提字：用 `page.extract_text()`，必要时尝试 layout 模式；检查空文本、重复页眉和列顺序。提取不等于排版还原，不捏造漏字。规律表格可按明确列边界重建并抽样核对；列关系不清就给待核对行，不能声称任意 PDF 表格已准确还原。
- 批量：先少量代表页/文件，核对后完成已授权全量；逐份关闭文件句柄，按文件/页分批处理，记录成功、失败、空文本页，避免将整批 PDF/全部页图像读进内存。
- OCR：用户要求扫描版识别时明确“首版不支持扫描版 PDF OCR”。没有提取到文字时说明可能为扫描/图形/加密等原因；不要用空字符串冒称完整识别，也不绕到沙箱的 Tesseract 来越过已确认边界。

## Office→PDF 与旧格式

读 [转换入口](scripts/convert_office.py) 的 `--help`，以绝对路径执行：

```text
python <本技能绝对目录>/scripts/convert_office.py --probe
python <本技能绝对目录>/scripts/convert_office.py --input <DOCX/XLSX/PPTX或旧DOC/XLS/PPT> --output <新PDF>
```

同一辅助还支持 DOC→DOCX、XLS→XLSX、PPT→PPTX，调用对应本机 Office；不通过更换后缀转换。Office 位于工作台，蝶君没有 Office，`not_available` 必须明确回复“本机没有可用的转换程序”。不自动安装 LibreOffice/转换器。`office_busy` 说明需先结束对应用户 Office 会话；不关闭用户程序。只有 `ok=true` 且产物核对成功才算完成，超时/失败报告 JSON 原因。

表格 PDF 导出使用原工作簿页面设置和现有值，本版**不支持公式重算**；缓存缺失就说明限制，不能承诺导出已算好的结果。复杂宏、外链、动画、受保护文件或字体替换不能承诺保真。只要用户需要数据图表再放入文档，使用数据分析和相应文档技能输出后再核对。
