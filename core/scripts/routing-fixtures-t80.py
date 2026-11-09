"""Owned, fixed input documents for routing acceptance. No downloads or private user inputs."""
import json
import sys
from pathlib import Path
from docx import Document
from openpyxl import Workbook
from pptx import Presentation
from pptx.util import Inches
from pypdf import PdfReader

root = Path(sys.argv[1]).resolve()
root.mkdir(parents=True, exist_ok=True)
(root / "sales.csv").write_text("department,sales,quantity\nA,120,4\nB,80,2\nA,50,1\n", encoding="utf-8")
(root / "materials.md").write_text("# 本周记录\n日期：2026-11-02 至 2026-11-08。\n本周完成资料整理和流程验证，计划 10 项、完成 8 项。\n风险：剩余两项依赖验收。下周先做联调，再交付候选版本。\n销售数据以 sales.csv / sales.xlsx 为准，总额须由真实数据计算。\n", encoding="utf-8")
doc = Document()
doc.add_heading("本周进展材料", 0)
doc.add_paragraph("已完成资料整理和流程验证。计划十项，完成八项，剩余两项需要验收。")
doc.add_paragraph("下周安排：完成联调，准备交付。")
table = doc.add_table(rows=1, cols=2)
table.rows[0].cells[0].text, table.rows[0].cells[1].text = "类别", "金额"
for label, value in [("A", "170"), ("B", "80")]:
    row = table.add_row().cells
    row[0].text, row[1].text = label, value
doc.save(root / "materials.docx")
book = Workbook()
sheet = book.active
sheet.title = "销售"
for row in [("部门", "销售额", "数量"), ("A", 120, 4), ("B", 80, 2), ("A", 50, 1)]:
    sheet.append(row)
sheet["E1"], sheet["E2"] = "总额公式", "=SUM(B2:B4)"
book.save(root / "sales.xlsx")
slides = Presentation()
slide = slides.slides.add_slide(slides.slide_layouts[5])
slide.shapes.title.text = "本周材料"
box = slide.shapes.add_textbox(Inches(1), Inches(2), Inches(8), Inches(2))
box.text_frame.text = "计划十项，完成八项。下周联调后准备交付。"
slides.save(root / "materials.pptx")

def pdf(path, title):
    stream = ("BT /F1 14 Tf 50 760 Td (" + title + ") Tj 0 -30 Td (Department Sales) Tj 0 -24 Td (A 170) Tj 0 -24 Td (B 80) Tj ET").encode("ascii")
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>", b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"]
    result = bytearray(b"%PDF-1.4\n")
    positions = [0]
    for number, body in enumerate(objects, 1):
        positions.append(len(result))
        result.extend(f"{number} 0 obj\n".encode() + body + b"\nendobj\n")
    offset = len(result)
    result.extend(f"xref\n0 {len(positions)}\n0000000000 65535 f \n".encode())
    for position in positions[1:]:
        result.extend(f"{position:010d} 00000 n \n".encode())
    result.extend(f"trailer << /Size {len(positions)} /Root 1 0 R >>\nstartxref\n{offset}\n%%EOF\n".encode())
    path.write_bytes(result)
    assert "Department" in PdfReader(path).pages[0].extract_text()

pdf(root / "table.pdf", "Sales fixture")
pdf(root / "appendix.pdf", "Appendix fixture")
example = root / "example-skill"
example.mkdir(exist_ok=True)
(example / "SKILL.md").write_text("---\nname: example-skill\ndescription: 一个用于阅读说明结构的示例，不是已安装技能\n---\n# 示例流程\n先确认输入和目标，再给出结果并说明检查方法。\n", encoding="utf-8")
print(json.dumps({"files": [str(path.relative_to(root)) for path in root.rglob("*") if path.is_file()], "salesTotal": 250}, ensure_ascii=False))
