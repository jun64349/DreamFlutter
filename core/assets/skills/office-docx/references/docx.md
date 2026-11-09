# DOCX 操作要点

以下是按需组合的片段，不是固定内容模板。先读用户模板；无模板才选简单样式。

```python
from docx import Document
from docx.shared import Cm, Pt
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

doc = Document()
section = doc.sections[0]
section.page_width, section.page_height = Cm(21), Cm(29.7)
section.left_margin = section.right_margin = Cm(2)
section.top_margin = section.bottom_margin = Cm(2)
for name, size in [('Normal', 11), ('Title', 22), ('Heading 1', 16), ('Heading 2', 13)]:
    style = doc.styles[name]
    style.font.name = 'Calibri'
    style.font.size = Pt(size)
    style.element.get_or_add_rPr().get_or_add_rFonts().set(qn('w:eastAsia'), '微软雅黑')
doc.styles['Normal'].paragraph_format.space_after = Pt(6)
doc.add_heading('由材料决定的标题', 0)
doc.add_heading('一级标题', 1)
doc.add_paragraph('保留原始事实的正文。')
table = doc.add_table(rows=1, cols=2)
table.style = 'Light Shading Accent 1'
for cell, text in zip(table.rows[0].cells, ['项目', '结果']):
    cell.text = text
repeat = OxmlElement('w:tblHeader')
table.rows[0]._tr.get_or_add_trPr().append(repeat)
for item, value in [('甲', '3')]:
    cells = table.add_row().cells
    cells[0].text, cells[1].text = item, value
# 图表为自己核对过的数据生成，宽度不超过页面可用宽度。
# doc.add_picture(str(chart_path), width=Cm(16))
doc.save(str(output_path))
check = Document(str(output_path))
assert check.tables[0].cell(0, 0).text == '项目'
```

修改已有文档时优先局部更新 run/表格；给 paragraph.text 赋值会丢掉该段原有 run 级格式和链接，不要用于必须保留复杂格式的段落。python-docx 无法编辑的修订、嵌入对象等内容应先报告限制，保留原件。Markdown→Word 首版支持常见标题/段落/列表/表格；复杂 HTML、脚注和数学排版先核对再承诺。
