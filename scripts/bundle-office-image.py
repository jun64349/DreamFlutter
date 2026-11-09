"""Offline deterministic office layer on a pinned Debian image; all WSL writes live in one disposable /tmp tree."""
import argparse, pathlib, json, hashlib, subprocess, tarfile, io, gzip, math, zlib, shutil, uuid, os
ROOT=pathlib.Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser();parser.add_argument('--cache',required=True);parser.add_argument('--out',required=True);parser.add_argument('--distro',default='DreamFlutterSandbox');args=parser.parse_args()
cache=pathlib.Path(args.cache).resolve();out=pathlib.Path(args.out).resolve();lock_file=ROOT/'core/bundled-runtime.lock.json';lock=json.loads(lock_file.read_text(encoding='utf8'));lock_hash=hashlib.sha256(lock_file.read_bytes()).hexdigest()
def digest(path):
 with pathlib.Path(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
base=cache/lock['baseImage']['file']
if not base.exists():
 candidate=ROOT/'core/sandbox-image/dreamflutter-sandbox.tar.gz'
 if digest(candidate)!=lock['baseImage']['sha256']:raise RuntimeError('Pinned base image is missing from cache; restore the exact baseline image, never rebuild from latest packages silently')
 shutil.copyfile(candidate,base)
assert digest(base)==lock['baseImage']['sha256'],'Pinned base image SHA-256 mismatch'
for entry in lock['linux']:assert digest(cache/entry['file'])==entry['sha256'],entry['file']
remote='/tmp/dreamflutter-t75-image-'+str(uuid.uuid4());image=remote+'/root';overlay=cache/('office-layer-'+str(uuid.uuid4())+'.tar')
def wsl(code,stdin=None):
 stream={'input':stdin.getvalue()} if isinstance(stdin,io.BytesIO) else {'stdin':stdin}
 p=subprocess.run(['wsl.exe','-d',args.distro,'-u','root','--exec','python3','-B','-c',code],**stream,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=600)
 if p.returncode:raise RuntimeError(p.stderr.decode('utf8',errors='replace')+'\n'+p.stdout.decode('utf8',errors='replace'))
 return p.stdout
try:
 print('Extracting pinned base in disposable WSL tree',flush=True)
 code=f"import pathlib,tarfile,sys; p=pathlib.Path({image!r}); assert str(p).startswith('/tmp/dreamflutter-t75-image-');p.mkdir(parents=True);tarfile.open(fileobj=sys.stdin.buffer,mode='r|gz').extractall(p,filter='fully_trusted')"
 with base.open('rb') as f:wsl(code,f)
 payload=io.BytesIO()
 with tarfile.open(fileobj=payload,mode='w') as tar:
  for entry in lock['linux']:tar.add(cache/entry['file'],arcname=entry['file'])
  tar.add(ROOT/'core/office-linux.requirements.txt',arcname='requirements.txt')
 payload.seek(0);wsl(f"import pathlib,tarfile,sys;p=pathlib.Path({image+'/tmp/t75-wheels'!r});p.mkdir();tarfile.open(fileobj=sys.stdin.buffer,mode='r|').extractall(p,filter='data')",payload)
 setup=f'''import pathlib,subprocess,json,sys,os
p=pathlib.Path({image!r})
subprocess.run(['chroot',str(p),'/usr/bin/python3','-B','-m','pip','--isolated','install','--disable-pip-version-check','--no-index','--no-deps','--no-compile','--require-hashes','--target','/opt/dreamflutter/office','--find-links','/tmp/t75-wheels','-r','/tmp/t75-wheels/requirements.txt'],check=True)
site=p/'usr/local/lib/python3.13/dist-packages';site.mkdir(parents=True,exist_ok=True);(site/'dreamflutter-office.pth').write_text('/opt/dreamflutter/office\\n')
meta={{'schema':1,'lockSha256':{lock_hash!r},'added':{ {e['name']:e['version'] for e in lock['linux']}!r},'reused':{lock['linuxReuse']!r}}}
(p/'usr/share/dreamflutter/office-libraries.json').write_text(json.dumps(meta,sort_keys=True,indent=2)+'\\n')
probe="import importlib.metadata as m,json,docx,pptx,pypdf,pandas,matplotlib,openpyxl;print(json.dumps({{n:m.version(n) for n in ['python-docx','python-pptx','pypdf','typing-extensions','xlsxwriter','numpy','pandas','matplotlib','openpyxl','lxml','pillow']}}))"
r=subprocess.run(['chroot',str(p),'/usr/bin/python3','-I','-B','-c',probe],check=True,stdout=subprocess.PIPE,text=True);versions=json.loads(r.stdout)
for n,v in {{**meta['added'],**meta['reused']}}.items():assert versions[n]==v,(n,versions[n],v)
print(json.dumps({{'versions':versions}}))
'''
 print(wsl(setup).decode('utf8'),flush=True)
 exporter=f'''import pathlib,tarfile,sys
p=pathlib.Path({image!r});paths=[p/'opt/dreamflutter/office',p/'usr/local/lib/python3.13/dist-packages/dreamflutter-office.pth',p/'usr/share/dreamflutter/office-libraries.json']
with tarfile.open(fileobj=sys.stdout.buffer,mode='w|') as tar:
 for path in paths:
  for file in sorted(path.rglob('*')) if path.is_dir() else [path]:
   if file.is_file() and '__pycache__' not in file.parts:
    info=tar.gettarinfo(str(file),arcname=str(file.relative_to(p)));info.uid=info.gid=0;info.uname=info.gname='';info.mtime=0;info.mode=0o755 if file.stat().st_mode&0o111 else 0o644
    with file.open('rb') as data:tar.addfile(info,data)
'''
 raw=wsl(exporter);overlay.write_bytes(raw)
 end=0
 with tarfile.open(base,'r:gz') as tar:
  for member in tar:end=max(end,member.offset_data+math.ceil(member.size/512)*512)
 def ending(length):return b'\0'*(1024+(-(length+1024)%10240))
 compressor=zlib.compressobj(6,zlib.DEFLATED,31);prefix=cache/'sandbox-normalized-prefix.gzpart'
 with gzip.open(base,'rb') as source,prefix.open('wb') as dest:
  left=end
  while left:
   chunk=source.read(min(left,4*1024*1024));assert chunk;left-=len(chunk);dest.write(compressor.compress(chunk))
 c=compressor.copy();control=prefix.stat().st_size+len(c.compress(ending(end))+c.flush())
 overlay_end=0;added_bytes=0;added_files=0
 with tarfile.open(overlay,'r:') as tar:
  for member in tar:overlay_end=max(overlay_end,member.offset_data+math.ceil(member.size/512)*512);added_bytes+=member.size;added_files+=member.isfile()
 out.parent.mkdir(parents=True,exist_ok=True);candidate=out.with_name(out.name+'.t75-new')
 with candidate.open('wb') as dest,prefix.open('rb') as source:
  shutil.copyfileobj(source,dest);dest.write(compressor.compress(raw[:overlay_end]));dest.write(compressor.compress(ending(end+overlay_end)));dest.write(compressor.flush())
 delta=candidate.stat().st_size-control
 proof={'baseSha256':digest(base),'lockSha256':lock_hash,'normalizedBaseGzipBytes':control,'bytes':candidate.stat().st_size,'deltaGzipBytes':delta,'addedBytes':added_bytes,'addedFiles':added_files,'sha256':digest(candidate),'compression':'zlib gzip level 6; identical base prefix and canonical tar ending','reuse':lock['linuxReuse']}
 if delta>1228208*1.2:raise RuntimeError('T75 PAUSE: formal office image gzip growth exceeds R3 by 20%: '+json.dumps(proof))
 # Publish only after all hashes, imports and the task growth gate passed.
 os.replace(candidate,out)
 sidecar=out.with_name(out.name.removesuffix('.tar.gz')+'.json');old=json.loads((ROOT/'core/sandbox-image/dreamflutter-sandbox.json').read_text(encoding='utf8'))
 old.update(file=out.name,sha256=proof['sha256'],bytes=proof['bytes'],officeLayer=proof)
 sidecar.write_text(json.dumps(old,indent=2)+'\n');shutil.copyfile(ROOT/'core/sandbox-image/dreamflutter-sandbox.packages.txt',out.with_name(out.name.removesuffix('.tar.gz')+'.packages.txt')) if out.parent!=ROOT/'core/sandbox-image' else None
 (out.parent/'office-layer.json').write_text(json.dumps(proof,indent=2)+'\n');print(json.dumps(proof),flush=True)
finally:
 cleanup=f"import pathlib,shutil;p=pathlib.Path({remote!r}).resolve();assert p.parent==pathlib.Path('/tmp') and p.name.startswith('dreamflutter-t75-image-');shutil.rmtree(p) if p.exists() else None"
 wsl(cleanup)
 if overlay.parent==cache and overlay.name.startswith('office-layer-'):overlay.unlink(missing_ok=True)
