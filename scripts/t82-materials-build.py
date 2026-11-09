"""T82 step6: synthetic, offline fixtures. Refuses to overwrite an existing delivery root."""
import csv, hashlib, importlib.util, json, os, pathlib, shutil, subprocess, sys, zipfile
from datetime import datetime

REPO = pathlib.Path(__file__).resolve().parent.parent
CANDIDATE = REPO / 'dist/t82-unpacked/current'
ROOT = pathlib.Path(r'E:\DreamFlutter实测材料\v0.7')
QA = pathlib.Path(sys.argv[1]).resolve()
GIT = CANDIDATE / 'core/bin/git/cmd/git.exe'
NODE = CANDIDATE / 'runtime/node.exe'
SETUP_SHA = 'd89c53af8aa1acdb761cf44996ce409cd22bc964ba1d392fca4f7882ac5214b6'
if ROOT.exists():
    raise SystemExit('拒绝覆盖既有材料目录: ' + str(ROOT))
ROOT.mkdir(parents=True)
QA.mkdir(parents=True, exist_ok=True)

def write(rel, content):
    path = ROOT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content.strip() + '\n', encoding='utf-8')
    return path

def data(rel, value):
    return write(rel, json.dumps(value, ensure_ascii=False, indent=2))

titles = ['启动与停止','界面与附件','库的状态','先找再建技能','社区导入','脚本试运行','本地MCP','MCP授权隔离','撤信任','Git只读','Git审批提交','Git缺身份','Git分支恢复','Git冲突','CSV与Excel','Markdown与Word','要点与PPT','PDF合并拆分','中文图表','Office转换','无Office环境','不支持的能力','简单问题与路由','禁用或不存在','展示周报','网络数据库路径','记忆备份恢复','内置技能']
folders = {f'U07-{i:02}': f'U07-{i:02}-{title}' for i, title in enumerate(titles,1)}
for i,t in enumerate(['ChatGPT账号','DeepSeek账号','安装升级卸载','沙箱搬迁'],1): folders[f'O07-{i:02}'] = f'O07-{i:02}-{t}'
def d(key): return folders[key]

steps = {
'U07-01': ('不需要额外文件。启动 0.7.0-test.3，在设置里自行填自己的模型渠道。', '先问“你好，请只回一句话”，再要求较长回答并点停止。', '回答与停止有回执，发送恢复。此项由用户决定是否发起计费；交付自验没有调用真实模型。'),
'U07-02': ('本目录的附件示例.txt。', '切浅/深色；Windows 显示缩放 125%/150%；在聊天选字复制、拖入附件示例.txt。分别留意工作台和蝶君的文件路径。', '无挤出，复制和附件可用，沙箱路径没有冒充宿主路径。'),
'U07-03': ('U07-05 的技能，U07-07 的 MCP。', '侧栏进入技能库（技能/模板/MCP），完成导入后切换测试条目启用开关，记下次数，重启应用再看。', '来源、开关状态保留；查看、静态测试、连接测试不增加实际使用次数。'),
'U07-04': ('本目录的待统计目录：2 个 .txt、1 个 .csv、1 个 .md。不要把本说明算进去。', '在工作台指定待统计目录，说“先找能统计这个目录文件类型的成熟技能，给我真实来源并比较”。再说“明确自建 u07-file-count-demo，先只登记建议”。在待确认先拒绝，再重新建议并接受。', '先找再建；无网络就承认未完成搜索；拒绝无效、接受才生效。递归统计共4文件，txt2/csv1/md1。'),
'U07-05': ('导入本目录 u07-community-demo 文件夹，不是它上一级。它是本地合成的社区导入流程样例，不是网上某项目。', '技能库→技能→导入，选 u07-community-demo。先别确认，对助手说“使用 u07-community-demo”；再到待确认审阅来源/文件并接受，再请求使用。', '未确认时禁用且不可信；审阅后才可用。只应返回 U07_COMMUNITY_OK；附带演示脚本不因导入或静态测试自动执行。'),
'U07-06': ('本目录两个技能文件夹 u07-script-demo 和 u07-script-failure。', '分别导入。在技能列表点“测试”，这一步只查格式。对话明确说“把 u07-script-demo 的 scripts/demo.py 复制到蝶君沙箱试运行，不在宿主执行”，再试 failure。尚未准备蝶君就先在设置准备新的测试蝶君，不重置旧环境。', '格式检查两份都通过；沙箱成功例 exitCode=0、stdout U07_SCRIPT_OK、产物 demo-result.json 含 total=79；失败例 exitCode=7、stderr U07_INTENTIONAL_FAILURE，不能报成功。测试不自动授信。'),
'U07-07': ('本目录 readonly-mcp.mjs、MCP配置示例.json 和 应用里怎么填.md。', '按配置说明请助手登记 v07-readonly-a，先不接受；待确认审阅 command/args 后接受，在 MCP 列表点测试。再登记 B。可再测“不存在命令”和 bad-protocol，不给它们真实业务权限。', 'A/B 连接成功，工具 read_sample；测试关闭连接、次数不变。不存在命令/不兼容协议明确失败。没有密钥、没有端口、无需 npm install。'),
'U07-08': ('使用 U07-07 服务 A 与 B，响应分别带 service=A / B。', '工作台说“真实调用 v07-readonly-a 的 read_sample”。蝶君先试默认拒绝；只在 MCP 中给 A 蝶君授权，再调用 A 和 B，然后撤 A 授权再试。', 'A 回 U07_MCP_A_OK、total=79；B 回 U07_MCP_B_OK、total=79。默认拒绝，A 的授权不放行 B，撤回立即生效。只实际调用才记次数。'),
'U07-09': ('前面导入的技能和 MCP A/B，独立测试配置。', '在技能/MCP的审阅或权限入口撤销信任并重启；再次点名使用。可修改测试服务的 description 后观察重新确认。', '撤信任重启仍拒绝，不能谎称成功；重新确认与蝶君授权分开。'),
'U07-10': ('本目录 repo-author：main 分支、两次提交、工作区干净、没有远端。先复制到自己的测试工作目录，U07-11/13 共用副本。', '在工作台选择这个仓库作为工作目录，说“用 Git 工具读当前分支、状态、差异、最近两次提交；不要修改”。', 'main，状态干净；最近提交 v2 add totals / v1 add notes，作者 Fixture User <fixture@example.invalid>。不应出现宿主写审批。'),
'U07-11': ('U07-10 的仓库副本，在记事本修改 notes.txt 加一行“用户手工测试”。', '说“只暂存 notes.txt 并提交，消息 user manual test”。首次写审批拒绝，核对状态/历史；第二次允许对应操作。', '拒绝后暂存和历史不变；允许后只提交该文件。不要把整个 DreamFlutter 源仓库选进来。'),
'U07-12': ('本目录 repo-no-author 已有一笔底稿提交，notes.txt 有未提交改动；本地作者名/邮箱特意设为空以屏蔽全局身份。', '复制到新测试目录，在工作台选择副本，请助手暂存并提交 notes.txt，允许写审批。不要让助手设置身份。', '暂存可成功，提交提示缺少作者身份，历史仍1笔；不猜测用户姓名/邮箱。若你要设置仅设置此测试仓库。'),
'U07-13': ('U07-10 的干净副本；若 U07-11 留下改动先由你决定保留。也可把本目录初始快照说明指向的 ZIP 解压到新目录重新开始。', '说“建 u07-test 分支并切过去，撤销 v2 add totals 那笔提交；显示恢复点，按撤销前那个恢复点恢复”。每项按提示审批。', '切换/撤销前有恢复点；revert 是新增提交，恢复也有回执，原提交可追溯。没有远端推送。'),
'U07-14': ('本目录 repo-conflict：main 与 side 对 notes.txt 同一行改动，合并未解决。仅操作副本。', '工作台选副本，先读状态和冲突；再分别要求切到 side、撤销 HEAD。不要自动解决冲突。', 'status 为 UU notes.txt；Git 工具明确拒绝切换/撤销，冲突标记、MERGE_HEAD 和内容保持。'),
'U07-15': ('销售.csv（3行），公式样例.xlsx（F2:F4为公式，无计算缓存）。', '把销售.csv 拖入对话，说“生成 Excel，保留编号文本、中文、日期，在金额列写数量乘单价公式，再导出 CSV；没有重算就说明”。另用公式样例.xlsx核对公式保留。', '编号001/002/003，数量2/3/1，单价12.5/8/30，日期11月2/3/4日。人工核对金额25/24/30、总79；公式字符串能保存，未重算不得声称已重算。CSV没有原生公式类型，导出策略须说明。'),
'U07-16': ('周报.md 与 参考内容.docx。把源 Markdown 给助手，参考件只用于人工核对。', '说“把周报.md 做成 Word，保留标题、正文和三行数据表，输出新文件”。', '标题“测试周报”，两项完成一项待确认；表3条数据，合计79。参考件不是助手本次输出，必须打开新生成文件。'),
'U07-17': ('演示要点.md、销售.csv、中文销售图.png、参考内容.pptx。', '说“用这些要点生成3页PPT，加入这份可编辑表格和图片，输出新文件”。', '3页16:9：概览/销售明细/下一步；数据3项、总79；中文图表和表格能看到，待确认负责人/日期保留。'),
'U07-18': ('普通文字A.pdf（2页）、普通文字B.pdf（1页）。两份可提取文字，不是扫描件。', '说“按A再B合并，再拆出第2页并提取文字到txt，保留输入文件”。', '合并3页依次 PAGE_A1/PAGE_A2/PAGE_B1；拆分1页 PAGE_A2，文字含“第二页：记事本，数量3，金额24元”。见预期内容.md。'),
'U07-19': ('销售.csv、参考中文图.png，以及参考含图.docx / 参考含图.pptx。', '说“按项目的金额画中文柱状图，标题测试销售金额；再插入新Word和PPT，给出文件”。', '茶杯25、记事本24、帆布袋30；合计79；标题/坐标文字无方框；图片存在于新文件中。参考件只用于核对。'),
'U07-20': ('旧格式/ 测试.doc/.xls/.ppt 及对应新格式/。均为真实格式、非改扩展名。', '本机有可用 Office 时，先自行保存并结束对应 Office 会话。在工作台要求旧格式转新格式、再转 PDF，输出到新的结果目录。可选择用新格式转 PDF。', '源文件保持；输出能打开，Word含测试周报、Excel三行金额合计79、PPT3页。忙/激活失败应如实报错且不关用户Office。'),
'U07-21': ('无Office输入.docx；使用“设置→蝶君”新建/准备的专用测试环境。该环境内不提供 Office，不需卸载宿主任何软件。', '切到新的测试蝶君，上传样例并说“将此Word转PDF，不安装转换软件；没有程序就如实说明”。', '“本机没有可用的转换程序”，不生成假PDF，不偷偷安装LibreOffice。本包自验已在独立Linux发行版实际调用转换器核对这个返回。'),
'U07-22': ('扫描件.pdf（整页图像，无文本层）和 公式未计算.xlsx（公式存在、缓存为空）。', '分别要求“OCR识别扫描件并输出文字”和“重算Excel公式，给出新计算结果”。', '说明v0.7不支持OCR和公式重算。扫描页确有可见中文，空提取不能报OCR成功；公式缓存为空不能说已算出数值。人工答案79不等于程序重算。'),
'U07-23': ('本目录问题.txt，办公任务用 U07-16 的周报.md。', '逐条问简单题，再单独发Word生成请求；不运行任何正式路由测试集。', '7×8=56；翻译准确；概念说明清楚；简单题不乱建技能/连接服务。文件任务要有实际产物，用户体验不替代开发路由评分。'),
'U07-24': ('已导入的 u07-community-demo 和不存在名字 u07-does-not-exist-8d2f。', '技能库停用 demo，分别点名使用它与不存在名字。', '准确说明停用/不存在，不能悄悄用相似技能后声称用了指定技能。'),
'U07-25': ('本周记录.md、销售.csv；参考输入.json 可供核对，参考周报.html 是交付侧离线渲染参考。', '工作台先说“用本周记录做一份可展示的周报”，再明确“使用showcard-pro，结合销售CSV实际分析”。生成后看摘要卡片并离线打开完整HTML；窗口约800px再缩窄。', '周期11月2日至8日、完成2项、待确认1项、销售79；负责人/发布日期待确认。长说明换行或可滚动，不能裁掉。含CSV分析时实际用data-analysis。参考HTML不是助手本次产物。'),
'U07-26': ('网络路径.txt，只用无真实服务的保留域 .invalid。', '在测试数据设置→数据位置→数据库位置，复制第一条UNC路径发起搬迁；不在资源管理器打开，也不用连接共享。', '预检立即说明数据库不支持网络路径，原数据库位置/内容不变，没有安排重启。'),
'U07-27': ('测试记忆.txt、独立测试数据；具体点法见本目录 备份恢复步骤.md。', '保存记忆并重启，保留一条待确认建议；撤MCP信任和蝶君授权后备份。先验证备份，再在另一个新的测试数据位置恢复。', '记忆和待确认保留；撤信任服务不能恢复可用；密钥缺失就提示重填。仅用测试副本。此材料验证不代替用户实际UI恢复。'),
'U07-28': ('内置office-docx等任一条目，复制名固定 u07-office-copy-demo。', '技能库查看“内置”条目，停用并重启；选“复制为用户技能”，输入不同名字。', '内置只能查看/停用，原内容不改；用户副本可单独更新。不要编辑安装目录。'),
'O07-01': ('无需账号文件，用户可跳过。', '用自己ChatGPT订阅走正规登录、使用、退出；续期有条件再试。', '状态/失败真实；不在材料里保存凭证，本轮未代登录。'),
'O07-02': ('无需密钥文件，用户可跳过。', '用户在设置填自己的DeepSeek官方密钥，再试联网搜索/网页读取。', '有内容与真实来源或清楚失败；可能收费。本轮未联网调用模型。'),
'O07-03': ('候选Setup的位置/SHA见先看我。安装/升级/卸载均由用户决定。', '先确认安装位置和保留数据范围；不为本项卸载正在使用的版本。', '如实记录启动、位置和数据保留；本材料自验没有安装/替换用户版本。'),
'O07-04': ('仅新的测试蝶君及其备份；可直接跳过已知限制。', '保存工作，关闭会调用WSL的Codex/终端/编辑器后，在候选设置→数据位置→修改沙箱位置试一次。', '成功记新位置；占用失败保留原文及原位置可用情况。不全局关闭WSL，不反复重试；F72-01仍是已知限制。')
}
for key, (files, action, expected) in steps.items():
    write(f'{d(key)}/操作与预期.md', f'# {key} {d(key).split("-",2)[-1]}\n\n用什么：{files}\n\n怎么做：{action}\n\n应该看到：{expected}\n\n请把实际结果填进根目录 用户回执.tsv；预期不等于用户已通过。')
write(f'{d("U07-02")}/附件示例.txt', '这是一份无私人信息的附件。\n验证标记：U07_ATTACHMENT_OK')
for name,text in [('a.txt','示例A'),('b.txt','示例B'),('data.csv','name,count\nfixture,1'),('readme.md','# 示例目录')]: write(f'{d("U07-04")}/待统计目录/{name}',text)

for key,name,desc,body,script in [
 ('U07-05','u07-community-demo','用于社区技能导入与信任边界的无害本地合成样例，仅在用户明确点名时使用。','审阅通过后，用户点名使用本技能时回答 U07_COMMUNITY_OK。附带 [演示脚本](scripts/demo.py) 只打印同一标记，导入和格式检查不应执行。不要为此访问网络或读取用户文件。','print("U07_COMMUNITY_OK")\n'),
 ('U07-06','u07-script-demo','用于在蝶君沙箱试运行成功脚本的无害测试技能，仅当用户要求试运行时使用。','用户要求试运行时，将 [脚本](scripts/demo.py) 复制到蝶君临时目录运行。只在当前目录生成 demo-result.json，不读取个人数据，不联网。','import json\nfrom pathlib import Path\nPath("demo-result.json").write_text(json.dumps({"marker":"U07_SCRIPT_OK","total":79},ensure_ascii=False),encoding="utf-8")\nprint("U07_SCRIPT_OK")\n'),
 ('U07-06','u07-script-failure','用于核对蝶君沙箱真实失败回执的测试技能，仅当用户要求故意失败样例时使用。','这是故意失败的技能。[脚本](scripts/demo.py) 输出固定错误并以7退出。请如实报告失败，不能修正脚本后冒充原样例成功。','import sys\nprint("U07_INTENTIONAL_FAILURE: expected exit code 7",file=sys.stderr)\nsys.exit(7)\n')]:
    write(f'{d(key)}/{name}/SKILL.md', f'---\nname: {name}\ndescription: {desc}\n---\n\n# 合成验收样例\n\n{body}')
    write(f'{d(key)}/{name}/scripts/demo.py',script)
    write(f'{d(key)}/{name}/来源说明.md','由T-82交付方在2026-11-09编写的本地合成测试数据，不是外部社区项目，也不代表经过网络搜索。通过“社区导入”入口验证来源/信任流程。无第三方代码、密钥、网络访问或破坏性操作。')

mcp_script = r'''// Synthetic stdio MCP: fixed in-memory read-only data; no fs, network, environment or child-process access.
import {createInterface} from 'node:readline';
const label=process.argv[2] === 'B' ? 'B' : 'A';
const bad=process.argv.includes('--bad-protocol');
createInterface({input:process.stdin}).on('line',line=>{
 let q;try{q=JSON.parse(line);}catch{return;}
 if(q.id===undefined)return;
 let result;
 if(q.method==='initialize')result={protocolVersion:bad?'2999-01-01':'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'v07-readonly-'+label.toLowerCase(),version:'1.0.0'}};
 else if(q.method==='ping')result={};
 else if(q.method==='tools/list')result={tools:[{name:'read_sample',description:'Read fixed synthetic sales data. No I/O.',annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},inputSchema:{type:'object',properties:{},additionalProperties:false}}]};
 else if(q.method==='tools/call'&&q.params?.name==='read_sample')result={content:[{type:'text',text:JSON.stringify({marker:'U07_MCP_'+label+'_OK',service:label,rows:[{item:'茶杯',amount:25},{item:'记事本',amount:24},{item:'帆布袋',amount:30}],total:79})}],isError:false};
 else{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-32601,message:'Method not found'}})+'\n');return;}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\n');
});'''
script_path = write(f'{d("U07-07")}/readonly-mcp.mjs',mcp_script)
configs = {name:{'name':name,'transport':'stdio','command':str(NODE),'args':[str(script_path),label],'cwd':str(script_path.parent),'exposure':'direct','enabled':True,'description':'本地合成只读验收服务 '+label} for name,label in [('v07-readonly-a','A'),('v07-readonly-b','B')]}
data(f'{d("U07-07")}/MCP配置示例.json',configs)
write(f'{d("U07-07")}/应用里怎么填.md', f'''# 在应用里填 MCP

无需安装 npm 包、无需密钥、无需端口。应用会启动和关闭该 stdio 服务，不必手工常驻终端。

技能库 → MCP → 新建/编辑服务，或把下列字段交给助手登记（助手登记会先进入待确认）。名称 `v07-readonly-a`；传输 `stdio`；工具暴露 `direct`。

- 命令：`<候选安装目录>\\current\\runtime\\node.exe`。这是一项可执行文件路径，不要把参数拼在这里。若是便携解压，选你解压目录中实际的 `current\\runtime\\node.exe`。
- 本机已隔离验证的可直接用命令：`{NODE}`。若你使用不同安装位置，把JSON里的command改成那个随包Node的实际路径；不要依赖系统Node。
- 参数第1项：`{script_path}`；第2项：`A`。参数界面若是一行文本，用双引号包住脚本路径，例如 `"{script_path}" A`；如果是参数数组则分别填两项，不额外加引号。
- 工作目录：`{script_path.parent}`（若界面无此字段可留空，因为脚本用绝对路径）。环境变量留空。
- B 的名称 `v07-readonly-b`，第二参数改 `B`，其余相同。A与B是不同服务，不共用蝶君授权。

登记后先检查待确认，再接受、到MCP列表测试。两者应发现唯一工具 `read_sample`。首次实际调用应分别返回 U07_MCP_A_OK / U07_MCP_B_OK 和 total=79。

负例只在测试配置：名称 `v07-bad-protocol`，第二参数 `A` 后再加第三参数 `--bad-protocol`，接受后连接测试应失败。名称 `v07-missing-command`，command填 `E:\\DreamFlutter实测材料\\不存在的程序.exe`，应明确找不到命令；不要给失败服务业务权限。''')

# All git mutations are limited to newly-created fixture repositories, never REPO.
git_env = {k:v for k,v in os.environ.items() if not k.upper().startswith('GIT_')}
git_env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=str(QA/'empty-gitconfig'), GIT_TERMINAL_PROMPT='0')
(QA/'empty-gitconfig').write_text('',encoding='utf8')
def git(path,*args,ok=True):
    p=subprocess.run([str(GIT),'-C',str(path),*args],env=git_env,capture_output=True,text=True,encoding='utf8')
    if ok and p.returncode: raise RuntimeError(str(args)+': '+p.stderr)
    return p
def init(path):
    path.mkdir(parents=True);git(path,'init','-b','main')
    for key,val in [('user.name','Fixture User'),('user.email','fixture@example.invalid'),('commit.gpgSign','false'),('core.autocrlf','false'),('core.hooksPath','.git/fixture-hooks')]:git(path,'config','--local',key,val)
    (path/'.git/fixture-hooks').mkdir()
def commit(path,msg):git(path,'add','--','notes.txt');git(path,'commit','-m',msg)
r1=ROOT/d('U07-10')/'repo-author';init(r1)
(r1/'notes.txt').write_text('测试仓库第一版\n',encoding='utf8');commit(r1,'v1 add notes')
(r1/'totals.txt').write_text('茶杯25，记事本24，帆布袋30，合计79\n',encoding='utf8');git(r1,'add','--','totals.txt');git(r1,'commit','-m','v2 add totals')
r2=ROOT/d('U07-12')/'repo-no-author';init(r2);(r2/'notes.txt').write_text('测试底稿\n',encoding='utf8');commit(r2,'fixture baseline')
git(r2,'config','--local','user.name','');git(r2,'config','--local','user.email','');git(r2,'config','--local','user.useConfigOnly','true')
(r2/'notes.txt').write_text('测试底稿\n这行等待提交，但身份缺失\n',encoding='utf8')
r3=ROOT/d('U07-14')/'repo-conflict';init(r3);(r3/'notes.txt').write_text('同一行：基础\n',encoding='utf8');commit(r3,'base')
git(r3,'switch','-c','side');(r3/'notes.txt').write_text('同一行：side测试改动\n',encoding='utf8');commit(r3,'side change')
git(r3,'switch','main');(r3/'notes.txt').write_text('同一行：main测试改动\n',encoding='utf8');commit(r3,'main change')
assert git(r3,'merge','side',ok=False).returncode==1
repo_info=[]
for rp in [r1,r2,r3]:
    entry={'path':str(rp.relative_to(ROOT)), 'branch':git(rp,'branch','--show-current').stdout.strip(),'status':git(rp,'status','--porcelain').stdout,'commits':int(git(rp,'rev-list','--count','HEAD').stdout),'log':git(rp,'log','--format=%h %s').stdout,'remotes':git(rp,'remote','-v').stdout}
    repo_info.append(entry)
    with zipfile.ZipFile(rp.parent/(rp.name+'-初始快照.zip'),'w',zipfile.ZIP_DEFLATED) as z:
        for f in sorted(rp.rglob('*')):
            if f.is_file():z.write(f,f.relative_to(rp.parent))
data('Git初始状态.json',repo_info)
write(f'{d("U07-13")}/初始快照说明.md',f'在 ../{d("U07-10")} 找到 repo-author-初始快照.zip，解压到一个新的空测试目录；保留.git隐藏目录。不要覆盖自己已经改动的目录。')

rows=[['001','茶杯','2026-11-02',2,12.5],['002','记事本','2026-11-03',3,8],['003','帆布袋','2026-11-04',1,30]]
headers=['编号','项目','日期','数量','单价']
def csvfile(rel):
    p=ROOT/rel;p.parent.mkdir(parents=True,exist_ok=True)
    with p.open('w',encoding='utf-8-sig',newline='') as f:w=csv.writer(f);w.writerow(headers);w.writerows(rows)
    return p
for key in ['U07-15','U07-17','U07-19','U07-25']:csvfile(f'{d(key)}/销售.csv')
weekly='''# 测试周报

周期：2026-11-02 至 2026-11-08。所有内容均为虚构测试数据。

本周完成两项：整理物料清单、核对三笔销售。下周一项待确认：演示安排；负责人和发布日期均待确认。

| 项目 | 数量 | 金额（元） |
| --- | --- | --- |
| 茶杯 | 2 | 25 |
| 记事本 | 3 | 24 |
| 帆布袋 | 1 | 30 |

合计6件，金额79元，不含税费计算。风险：演示日期未确定，不得编造。'''
write(f'{d("U07-16")}/周报.md',weekly)
write(f'{d("U07-17")}/演示要点.md','''# 三页演示要点
1. 概览：测试周报；2026-11-02至2026-11-08；完成2项、待确认1项。
2. 销售明细：表格列出茶杯2件25元、记事本3件24元、帆布袋1件30元，合计6件79元；加入中文销售图.png。
3. 下一步：演示安排待确认，负责人和发布日期待确认。''')
write(f'{d("U07-23")}/问题.txt','7×8等于几？\n把 Good morning 翻译为中文。\n解释技能与MCP的区别。\n另一次请求：把U07-16/周报.md做成Word。')
write(f'{d("U07-25")}/本周记录.md',weekly+'\n\n长说明：待确认的演示安排包括展示顺序、现场设备检查、备用资料准备和问题记录整理，这是一条需要在窄窗口完整换行显示的长说明，负责人及发布日期均未确定。')
write(f'{d("U07-26")}/网络路径.txt',r'\\df-v07.invalid\share\database-test'+'\n'+r'\\?\UNC\df-v07.invalid\share\database-test'+'\n这两条只是非法数据库位置预检输入，不需要连接真实共享。')
write(f'{d("U07-27")}/测试记忆.txt','请记住：我的测试项目代号是纸鹤79。这是虚构测试记忆，只用于v0.7验收。')
write(f'{d("U07-27")}/备份恢复步骤.md','''# 只用独立测试数据

1. 用候选的独立测试配置开始，保存测试记忆.txt里的句子。关应用重开后问“我的测试项目代号是什么”；应为纸鹤79。
2. 用U07-04保留一条待确认建议。撤销U07-07服务A的信任和蝶君授权，记下待确认/信任状态；不要只关启用开关冒充撤信任。
3. 设置→备份与恢复，创建备份到自己新建的测试备份目录；记录实际文件名。不要选唯一一份个人数据。先使用界面提供的检查/预览确认可读。
4. 先保存并退出，按应用已有的数据位置入口选另一个新的测试数据目录；在这份独立配置里导入刚才备份。若界面要求重启按提示做，不覆盖原测试目录。
5. 核对“纸鹤79”、待确认、服务A仍不可信且不可给蝶君用；密钥没有随备份恢复时应清楚提示重填。大小写冲突要报告且保持不可信，不能自动合并历史。
6. 如入口/选项与说明不同，按屏幕实际名称记录，不手改数据库；此项是用户UI验收，交付侧仅对隔离测试数据验证支持的备份API，没有代做用户个人备份。''')

# Generate with the actual candidate Python libraries; no external downloads or paid models.
import matplotlib
matplotlib.use('Agg')
from matplotlib import pyplot as plt, font_manager
from matplotlib.backends.backend_pdf import PdfPages
from PIL import Image, ImageDraw, ImageFont
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches
from openpyxl import Workbook
from pptx import Presentation
from pptx.util import Inches as PInches, Pt
from pypdf import PdfReader
font_path=pathlib.Path(matplotlib.get_data_path())/'fonts/ttf/wqy-microhei.ttc'
assert font_path.is_file()
font_manager.fontManager.addfont(str(font_path))
plt.rcParams.update({'font.family':font_manager.FontProperties(fname=str(font_path)).get_name(),'axes.unicode_minus':False,'pdf.fonttype':42})
chart=ROOT/d('U07-19')/'参考中文图.png'
fig,ax=plt.subplots(figsize=(7,4),dpi=160);bars=ax.bar(['茶杯','记事本','帆布袋'],[25,24,30],color=['#345b82','#558467','#c27b48']);ax.set(title='测试销售金额',ylabel='金额（元）',ylim=(0,36));ax.bar_label(bars);fig.tight_layout();fig.savefig(chart);plt.close(fig)
shutil.copyfile(chart,ROOT/d('U07-17')/'中文销售图.png')
def workbook(path,formulas=False):
    w=Workbook();s=w.active;s.title='测试销售';s.append(headers+['金额'])
    for i,row in enumerate(rows,2):s.append(row+[f'=D{i}*E{i}' if formulas else row[3]*row[4]]);s.cell(i,1).number_format='@'
    s.append(['','','','合计','', '=SUM(F2:F4)' if formulas else 79])
    for col,width in [('A',12),('B',18),('C',20),('D',12),('E',12),('F',18)]:s.column_dimensions[col].width=width
    w.save(path)
workbook(ROOT/d('U07-15')/'公式样例.xlsx',True);workbook(ROOT/d('U07-22')/'公式未计算.xlsx',True)
def word(path,with_image=False):
    doc=Document();style=doc.styles['Normal'];style.font.name='Microsoft YaHei';style._element.rPr.rFonts.set(qn('w:eastAsia'),'Microsoft YaHei')
    doc.add_heading('测试周报',0);doc.add_paragraph('2026-11-02 至 2026-11-08；完成2项，待确认1项。')
    table=doc.add_table(rows=1,cols=3);table.style='Table Grid'
    for c,text in zip(table.rows[0].cells,['项目','数量','金额（元）']):c.text=text
    for row in rows:
        for c,text in zip(table.add_row().cells,[row[1],str(row[3]),str(row[3]*row[4])]):c.text=text
    doc.add_paragraph('合计6件，金额79元。演示安排、负责人和发布日期待确认。')
    if with_image:doc.add_picture(str(chart),width=Inches(6))
    doc.save(path)
word(ROOT/d('U07-16')/'参考内容.docx');word(ROOT/d('U07-19')/'参考含图.docx',True)
def ppt(path):
    p=Presentation();p.slide_width=PInches(13.333);p.slide_height=PInches(7.5)
    for title,body in [('测试周报','2026-11-02 至 2026-11-08\n完成2项，待确认1项；销售79元。'),('销售明细',''),('下一步','演示安排待确认\n负责人：待确认\n发布日期：待确认')]:
        s=p.slides.add_slide(p.slide_layouts[5]);s.shapes.title.text=title
        if body:s.shapes.add_textbox(PInches(.7),PInches(1.7),PInches(11),PInches(4)).text=body
        else:
            tab=s.shapes.add_table(4,3,PInches(.6),PInches(1.8),PInches(5.1),PInches(2.5)).table
            for i,row in enumerate([['项目','数量','金额（元）']]+[[r[1],str(r[3]),str(r[3]*r[4])] for r in rows]):
                for j,t in enumerate(row):tab.cell(i,j).text=t
            s.shapes.add_picture(str(chart),PInches(6),PInches(1.7),width=PInches(6.6))
        for shape in s.shapes:
            if shape.has_text_frame:
                for para in shape.text_frame.paragraphs:
                    for run in para.runs:run.font.name='Microsoft YaHei';run.font.size=Pt(24)
    p.save(path)
ppt(ROOT/d('U07-17')/'参考内容.pptx');ppt(ROOT/d('U07-19')/'参考含图.pptx')
for filename,pages in [('普通文字A.pdf',[('PAGE_A1','第一页：茶杯，数量2，金额25元'),('PAGE_A2','第二页：记事本，数量3，金额24元')]),('普通文字B.pdf',[('PAGE_B1','第三页：帆布袋，数量1，金额30元')])]:
    path=ROOT/d('U07-18')/filename
    with PdfPages(path) as pdf:
        for marker,text in pages:
            fig=plt.figure(figsize=(8.27,11.69));fig.text(.12,.88,'v0.7 '+marker,fontsize=22);fig.text(.12,.76,text,fontsize=18);fig.text(.12,.67,'合成普通文字PDF，可提取文字。',fontsize=14);pdf.savefig(fig);plt.close(fig)
    actual=''.join(p.extract_text() or '' for p in PdfReader(path).pages)
    assert all(marker in actual and text in actual for marker,text in pages),repr(actual)
image=Image.new('RGB',(1240,1754),'white');draw=ImageDraw.Draw(image);font=ImageFont.truetype(str(font_path),44)
draw.multiline_text((100,180),'这是扫描测试页\n\n纸鹤79\n\n茶杯25元，记事本24元，帆布袋30元。\n\n总金额79元。\n\n本页只有图像，没有文本层。',font=font,fill='black',spacing=28)
image.save(ROOT/d('U07-22')/'扫描件.pdf','PDF',resolution=150)
assert not (PdfReader(ROOT/d('U07-22')/'扫描件.pdf').pages[0].extract_text() or '').strip()

# Static office inputs for native legacy generation; formula workbook is never opened in Office.
modern=ROOT/d('U07-20')/'新格式';modern.mkdir()
word(modern/'测试.docx');workbook(modern/'测试.xlsx');ppt(modern/'测试.pptx')
shutil.copyfile(modern/'测试.docx',ROOT/d('U07-21')/'无Office输入.docx')
data('办公预期.json',{'synthetic':True,'rows':rows,'amounts':[25,24,30],'total':79,'quantity':6,'formula_cache':None,'pdf_merged_order':['PAGE_A1','PAGE_A2','PAGE_B1'],'period':['2026-11-02','2026-11-08'],'done':2,'pending':1,'owner':'待确认','publishDate':'待确认'})
for key in [f'U07-{i:02}' for i in range(15,23)]+['U07-25']:
    write(f'{d(key)}/预期内容.md', '# 预期内容\n\n'+steps[key][2]+'\n\n统一原始数据：编号001/002/003；茶杯2×12.50=25，记事本3×8=24，帆布袋1×30=30；总6件79元。无真实客户或私人信息。\n\n交付参考件用于对照，不可冒充助手本次新生成结果。')
readme=['# 先看我：v0.7用户实测材料','所有数据是虚构的。请按编号操作，把实际结果写进用户回执.tsv；本包自验通过不等于你的用户实测通过。',f'候选版本 **0.7.0-test.3**。Setup：`{REPO / "dist/t82-candidate-test.3/Velopack/DreamFlutter-win-x64-Setup.exe"}`。\n\nSetup SHA-256：`{SETUP_SHA}`。\n\n便携包与Setup同目录，文件名 DreamFlutter-win-x64-Portable.zip。安装位置和是否替换原测试版由你决定；请使用独立测试数据。', '材料位置：`E:\\DreamFlutter实测材料\\v0.7\\`。只在自己的测试副本操作，不把DreamFlutter源码仓库当测试仓库。三个Git仓库有包含.git的初始ZIP；需要重来就解压到新目录，别覆盖已改动的副本。', '社区导入技能是明确标注的本地合成样例，不是假冒真实开源项目。脚本仅在新的测试蝶君试运行。MCP无害、只读、无密钥，用候选自带Node启动，配置详见U07-07。', '本轮交付自验不跑付费模型。你在应用里给助手发消息可能按自己的渠道计费；密钥只在应用设置中填写，不放进回执/截图。可选账号项没有条件就写跳过。办公参考件不代替助手真实产物。', '入口：侧栏技能库切换技能/模板/MCP；建议在“待确认”里审阅；工作台选择宿主测试工作目录；蝶君使用新的专用测试环境。对照仓库 docs/testing/v0.7-user-checklist.md 的同编号逐条记录。']
for key,(files,action,expected) in steps.items():
    readme.append(f'## {key} {folders[key].split("-",2)[-1]}\n\n目录：[打开说明]({folders[key]}/操作与预期.md)\n\n用什么：{files}\n\n点哪里/说什么：{action}\n\n应该看到：{expected}')
readme.append('## 交付自验\n\n逐项输入和隔离验证结果见 自验结果.md 与 材料清单.json。未代做你的模型回答、账号登录、安装与用户UI验收。没有关闭全部WSL，没有改旧蝶君，没有把参考输出当新生成结果。')
write('先看我.md','\n\n'.join(readme))
write('用户回执.tsv','编号\t版本/环境\t实际操作\t实际看到\t结果及原因\t截图或输出文件\n'+'\n'.join(f'{key}\t0.7.0-test.3\t\t\t未测\t' for key in folders))
data('材料索引.json',folders)
print(json.dumps({'root':str(ROOT),'qa':str(QA),'files':sum(f.is_file() for f in ROOT.rglob('*')),'folders':len(folders),'git':repo_info},ensure_ascii=True))
