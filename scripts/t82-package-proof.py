"""Validate a candidate against the joint freeze and measure the untouched delivery cohort."""
import hashlib,json,pathlib,sys,zipfile
repo=pathlib.Path(__file__).resolve().parent.parent;root=pathlib.Path(sys.argv[1]).resolve();evidence=pathlib.Path(sys.argv[2]);stage=root/'DreamFlutter';release=root/'Velopack'
def digest(path):
 h=hashlib.sha256()
 with path.open('rb') as stream:
  for block in iter(lambda:stream.read(1024*1024),b''):h.update(block)
 return h.hexdigest()
freeze=json.loads((repo/'Claude Codex Bridge/T82-source-freeze.json').read_text(encoding='utf8'))
proof={'version':'0.7.0-test.3','frozenTree':freeze['treeSha256'],'sourceFiles':[],'artifacts':[],'pass':False}
with zipfile.ZipFile(release/'DreamFlutter-win-x64-Portable.zip') as z:
 for item in freeze['files']:
  name=item['path']
  if not (name.startswith('core/src/') or name.startswith('core/assets/') or name in ('core/package.json','core/package-lock.json')):continue
  assert digest(stage/name)==item['sha256'],name
  assert hashlib.sha256(z.read('current/'+name)).hexdigest()==item['sha256'],name
  proof['sourceFiles'].append(name)
 proof['portableUncompressedBytes']=sum(x.file_size for x in z.infolist() if not x.is_dir());proof['portableFiles']=sum(not x.is_dir() for x in z.infolist())
 for name in ('runtime/node.exe','core/python/cpython-3.13.18-windows-x86_64-none/python.exe','core/bin/git/cmd/git.exe'):
  assert hashlib.sha256(z.read('current/'+name)).hexdigest()==digest(stage/name),name
for path in sorted(release.iterdir()):
 if path.suffix in ('.exe','.zip','.nupkg'):proof['artifacts'].append({'path':str(path),'bytes':path.stat().st_size,'sha256':digest(path)})
proof['pass']=True;evidence.write_text(json.dumps(proof,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps({'pass':True,'frozenFiles':len(proof['sourceFiles']),'artifacts':proof['artifacts']},ensure_ascii=True))
