# PPTX 片段

```python
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
deck = Presentation()
deck.slide_width, deck.slide_height = Inches(13.333333), Inches(7.5)
slide = deck.slides.add_slide(deck.slide_layouts[6])
title = slide.shapes.add_textbox(Inches(.6), Inches(.4), Inches(12.1), Inches(.7))
p = title.text_frame.paragraphs[0]
p.text = '来自材料的主要结论'
p.font.name, p.font.size, p.font.bold = '微软雅黑', Pt(30), True
p.font.color.rgb = RGBColor.from_string('183B36')
table = slide.shapes.add_table(3, 2, Inches(.7), Inches(1.6), Inches(6), Inches(2)).table
for row, cells in enumerate([['项目', '数量'], ['甲', '3'], ['乙', '5']]):
    for col, text in enumerate(cells):
        cell = table.cell(row, col)
        cell.text = text
        for p in cell.text_frame.paragraphs:
            p.font.name, p.font.size = '微软雅黑', Pt(20)
# slide.shapes.add_picture(str(chart_path), Inches(7), Inches(1.6), width=Inches(5.3))
deck.save(str(output_path))
check = Presentation(str(output_path))
for slide in check.slides:
    for shape in slide.shapes:
        assert shape.left >= 0 and shape.top >= 0
        assert shape.left + shape.width <= check.slide_width
        assert shape.top + shape.height <= check.slide_height
```

修改文字时先读 runs/paragraphs；整段替换可能丢局部样式。图片宜事先按给定宽度核对高度，不能任意指定宽高压扁。Markdown/文本可映射为标题和正文，材料的长表格通常适合摘要页+附页，不需要照搬 Markdown 符号。
