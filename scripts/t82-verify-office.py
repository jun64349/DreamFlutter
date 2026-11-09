import hashlib,json,pathlib,sys,zipfile
from openpyxl import load_workbook
from docx import Document
from PIL import Image
root=pathlib.Path(sys.argv[1]);book=load_workbook(root/'result.xlsx',data_only=False)
assert all(value in [c.value for sheet in book for row in sheet for c in row] for value in ('001','002','003'))
assert not any(c.data_type=='f' for sheet in book for row in sheet for c in row)
assert '汇总' in book.sheetnames
rows=list(book['汇总'].values);assert dict((r[0],r[1]) for r in rows[1:] if r[0] in ('海风','山林'))=={'海风':5,'山林':4}
image=Image.open(root/'chart.png');assert image.width>=600 and image.height>=300
doc=Document(root/'report.docx');assert doc.tables and doc.inline_shapes
text=''.join(c.text for t in doc.tables for r in t.rows for c in r.cells);assert all(x in text for x in ('海风','山林','5','4'))
with zipfile.ZipFile(root/'report.docx') as z:assert any(z.read(n)==(root/'chart.png').read_bytes() for n in z.namelist() if n.startswith('word/media/'))
print(json.dumps({'pass':True,'python':sys.executable,'chartSize':image.size,'sheets':book.sheetnames,'images':len(doc.inline_shapes)},ensure_ascii=True))
