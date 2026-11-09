import pathlib,sys,zipfile,stat,json
source=pathlib.Path(sys.argv[1]).resolve();dest=pathlib.Path(sys.argv[2]).resolve();dest.mkdir(parents=True,exist_ok=True);count=0;empty=0
with zipfile.ZipFile(source) as archive:
 for entry in archive.infolist():
  name=entry.filename.replace('\\','/')
  if not name.strip('/'):
   assert entry.file_size==0;empty+=1;continue
  target=(dest/name).resolve();assert target.is_relative_to(dest),'ZIP path escapes output'
  assert not stat.S_ISLNK(entry.external_attr>>16),'Unexpected archive symlink'
  if entry.is_dir():target.mkdir(parents=True,exist_ok=True)
  else:
   target.parent.mkdir(parents=True,exist_ok=True)
   with archive.open(entry) as data,target.open('wb') as output:
    import shutil;shutil.copyfileobj(data,output)
   count+=1
print(json.dumps({'files':count,'emptyRootEntriesSkipped':empty,'output':str(dest)}))
