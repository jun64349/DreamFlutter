"""Consolidate counted real runs without discarding failed attempts or charging a continuation twice."""
import json,pathlib,subprocess,sys
repo=pathlib.Path(__file__).resolve().parent.parent;bridge=repo/'Claude Codex Bridge'
names=['T78-live-final.json','T78-live-supplement.json','T78-live-data-resume.json','T78-live-pdf-fixed.json','T78-live-unsupported-explicit.json']
runs=[json.loads((bridge/name).read_text(encoding='utf8')) for name in names]
selected={row['id']:{'evidence':name,**row} for name,run in zip(names,runs) for row in run['cases'] if row['pass']}
assert set(selected)=={'docx','xlsx','pptx','pdf','data','unsupported','sandbox-office'}
assert all(run['sourceReadOnly'] and run['newChannels']==0 for run in runs)
for key in ('docx','xlsx','pptx','pdf','data'):
 subprocess.run([sys.executable,'-I','-B',str(repo/'scripts/t78-verify-products.py'),key,selected[key]['cwd']],check=True,stdout=subprocess.PIPE)
assert not any(tool['name'] in ('pwsh','bash','write','edit') for tool in selected['unsupported']['tools'])
assert all(any(tool['name']=='skill' and tool['result'].get('details',{}).get('name')==name for tool in selected['unsupported']['tools']) for name in ('office-pdf','office-xlsx'))
chart=pathlib.Path(selected['data']['cwd'])/'chart.png'
proof={'pass':True,'model':runs[0]['model'],'sourceReadOnly':True,'newChannels':0,'physicalRequests':sum(run['physicalRequests'] for run in runs),'costUsd':sum(run['costUsd'] for run in runs),'cases':{key:{'evidence':row['evidence'],'cwd':row['cwd'],'pass':row['pass']} for key,row in selected.items()},'failedAttempts':[{'evidence':name,'case':row['id'],'error':row.get('error')} for name,run in zip(names,runs) for row in run['cases'] if not row['pass']],'chart':str(chart),'runtimeReopenCheck':sys.executable}
proof['priorAnswerRejectedOnReview']={'evidence':'T78-live-supplement.json','case':'unsupported','reason':'The old boundary-only check passed, but natural-language multi-skill routing hid office-xlsx and the answer wrongly claimed it was absent. Superseded by the explicit-name run; cross-task issue R78-01 remains recorded.'}
assert proof['costUsd']<.25 and proof['physicalRequests']<=60
print(json.dumps(proof,ensure_ascii=True,indent=2))
