import pathlib,sys,json,os
out=pathlib.Path(sys.argv[1]).resolve();out.mkdir(parents=True,exist_ok=True)
from docx import Document
d=Document();d.add_heading('T78 中文周报',0);d.add_paragraph('本周完成 8 项任务。');t=d.add_table(rows=1,cols=2);t.cell(0,0).text='项目';t.cell(0,1).text='数量';r=t.add_row().cells;r[0].text='甲';r[1].text='3';d.save(out/'input.docx')
from openpyxl import Workbook
w=Workbook();s=w.active;s.append(['项目','数量']);s.append(['甲',3]);s.append(['乙',5]);w.save(out/'input.xlsx')
from pptx import Presentation
p=Presentation();p.slides.add_slide(p.slide_layouts[0]).shapes.title.text='T78 中文汇报';p.save(out/'input.pptx')
(out/'sales.csv').write_text('编号,项目,数量\n001,甲,3\n002,乙,5\n003,甲,4\n',encoding='utf-8-sig')
(out/'brief.md').write_text('# T78 中文周报\n\n本周完成 8 项任务。\n\n## 明细\n\n| 项目 | 数量 |\n| --- | --- |\n| 甲 | 3 |\n| 乙 | 5 |\n',encoding='utf8')
os.environ['MPLBACKEND']='Agg';os.environ['MPLCONFIGDIR']=str(out/'mpl-cache')
import matplotlib
matplotlib.use('Agg')
from matplotlib.backends.backend_pdf import PdfPages
from matplotlib import pyplot as plt
with PdfPages(out/'input.pdf') as pdf:
 for text in ['T78 page 1 amount 3','T78 page 2 amount 5']:
  fig=plt.figure(figsize=(6,4));fig.text(.15,.6,text);pdf.savefig(fig);plt.close(fig)
print(json.dumps({'directory':str(out),'files':['input.docx','input.xlsx','input.pptx','input.pdf','brief.md','sales.csv']}))
