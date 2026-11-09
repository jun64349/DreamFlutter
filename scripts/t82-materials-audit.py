"""Final read-only delivery audit, content hashes, representative PDF rendering, source freeze guard."""
import ast,hashlib,json,pathlib,re,shutil,subprocess
from PIL import Image,ImageOps,ImageDraw,ImageFont
REPO=pathlib.Path(__file__).resolve().parent.parent;ROOT=pathlib.Path(r'E:\DreamFlutter实测材料\v0.7');QA=REPO/'dist/t82-materials-qa';CANDIDATE=REPO/'dist/t82-unpacked/current'
idx=json.loads((ROOT/'材料索引.json').read_text('utf8'))
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def hashes(root):return {str(p.relative_to(root)):sha(p) for p in sorted(root.rglob('*')) if p.is_file()}
before=hashes(ROOT);copy=QA/'final-delivery-copy-r2';shutil.copytree(ROOT,copy)
assert hashes(copy)==before
assert len(idx)==32 and all((copy/v/'操作与预期.md').is_file() for v in idx.values())
assert (CANDIDATE/'app/dreamflutter.exe').is_file()
links=[]
for path in copy.rglob('*.md'):
    text=path.read_text('utf8')
    for m in re.finditer(r'\[[^\]]*\]\(([^)]+)\)',text):
        link=m[1].strip('<>').split('#')[0]
        if not link or re.match(r'\w+://',link):continue
        assert (path.parent/link).exists(),str(path)+': '+link
        links.append(link)
    assert not re.search(r'\bsk-[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]+|-----BEGIN .*PRIVATE KEY',text)
for path in copy.rglob('*.py'):ast.parse(path.read_text('utf8'))
for path in copy.rglob('*.mjs'):subprocess.run([str(CANDIDATE/'runtime/node.exe'),'--check',str(path)],check=True,capture_output=True)
git=CANDIDATE/'core/bin/git/cmd/git.exe';repo_states=[]
for key,name,count,expected in [('U07-10','repo-author',2,''),('U07-12','repo-no-author',1,' M notes.txt'),('U07-14','repo-conflict',2,'UU notes.txt')]:
    rp=copy/idx[key]/name
    def run(*args):return subprocess.check_output([str(git),'-C',str(rp),*args],encoding='utf8')
    status=run('status','--porcelain').rstrip('\r\n');assert status==expected,repr(status)
    assert int(run('rev-list','--count','HEAD'))==count and not run('remote','-v').strip()
    repo_states.append({'name':name,'commits':count,'status':status,'remotes':0})
assert hashes(ROOT)==before,'Delivery originals were mutated during copied validation'
setup=REPO/'dist/t82-candidate-test.3/Velopack/DreamFlutter-win-x64-Setup.exe'
setup_sha=sha(setup);assert setup_sha=='d89c53af8aa1acdb761cf44996ce409cd22bc964ba1d392fca4f7882ac5214b6'
baseline=json.loads((REPO/'Claude Codex Bridge/T82-source-freeze.json').read_text('utf8'))
changed=[entry['path'] for entry in baseline['files'] if not (REPO/entry['path']).is_file() or sha(REPO/entry['path'])!=entry['sha256']]
assert changed==['docs/testing/v0.7-user-checklist.md'],changed
head=subprocess.check_output([str(git),'-C',str(REPO),'rev-parse','HEAD'],encoding='utf8').strip();assert head==baseline['head']
render=QA/'visual';render.mkdir()
sources=[(copy/idx['U07-18']/'普通文字A.pdf',1,'text-pdf'),(copy/idx['U07-22']/'扫描件.pdf',1,'scan-pdf'),(QA/'converted/docx.pdf',1,'word-pdf'),(QA/'converted-r2/xlsx.pdf',1,'excel-pdf'),(QA/'converted-r2/pptx.pdf',2,'ppt-pdf')]
shots=[]
for pdf,page,label in sources:
    prefix=render/label
    subprocess.run(['pdftoppm','-f',str(page),'-l',str(page),'-scale-to','1050','-singlefile','-png',str(pdf),str(prefix)],check=True,capture_output=True)
    shots.append((label,Image.open(prefix.with_suffix('.png')).convert('RGB')))
shots.append(('chinese-chart',Image.open(copy/idx['U07-19']/'参考中文图.png').convert('RGB')))
sheet=Image.new('RGB',(1800,1460),'#dddddd');draw=ImageDraw.Draw(sheet)
for i,(label,img) in enumerate(shots):
    x=(i%3)*600;y=(i//3)*730;draw.text((x+12,y+8),label,fill='black');thumb=ImageOps.contain(img,(580,685));sheet.paste(thumb,(x+(600-thumb.width)//2,y+32))
sheet.save(render/'contact.png')
proof={'pass':True,'at':'2026-11-09','folders':32,'filesBeforeManifest':len(before),'markdownLinks':len(links),'copyHashesMatch':True,'originalsUnchanged':True,'gitRepositories':repo_states,'setupSha256':setup_sha,'frozenFiles':len(baseline['files']),'authorizedSourceDifferences':changed,'head':head,'paidModelCalls':0,'modelPrompts':0,'visualContact':str(render/'contact.png')}
(QA/'audit-results.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2),encoding='utf8')
(REPO/'Claude Codex Bridge/T82-materials-audit.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(proof,ensure_ascii=True))
