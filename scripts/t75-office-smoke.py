"""Synthetic office capability check; run with the shipped default Python, not a development venv."""
import pathlib,sys,json,hashlib,warnings,socket,os,importlib.metadata as metadata
out=pathlib.Path(sys.argv[1]).resolve();out.mkdir(parents=True,exist_ok=True);os.chdir(out)
def offline(*args,**kwargs):raise AssertionError('Office smoke must never use a network connection')
socket.create_connection=offline;socket.socket.connect=offline
os.environ['MPLBACKEND']='Agg';os.environ['MPLCONFIGDIR']=str(out/'mpl-cache')
warnings.filterwarnings('error',message='Glyph .* missing from font')
from docx import Document
d=Document();d.add_heading('中文周报',0);d.add_paragraph('项目进度');d.add_table(rows=2,cols=2).cell(0,0).text='任务';d.save('sample.docx');assert Document('sample.docx').paragraphs[0].text=='中文周报'
from openpyxl import Workbook,load_workbook
w=Workbook();s=w.active;s.append(['名称','数量']);s.append(['甲',2]);s.append(['乙',3]);s['B4']='=SUM(B2:B3)';w.save('sample.xlsx');r=load_workbook('sample.xlsx');assert r.active['B4'].value=='=SUM(B2:B3)' and r.active['A2'].value=='甲'
from pptx import Presentation
from pptx.util import Inches
p=Presentation();p.slides.add_slide(p.slide_layouts[0]).shapes.title.text='中文汇报';p.slides.add_slide(p.slide_layouts[5]).shapes.add_table(2,2,Inches(1),Inches(1),Inches(4),Inches(2));p.save('sample.pptx');r=Presentation('sample.pptx');assert len(r.slides)==2 and r.slides[0].shapes.title.text=='中文汇报'
from pypdf import PdfWriter,PdfReader
p=PdfWriter();p.add_blank_page(width=300,height=300);p.add_blank_page(width=300,height=300);p.add_metadata({'/Title':'中文检查'});p.write('sample.pdf');r=PdfReader('sample.pdf');assert len(r.pages)==2 and r.metadata.title=='中文检查';p=PdfWriter();p.add_page(r.pages[1]);p.write('split.pdf');assert len(PdfReader('split.pdf').pages)==1
import pandas as pd
d=pd.DataFrame({'team':['A','B']*50000,'amount':range(100000)});d.to_csv('data.csv',index=False);r=pd.read_csv('data.csv');assert int(r.groupby('team').amount.sum().sum())==4999950000
import matplotlib
matplotlib.use('Agg')
from matplotlib import pyplot as plt,font_manager,ft2font
font=font_manager.findfont(font_manager.FontProperties(family=matplotlib.rcParams['font.sans-serif']),fallback_to_default=False)
face=ft2font.FT2Font(font);labels='中文图表每周任务数量甲乙丙';assert all(face.get_char_index(ord(c)) for c in labels)
fig,ax=plt.subplots(figsize=(8,4.5),layout='constrained');ax.bar(['甲','乙','丙'],[3,5,4],color='#267e69');ax.set_title('中文图表：每周任务数量');ax.set_ylabel('任务数量');fig.savefig('chinese-chart.png',dpi=150);plt.close(fig)
assert pathlib.Path('chinese-chart.png').stat().st_size>10000
proof={'pass':True,'python':sys.executable,'version':sys.version,'tests':['docx Chinese roundtrip','xlsx values/formula string roundtrip (not recalculation)','pptx two-slide roundtrip','PDF metadata/page split','100k CSV/group sum','Chinese chart/default font/glyph coverage'],'networkCalls':0,'font':font,'fontFamily':face.family_name,'fontSha256':hashlib.sha256(pathlib.Path(font).read_bytes()).hexdigest(),'versions':{n:metadata.version(n) for n in ['python-docx','openpyxl','python-pptx','pypdf','pandas','matplotlib']}}
pathlib.Path('office-results.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(proof,ensure_ascii=False))
