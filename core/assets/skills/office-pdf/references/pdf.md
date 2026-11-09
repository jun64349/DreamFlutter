# pypdf 片段与范围

```python
from pypdf import PdfReader, PdfWriter
reader = PdfReader(str(input_path))
if reader.is_encrypted:
    raise ValueError('文件已加密，需要可用密码；不能假报已读取')
writer = PdfWriter()
# 用户要求第 2–3 页：先验证 1 <= 2 <= 3 <= len(reader.pages)。
for index in range(1, 3):
    writer.add_page(reader.pages[index])
writer.write(str(output_path))
check = PdfReader(str(output_path))
assert len(check.pages) == 2
text = '\n\n'.join((page.extract_text() or '') for page in check.pages)
```

合并：对每个已经确认的输入 `writer.append(str(path))`，最后写新路径并校验总页数。大型合并会占内存，可按用户接受的分卷拆批；不能自行删页凑进内存。文字抽取一般不需要为每页渲染图片。

从有文字的 PDF 重建 Word/Excel 是结构化整理，不是原版式的无损转换；明确实际提取和核对范围。库自身不提供 Office 的页面渲染器，也不是 OCR 引擎。
