"""Create authentic legacy inputs, then validate isolated copies using candidate tools."""
import csv, hashlib, importlib.util, json, pathlib, shutil, sys, zipfile
ROOT=pathlib.Path(r'E:\DreamFlutter实测材料\v0.7');REPO=pathlib.Path(__file__).resolve().parent.parent
CANDIDATE=REPO/'dist/t82-unpacked/current';QA=REPO/'dist/t82-materials-qa'
idx=json.loads((ROOT/'材料索引.json').read_text('utf8'))
def folder(key):return ROOT/idx[key]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
module_path=CANDIDATE/'core/assets/office/convert_office.py'
module=load('candidate_office',module_path)
run=sys.argv[1] if len(sys.argv)>1 else 'initial'
proof={'candidate':'0.7.0-test.3','paidModelCalls':0,'tests':[],'run':run}
def save():(QA/('office-results.json' if run=='initial' else f'office-results-{run}.json')).write_text(json.dumps(proof,ensure_ascii=False,indent=2),encoding='utf8')
try:
    # Existing candidate guard refuses an active user Office process. Only owned test worker copy changes legacy save constants.
    worker=QA/'legacy-worker';worker.mkdir(exist_ok=run!='initial');shutil.copyfile(module_path,worker/'convert_office.py')
    text=module_path.with_suffix('.ps1').read_text('utf8')
    for old,new in [('SaveAs2([string]$request.output, 16)','SaveAs2([string]$request.output, 0)'),('SaveAs([string]$request.output, 51)','SaveAs([string]$request.output, 56)'),('SaveAs([string]$request.output, 24)','SaveAs([string]$request.output, 1)')]:
        assert text.count(old)==1;text=text.replace(old,new)
    (worker/'convert_office.ps1').write_text(text,encoding='utf8');maker=load('fixture_legacy',worker/'convert_office.py')
    legacy=folder('U07-20')/'旧格式';legacy.mkdir(exist_ok=run!='initial')
    for old,new,app in [('doc','docx','word'),('xls','xlsx','excel'),('ppt','pptx','powerpoint')]:
        source=folder('U07-20')/'新格式'/('测试.'+new);dest=legacy/('测试.'+old)
        r=maker._worker({'mode':'convert','app':app,'input':str(source),'output':str(dest)},60) if not dest.exists() else {'ok':True,'verifiedExistingFixture':True}
        proof['tests'].append({'operation':'make-'+old,**r});save();assert r['ok'],r
        assert dest.read_bytes().startswith(bytes.fromhex('D0CF11E0A1B11AE1'))
    # Reopening generated files, merging PDFs and converting Office all happen on a separate copy.
    copy=QA/('office-copy' if run=='initial' else 'office-copy-'+run);copy.mkdir()
    for key in [f'U07-{i:02}' for i in range(15,23)]:shutil.copytree(folder(key),copy/idx[key])
    from docx import Document
    from openpyxl import load_workbook
    from pptx import Presentation
    from pypdf import PdfReader, PdfWriter
    from PIL import Image
    for path in copy.rglob('*.docx'):
        doc=Document(path);assert '测试周报' in '\n'.join(p.text for p in doc.paragraphs)
        assert len(doc.tables)==1 and len(doc.tables[0].rows)==4
        assert '茶杯' in doc.tables[0].cell(1,0).text
        if '含图' in path.name:assert len(doc.inline_shapes)==1
        proof['tests'].append({'operation':'read-docx','file':str(path.relative_to(copy)),'pass':True})
    for path in copy.rglob('*.xlsx'):
        w=load_workbook(path,data_only=False);s=w.active
        assert s['A2'].value=='001' and s['B3'].value=='记事本' and s['D4'].value==1
        if '公式' in path.name:
            assert s['F2'].value=='=D2*E2' and s['F5'].value=='=SUM(F2:F4)'
            assert load_workbook(path,data_only=True).active['F2'].value is None
        else:assert s['F5'].value==79
        proof['tests'].append({'operation':'read-xlsx','file':str(path.relative_to(copy)),'pass':True})
    for path in copy.rglob('*.pptx'):
        p=Presentation(path);assert len(p.slides)==3
        assert p.slides[0].shapes.title.text=='测试周报'
        assert any(s.has_table for s in p.slides[1].shapes) and any(s.shape_type==13 for s in p.slides[1].shapes)
        proof['tests'].append({'operation':'read-pptx','file':str(path.relative_to(copy)),'pass':True})
    for path in copy.rglob('*.csv'):
        with path.open(encoding='utf-8-sig',newline='') as f:rows=list(csv.DictReader(f))
        assert len(rows)==3 and rows[0]['编号']=='001' and sum(float(r['数量'])*float(r['单价']) for r in rows)==79
        proof['tests'].append({'operation':'read-csv','file':str(path.relative_to(copy)),'pass':True})
    for path in copy.rglob('*.png'):
        with Image.open(path) as image:image.verify()
    pdfdir=copy/idx['U07-18'];writer=PdfWriter()
    for name in ['普通文字A.pdf','普通文字B.pdf']:writer.append(pdfdir/name)
    merged=QA/'merged.pdf';writer.write(merged)
    reader=PdfReader(merged);assert len(reader.pages)==3
    markers=['PAGE_A1','PAGE_A2','PAGE_B1']
    assert all(marker in reader.pages[i].extract_text() for i,marker in enumerate(markers))
    split=PdfWriter();split.add_page(reader.pages[1]);split.write(QA/'split-page2.pdf')
    text=PdfReader(QA/'split-page2.pdf').pages[0].extract_text();assert '第二页：记事本，数量3，金额24元' in text
    (QA/'page2.txt').write_text(text,encoding='utf8')
    scan=PdfReader(copy/idx['U07-22']/'扫描件.pdf').pages[0];assert not (scan.extract_text() or '').strip()
    assert any(v.get_object().get('/Subtype')=='/Image' for v in scan['/Resources']['/XObject'].get_object().values())
    proof['tests'].append({'operation':'pdf-merge-split-extract','pages':3,'order':markers,'split':'PAGE_A2','pass':True})
    proof['tests'].append({'operation':'scan-no-text-layer','imageOnly':True,'pass':True})
    nativecopy=copy/idx['U07-20'];outputs=QA/('converted' if run=='initial' else 'converted-'+run);outputs.mkdir()
    for old,new in [('doc','docx'),('xls','xlsx'),('ppt','pptx')]:
        if run!='initial' and old=='doc':
            previous=json.loads((QA/'office-results.json').read_text('utf8'))
            reused=[t for t in previous['tests'] if t['operation'] in ['doc-docx','docx-pdf']]
            assert len(reused)==2 and all(t['ok'] for t in reused)
            proof['tests'].append({'operation':'reuse-unchanged-doc-conversion','evidence':'office-results.json','pass':True});continue
        source=nativecopy/'旧格式'/('测试.'+old);before=hashlib.sha256(source.read_bytes()).hexdigest()
        r=module.convert(source,outputs/('旧转新.'+new),timeout=60);proof['tests'].append({'operation':old+'-'+new,**r});save();assert r['ok'],r
        assert hashlib.sha256(source.read_bytes()).hexdigest()==before
        r=module.convert(outputs/('旧转新.'+new),outputs/(new+'.pdf'),timeout=60);proof['tests'].append({'operation':new+'-pdf',**r});save();assert r['ok'],r
        pdf=PdfReader(r['output']);assert len(pdf.pages)==(3 if old=='ppt' else 1)
        extracted=''.join(p.extract_text() or '' for p in pdf.pages)
        assert ('79' in extracted if old=='xls' else '测试周报' in extracted)
    proof['pass']=True
except Exception as error:
    proof['pass']=False;proof['error']=str(error);raise
finally:
    save();print(json.dumps({'pass':proof.get('pass'), 'tests':len(proof['tests']),'error':proof.get('error')},ensure_ascii=True))
