import pathlib,sys,json,zipfile,hashlib
kind=sys.argv[1];root=pathlib.Path(sys.argv[2]).resolve();result={'case':kind,'pass':False}
if kind=='docx':
 from docx import Document
 d=Document(root/'report.docx');text='\n'.join(p.text for p in d.paragraphs)+'\n'+'\n'.join(c.text for t in d.tables for r in t.rows for c in r.cells)
 assert 'T78' in text and '甲' in text and '乙' in text and '8' in text and d.tables
 assert any(p.style.name.startswith('Heading') for p in d.paragraphs)
 assert any([[c.text for c in row.cells] for row in table.rows]==[['项目','数量'],['甲','3'],['乙','5']] for table in d.tables)
 result.update(paragraphs=len(d.paragraphs),tables=len(d.tables),text=text)
elif kind=='xlsx':
 from openpyxl import load_workbook
 w=load_workbook(root/'result.xlsx',data_only=False);assert '汇总' in w.sheetnames
 all_values=[c.value for s in w for row in s for c in row]
 assert all(x in all_values for x in ['001','002','003']);numbers=[c.value for row in w['汇总'] for c in row if isinstance(c.value,(int,float))]
 assert 7 in numbers and 5 in numbers;assert not any(c.data_type=='f' for s in w for row in s for c in row)
 assert dict((row[0],row[1]) for row in w['汇总'].iter_rows(min_row=2,values_only=True) if row[0] in ('甲','乙'))=={'甲':7,'乙':5}
 assert all(s.freeze_panes=='A2' and s.auto_filter.ref for s in w)
 result.update(sheets=w.sheetnames,summaryNumbers=numbers)
elif kind=='pptx':
 from pptx import Presentation
 d=Presentation(root/'slides.pptx');assert len(d.slides)==2;assert abs(d.slide_width/d.slide_height-16/9)<.001
 tables=[];text=[]
 for slide in d.slides:
  for shape in slide.shapes:
   assert shape.left>=0 and shape.top>=0 and shape.left+shape.width<=d.slide_width+100 and shape.top+shape.height<=d.slide_height+100
   if shape.has_text_frame:text.append(shape.text)
   if shape.has_table:tables.extend(c.text for row in shape.table.rows for c in row.cells)
 assert 'T78' in '\n'.join(text) and all(x in tables for x in ['甲','乙','3','5'])
 result.update(slides=len(d.slides),tableCells=tables)
elif kind=='pdf':
 from pypdf import PdfReader
 second=PdfReader(root/'second.pdf');merged=PdfReader(root/'merged.pdf')
 assert len(second.pages)==1 and len(merged.pages)==3
 assert 'page 2' in second.pages[0].extract_text();assert 'page 2' in merged.pages[-1].extract_text()
 text=(root/'extracted.txt').read_text(encoding='utf8');assert 'page 1' in text and 'page 2' in text
 result.update(splitPages=1,mergedPages=3,text=text)
elif kind=='data':
 import pandas as pd
 from docx import Document
 from PIL import Image
 d=pd.read_csv(root/'summary.csv',encoding='utf-8-sig');assert dict(zip(d['项目'],d['数量']))=={'甲':7,'乙':5}
 image=Image.open(root/'chart.png');assert image.width>=600 and image.height>=300
 doc=Document(root/'chart-report.docx');assert len(doc.inline_shapes)>=1
 with zipfile.ZipFile(root/'chart-report.docx') as z:assert any(z.read(n)==(root/'chart.png').read_bytes() for n in z.namelist() if n.startswith('word/media/'))
 result.update(summary=d.to_dict(orient='records'),chartSize=image.size,images=len(doc.inline_shapes))
else:raise ValueError(kind)
result['pass']=True
(root/'verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(result,ensure_ascii=True))
