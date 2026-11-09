"""Tie the tested formal payload and this task's source assets to the shipped ZIP."""
import hashlib,json,pathlib,sys,zipfile
repo=pathlib.Path(__file__).resolve().parent.parent
root=pathlib.Path(sys.argv[1]).resolve();payload=root/'DreamFlutter';release=root/'Velopack'
baseline=pathlib.Path(sys.argv[2]).resolve() if len(sys.argv)>2 else None
names=['office-docx','office-xlsx','office-pptx','office-pdf','data-analysis']
sources=[p for name in names for p in (repo/'core/assets/skills'/name).rglob('*') if p.is_file()]+[p for p in (repo/'core/assets/office').rglob('*') if p.is_file()]
def digest(path):
 h=hashlib.sha256()
 with path.open('rb') as stream:
  for chunk in iter(lambda:stream.read(1024*1024),b''):h.update(chunk)
 return h.hexdigest()
proof={'payload':str(payload),'assets':[],'artifacts':[]}
with zipfile.ZipFile(release/'DreamFlutter-win-x64-Portable.zip') as archive:
 proof['portableUncompressedBytes']=sum(entry.file_size for entry in archive.infolist() if not entry.is_dir())
 proof['portableFiles']=sum(not entry.is_dir() for entry in archive.infolist())
 critical=[p for p in (payload/'core/src').rglob('*') if p.is_file()]+[payload/'runtime/node.exe',payload/'core/python/cpython-3.13.18-windows-x86_64-none/python.exe']
 for file in critical:
  rel=file.relative_to(payload).as_posix();assert hashlib.sha256(archive.read('current/'+rel)).hexdigest()==digest(file),rel
 proof['testedCoreAndExecutablesMatchPortable']=len(critical)
 if baseline:
  compared=critical+[payload/p.relative_to(repo) for p in sources]
  proof['previousTestedPayloadChanges']=[p.relative_to(payload).as_posix() for p in compared if not (baseline/p.relative_to(payload)).is_file() or digest(p)!=digest(baseline/p.relative_to(payload))]
 for source in sorted(sources):
  rel=source.relative_to(repo).as_posix();expected=digest(source);packed=payload/rel
  member='current/'+rel;assert digest(packed)==expected
  assert hashlib.sha256(archive.read(member)).hexdigest()==expected,member
  proof['assets'].append({'path':rel,'bytes':source.stat().st_size,'sha256':expected})
for file in sorted(release.iterdir()):
 if file.suffix in ('.exe','.zip','.nupkg'):proof['artifacts'].append({'path':str(file),'bytes':file.stat().st_size,'sha256':digest(file)})
files=[p for p in payload.rglob('*') if p.is_file()]
proof.update(pass_=True,testedPayloadBytes=sum(p.stat().st_size for p in files),testedPayloadFiles=len(files),ownAssetBytes=sum(p.stat().st_size for p in sources))
proof['pass']=proof.pop('pass_')
print(json.dumps(proof,ensure_ascii=True,indent=2))
