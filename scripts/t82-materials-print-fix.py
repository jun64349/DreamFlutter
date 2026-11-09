"""Adjust only freshly generated synthetic XLSX/XLS print layout; preserve original QA evidence."""
import pathlib,json,importlib.util,shutil
from openpyxl import load_workbook
repo=pathlib.Path(__file__).resolve().parent.parent;qa=repo/'dist/t82-materials-qa';root=pathlib.Path(r'E:\DreamFlutter实测材料\v0.7')
idx=json.loads((root/'材料索引.json').read_text('utf8'));p=root/idx['U07-20']/'新格式/测试.xlsx'
w=load_workbook(p);s=w.active;s.print_area='A1:F5';s.page_setup.orientation='landscape';s.page_setup.paperSize=s.PAPERSIZE_A4;s.page_setup.fitToWidth=1;s.page_setup.fitToHeight=1;s.sheet_properties.pageSetUpPr.fitToPage=True;w.save(p)
helper=qa/'legacy-worker/convert_office.py';sp=importlib.util.spec_from_file_location('fixture_print',helper);m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m)
dest=qa/'print-fixed.xls';r=m._worker({'mode':'convert','app':'excel','input':str(p),'output':str(dest)},60)
assert r['ok'],r;shutil.copyfile(dest,root/idx['U07-20']/'旧格式/测试.xls');print(json.dumps(r))
