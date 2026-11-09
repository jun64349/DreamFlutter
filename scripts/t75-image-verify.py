"""Run the formal shipped image's default Python as its ordinary agent in a disposable chroot."""
import sys,pathlib,json,subprocess,uuid,io,tarfile
image=pathlib.Path(sys.argv[1]).resolve();out=pathlib.Path(sys.argv[2]).resolve();out.mkdir(parents=True,exist_ok=True)
remote='/tmp/dreamflutter-t75-verify-'+str(uuid.uuid4());root=remote+'/root';distro='DreamFlutterSandbox'
def wsl(code,source=None):
 stream={'input':source.getvalue()} if isinstance(source,io.BytesIO) else {'stdin':source}
 p=subprocess.run(['wsl.exe','-d',distro,'-u','root','--exec','python3','-B','-c',code],**stream,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=300)
 if p.returncode:raise RuntimeError(p.stderr.decode(errors='replace')+p.stdout.decode(errors='replace'))
 return p.stdout
try:
 with image.open('rb') as source:wsl(f"import pathlib,tarfile,sys;p=pathlib.Path({root!r});p.mkdir(parents=True);tarfile.open(fileobj=sys.stdin.buffer,mode='r|gz').extractall(p,filter='fully_trusted')",source)
 smoke=(pathlib.Path(__file__).parent/'t75-office-smoke.py').read_text(encoding='utf8')
 code=f'''import pathlib,subprocess,os,json
p=pathlib.Path({root!r});run=p/'tmp/t75-smoke';run.mkdir();script=run/'smoke.py';script.write_text({smoke!r})
uid=int(next(line for line in (p/'etc/passwd').read_text().splitlines() if line.startswith('agent:')).split(':')[2])
for item in [run,script]:os.chown(item,uid,uid)
r=subprocess.run(['chroot','--userspec='+str(uid)+':'+str(uid),str(p),'/usr/bin/python3','-I','-B','/tmp/t75-smoke/smoke.py','/tmp/t75-smoke/output'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
print(r.stdout,end='');print(r.stderr,file=__import__('sys').stderr,end='');assert r.returncode==0
v=subprocess.run(['chroot','--userspec='+str(uid)+':'+str(uid),str(p),'git','--version'],check=True,stdout=subprocess.PIPE,text=True).stdout.strip()
print(json.dumps({{'uid':uid,'git':v}}))
'''
 output=wsl(code).decode('utf8');(out/'image-smoke.log').write_text(output,encoding='utf8');print(output,flush=True)
 for name in ['office-results.json','chinese-chart.png']:
  data=wsl(f"import pathlib,sys;sys.stdout.buffer.write(pathlib.Path({root+'/tmp/t75-smoke/output/'+name!r}).read_bytes())");(out/name).write_bytes(data)
finally:
 wsl(f"import pathlib,shutil;p=pathlib.Path({remote!r}).resolve();assert p.parent==pathlib.Path('/tmp') and p.name.startswith('dreamflutter-t75-verify-');shutil.rmtree(p) if p.exists() else None")
