"""Finalize owned material instructions, offline report reference and portable verification evidence."""
import hashlib,json,pathlib,re,shutil,subprocess,sys
REPO=pathlib.Path(__file__).resolve().parent.parent;ROOT=pathlib.Path(r'E:\DreamFlutter实测材料\v0.7');QA=REPO/'dist/t82-materials-qa';CANDIDATE=REPO/'dist/t82-unpacked/current'
idx=json.loads((ROOT/'材料索引.json').read_text('utf8'));f=lambda k:ROOT/idx[k]
def write(path,text):path.write_text(text.strip()+'\n',encoding='utf8')

# Correct literal UI labels from the candidate source; params are one per line, never shell-split.
for path in [ROOT/'先看我.md',f('U07-07')/'应用里怎么填.md']:
    text=path.read_text('utf8').replace('技能库 → MCP → 新建/编辑服务','设置 → MCP → 添加服务（或编辑已有服务）')
    old='参数界面若是一行文本，用双引号包住脚本路径，例如 `"'+str(f('U07-07')/'readonly-mcp.mjs')+'" A`；如果是参数数组则分别填两项，不额外加引号。'
    text=text.replace(old,'设置里的“参数（每行一个）”分两行填写：第一行是脚本绝对路径，第二行是 A。不要加双引号，不要把两项合成一行。JSON 中 args 则是两个字符串的数组。')
    write(path,text)

# There is no separate revoke-trust UI button in test.3. Give achievable remove/reimport steps, not a fictional button.
revoke='''# U07-09 撤销可用性与重新确认

test.3没有单独名叫“撤销信任”的按钮，不能把停用开关当作清除了信任。请只操作下面的测试条目。

1. 技能库→技能，删除 u07-community-demo（产品会把用户技能放进自己的trash，可找回）。再从U07-05原件导入同一技能，这次不接受待确认。此时应显示未信任且停用。
2. 先在技能库→MCP关闭A的“允许蝶君使用”，再到设置→MCP删除 v07-readonly-a。请助手按U07-07原配置重新登记A，保留待确认、不接受。删除后的旧连接不能继续调用；新建议不能自动生效。
3. 退出并重启同一个测试配置，再点名使用技能和服务A，应被拒绝或明确尚未确认，不能说成功。A/B是不同身份，B原来的状态应保持。
4. 重新授信须重新审阅并接受，且再次给蝶君授权是独立步骤。若改动已导入的技能文件，指纹变化也应触发重新确认；本轮不要改原始材料。

交付侧还在隔离配置里直接验证了内部撤信任状态的持久化与备份准备，不等于代做了你的界面操作。'''
write(f('U07-09')/'操作与预期.md',revoke)
text=(ROOT/'先看我.md').read_text('utf8')
start=text.index('## U07-09 ');end=text.index('## U07-10 ',start)
text=text[:start]+'## U07-09 撤信任\n\n目录：['+idx['U07-09']+'/操作与预期.md]('+idx['U07-09']+'/操作与预期.md)。test.3没有独立“撤销信任”按钮；按该说明删除并重新导入测试技能、删除并重新登记测试MCP，保留待确认，然后重启核对仍不可用。不要用停用冒充撤信任。\n\n'+text[end:]
isolation='''## 独立测试配置怎么开

不要直接用日常数据做备份恢复。可把便携候选解压到自己的新目录，然后用下面方法指定专用数据，A与B分别用于备份前/恢复后；不复制自己的账号或密钥。先保存并退出同一个候选进程。

打开PowerShell，把最后一行改成你候选的真实exe路径（不是Setup），运行：

```powershell
$env:DREAMFLUTTER_DATA = 'E:\\DreamFlutter实测数据\\v0.7\\A'
& 'E:\\claude\\DreamFlutter\\dist\\t82-unpacked\\current\\app\\dreamflutter.exe'
```

这是已存在的候选解包路径示例；若你自己解压/安装，换成那个current\\app目录里的dreamflutter.exe。这个环境变量只影响当前终端启动的程序，不是永久系统设置。做恢复时，保存并退出A，在另一个PowerShell把A改成B再启动候选；B首次应是空测试配置，再导入A的备份。不要把A/B指向个人数据或材料原件目录。新的蝶君名称由各自数据目录生成，不重置旧蝶君。

设置→“备份与恢复”→“导出备份…”/“导入备份…”；导入先“检查并准备”，再按界面确认恢复。设置→“数据与存储”中的“数据位置”是分项搬迁，不是一个选择整份配置的按钮。

'''
text=text.replace('## U07-01 ',isolation+'## U07-01 ',1)
write(ROOT/'先看我.md',text)
backup='''# U07-27 备份恢复（只用独立A/B配置）

先按根目录“先看我”的“独立测试配置怎么开”启动A。A与B都是专用测试目录，禁止指向个人数据。

1. A中保存测试记忆.txt里的句子，重启A后问项目代号，应为纸鹤79；若模型保存失败如实记录。也可在记忆管理页手工保存，记录使用了哪种方式。
2. 保留一条待确认建议。先完成U07-09：测试技能重新导入后不确认，MCP A撤蝶君授权、删除并重新登记后不接受。记录待确认和权限状态；停用不等于撤信任。
3. 设置→“备份与恢复”→“导出备份…”，存到自己新建的备份目录。不勾“包含API Key”；本例无需沙箱文件，可不勾。保留导出的.dfbackup，记录实际文件名。
4. 保存并退出A。按“先看我”改用新的空B数据目录启动同一候选。B中设置→“备份与恢复”→“导入备份…”，选择第3步文件，先检查内容和替换范围，点“检查并准备”，再按界面确认恢复。此操作只替换B，A原目录保留。
5. 核对纸鹤79、待确认、技能未信任；MCP A的新建议仍未接受，不得因恢复自动可用。缺少密钥应提示重填。大小写身份冲突必须明确提示、保持不可信，不能自动合并历史。
6. 记录实际版本、文件名、看到的状态。交付自验验证了隔离数据导出、检查、在新位置准备及准备后数据库的记忆/撤权状态，没有替你确认UI恢复，也没有生成个人备份。'''
write(f('U07-27')/'备份恢复步骤.md',backup)
op=(f('U07-27')/'操作与预期.md').read_text('utf8').replace('先验证备份，再在另一个新的测试数据位置恢复。','先验证备份，再按“备份恢复步骤.md”用独立B配置恢复；不要在数据位置界面寻找不存在的整份配置切换按钮。')
write(f('U07-27')/'操作与预期.md',op)

report={'title':'测试周报：两项完成，一项待确认','period':'2026-11-02 至 2026-11-08','theme':'press','subtitle':'合成验收数据，非真实业绩','summary':['整理物料清单、核对三笔销售均已完成。','销售总6件79元；演示安排仍待确认。'],'achievements':[{'title':'整理物料清单','detail':'测试记录显示已完成。','evidence':'本周记录.md'},{'title':'核对三笔销售','detail':'茶杯25、记事本24、帆布袋30，合计79元。','evidence':'销售.csv'}],'metrics':[{'name':'完成','value':'2项','numericValue':2,'unit':'项','note':'本周记录.md'},{'name':'待确认','value':'1项','numericValue':1,'unit':'项','note':'演示安排，包括展示顺序、现场设备检查、备用资料准备和问题记录整理，这是一条必须在窄窗口完整换行显示的长说明。'},{'name':'销售金额','value':'79元','numericValue':79,'unit':'元','note':'销售.csv三行数量乘单价相加，合计6件，无税费推断。'}],'risks':[{'title':'演示日期未确定','detail':'负责人和发布日期未提供，不能编造已确认时间。','owner':'待确认','action':'确认安排'}],'nextWeek':[{'task':'演示安排','owner':'待确认','due':'待确认'}],'sources':['本周记录.md（2026-11-02至2026-11-08，合成数据）','销售.csv（3行，数量×单价总79元）'],'missing':['演示负责人','发布日期'],'conclusion':'先确认演示安排，再更新周报。'}
write(f('U07-25')/'参考输入.json',json.dumps(report,ensure_ascii=False,indent=2))
render=CANDIDATE/'core/assets/skills/showcard-pro/scripts/render-report.mjs'
out=f('U07-25')/'参考周报.html'
if not out.exists():subprocess.run([str(CANDIDATE/'runtime/node.exe'),str(render),'--input',str(f('U07-25')/'参考输入.json'),'--out',str(out)],check=True,capture_output=True)
html=out.read_text('utf8');assert '79' in html and '待确认' in html and 'default-src' in html
assert not re.search(r'<script\b|<(?:img|link|iframe)[^>]+(?:src|href)=["\']https?://',html,re.I)
for key,expected in [('U07-10',('repo-author',2,'')),('U07-12',('repo-no-author',1,' M notes.txt')),('U07-14',('repo-conflict',2,'UU notes.txt'))]:
    rp=f(key)/expected[0]
    # Validate archive content independently in its own new QA directory.
    import zipfile
    archive=rp.parent/(rp.name+'-初始快照.zip');dest=QA/('zip-check-'+rp.name)
    with zipfile.ZipFile(archive) as z:assert z.testzip() is None;assert any('/.git/HEAD' in name for name in z.namelist());z.extractall(dest)
    for p in rp.rglob('*'):
        if p.is_file():assert hashlib.sha256(p.read_bytes()).digest()==hashlib.sha256((dest/p.relative_to(rp.parent)).read_bytes()).digest()

# Material-level no-model validation coverage. Interactive/paid/account tests remain unexecuted.
phase1=json.loads((QA/'api-results.json').read_text('utf8'));phase2=json.loads((QA/'finish-results.json').read_text('utf8'));office=json.loads((QA/'office-results-r2.json').read_text('utf8'))
assert len(phase1['tests'])==14 and all(t['pass'] for t in phase1['tests'])
assert phase2['pass'] and office['pass'] and phase1['gatewayAttempts']==phase2['gatewayAttempts']==0
for name in ['api-results.json','finish-results.json','office-results.json','office-results-r2.json']:
    target=ROOT/'验证证据';target.mkdir(exist_ok=True);shutil.copyfile(QA/name,target/name)
proof={'candidate':'0.7.0-test.3','modelPrompts':0,'paidModelCalls':0,'gatewayAttempts':0,'pass':True,'phase1Checks':len(phase1['tests']),'finishChecks':len(phase2['tests']),'officeFinalChecks':len(office['tests']),'folders':32,'zipArchives':3,'offlineShowcard':True,'userUiAcceptance':'not-run','harnessCorrections':['Node recursive cp on this runtime stopped before Core creation; fixture copy changed to recursive read/write matching product import','revocation locator normalized using exported locator()','backup QA supplied RestoreTarget appVersion/paths and StageOptions.parts; null job handled','Excel fixture print area fit to one page; genuine XLS regenerated, original failure retained']}
write(ROOT/'验证证据/汇总.json',json.dumps(proof,ensure_ascii=False,indent=2))
lines=['# 交付材料自验结果','2026-11-09；候选0.7.0-test.3；模型请求0，付费模型费用US$0。全部为合成材料和隔离测试数据。',f'- 技能/MCP第一阶段 {len(phase1["tests"])} 项：3个技能实际导入且未信任/停用；静态检查不执行；蝶君成功脚本exit0且产物total79；故意失败exit7；A/B通过实际MCP SDK握手/列工具以及stdio只读调用；A/B单独授权；坏协议/缺命令负例；两种非法UNC数据库路径不搬迁、不重启。',f'- 收尾隔离验证 {len(phase2["tests"])} 项：重启后测试记忆与撤权；合成备份导出/检查/新位置准备及准备后数据库；三个Git副本状态、建切分支、revert/恢复点恢复、缺身份、冲突保护；独立Linux发行版实际返回无Office程序。',f'- 办公最终 {len(office["tests"])} 项，另引用初轮已过的Word转换：CSV、XLSX公式与空缓存、DOCX正文表格图像、PPTX三页表格图像、PDF3页顺序/拆分第2页/中文提取、扫描件图像层与无文本层；真实DOC/XLS/PPT文件头验证并转新格式/PDF。', '- 三个Git初始ZIP独立解压，逐文件校验与交付原件一致，含.git，无远端。缺身份仓库的本地空身份已验证能屏蔽全局作者。', '- showcard-pro用候选自带Node和已打包renderer离线生成参考完整HTML及card，无网络资源/脚本；源CSV人工和程序校验总79。', '- 每份编号说明/输入/预期齐全。只有原料自验，未代做用户真实模型回答、信任弹窗、安装/升级、真实账号、显示缩放等UI验收。', '- 验证只使用新的API数据目录、Git/技能/办公副本和专用发行版df-t82-materials-20261109。已只停止该测试发行版，注册/磁盘保留；未全局关闭WSL、未改旧蝶君、未安装候选。', '- 如实保留辅助失败：初轮Excel横向分页过多，修正仅测试工作簿；Node测试复制、撤权locator和备份API参数等为验收辅助问题，见汇总与原始证据。产品源码/候选未修改。']
write(ROOT/'自验结果.md','\n\n'.join(lines))
print(json.dumps(proof,ensure_ascii=True))
