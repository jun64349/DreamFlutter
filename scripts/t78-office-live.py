"""Native Office verification with synthetic files only; never attaches to an existing user application."""
import importlib.util,json,pathlib,sys,shutil,subprocess
root=pathlib.Path(__file__).resolve().parent.parent;out=pathlib.Path(sys.argv[1]).resolve();out.mkdir(parents=True,exist_ok=True)
module_path=pathlib.Path(sys.argv[2]).resolve() if len(sys.argv)>2 else root/'core/assets/office/convert_office.py'
spec=importlib.util.spec_from_file_location('t78_convert',module_path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
proof={'tests':[]};evidence=out/'native-results.json'
def save():evidence.write_text(json.dumps(proof,ensure_ascii=False,indent=2),encoding='utf8')
try:
 from pypdf import PdfReader
 for name,app in [('docx','word'),('xlsx','excel'),('pptx','powerpoint')]:
  result=module.convert(out/('input.'+name),out/(name+'.pdf'),timeout=45);proof['tests'].append({'operation':name+'-pdf',**result});save();assert result['ok'],result
  pdf=PdfReader(result['output']);assert len(pdf.pages)>0
  text=''.join(page.extract_text() or '' for page in pdf.pages)
  assert ('T78' in text if app!='excel' else '3' in text and '5' in text),text
 # Build genuine old-format fixtures using a test-only worker copy with explicit Office save-format constants.
 fixture=out/'legacy-fixture-worker';fixture.mkdir(exist_ok=True);shutil.copyfile(module_path,fixture/'convert_office.py')
 text=module_path.with_suffix('.ps1').read_text(encoding='utf8')
 for old,new in [('SaveAs2([string]$request.output, 16)','SaveAs2([string]$request.output, 0)'),('SaveAs([string]$request.output, 51)','SaveAs([string]$request.output, 56)'),('SaveAs([string]$request.output, 24)','SaveAs([string]$request.output, 1)')]:
  assert text.count(old)==1;text=text.replace(old,new)
 (fixture/'convert_office.ps1').write_text(text,encoding='utf8')
 s=importlib.util.spec_from_file_location('t78_fixture',fixture/'convert_office.py');maker=importlib.util.module_from_spec(s);s.loader.exec_module(maker)
 for old,new,app in [('doc','docx','word'),('xls','xlsx','excel'),('ppt','pptx','powerpoint')]:
  source=out/('legacy.'+old);r=maker._worker({'mode':'convert','app':app,'input':str(out/('input.'+new)),'output':str(source)},45)
  assert r['ok'],r;assert source.read_bytes().startswith(bytes.fromhex('D0CF11E0A1B11AE1'))
  result=module.convert(source,out/('restored.'+new),timeout=45);proof['tests'].append({'operation':old+'-'+new,**result});save();assert result['ok'],result
  if app=='word':
   from docx import Document
   assert 'T78' in Document(result['output']).paragraphs[0].text
  elif app=='excel':
   from openpyxl import load_workbook
   assert load_workbook(result['output']).active['B3'].value==5
  else:
   from pptx import Presentation
   assert 'T78' in Presentation(result['output']).slides[0].shapes.title.text
 proof['pass']=True
except Exception as error:
 proof['pass']=False;proof['error']=str(error);raise
finally:save();print(json.dumps(proof,ensure_ascii=True))
