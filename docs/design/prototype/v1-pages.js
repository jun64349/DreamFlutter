/* Memory, skills, spending (floating panels), inbox, schedule, wizard, render. */
function fp(tabs,cur,key,body){
 return `<div class="scrim" data-a="close"><div class="fp" data-stop="1"><div class="fp-h">${tabs.map(([t,i])=>`<button class="tb ${cur===t?'on':''}" data-a="set" data-k="${key}" data-v="${t}">${ic(i,'width:15px;height:15px')}${t}</button>`).join('')}<span class="sp"></span><button class="ib" title="关闭（Esc）" data-a="close">${ic('x')}</button></div><div class="fp-b">${body}</div></div></div>`;
}
function vMemory(){
 let b='';
 if(S.memTab==='最近'){
  b=`<div class="banner"><div style="flex:1"><span class="t poetic">梦君记</span><small>它记得的事，按天排。点一条就能改，删了能撤销</small></div><div class="ssearch" style="width:240px;margin:0">${ic('search','width:14px;height:14px')}搜索记忆</div></div>
  <div class="acts" style="margin-bottom:14px">${['全部','关于你','项目','蝶君自己记的'].map((t,i)=>`<button class="chip ${i===0?'on':''}">${t}</button>`).join('')}</div>
  <div class="tl">${[['今天',[['偏','回复简练，普通问答不用做成卡片','来自「第三章 文献综述润色」','关于你'],['蝶','SHT40 湿度精度 ±1.8%，比 DHT22 高一截','蝶君空闲学习时记的 · 来源 SHT40 数据手册','蝶君自己记的']]],['11月12日',[['周','每周一要交组会周报，用 W 加周次命名','来自「整理本周温湿度数据成周报」','项目']]],['11月8日',[['图','做实验数据分析偏好用 Python 画图','来自「实验数据画成箱线图」','关于你']]]].map(([d,items])=>`<div class="tli"><div class="when">${d}</div>${items.map(([g,t,s,k])=>`<div class="mcard" style="margin-top:8px"><span class="glyph">${g}</span><div class="w"><b>${t}</b><small style="display:block">${s}</small></div><span class="tag ${k==='蝶君自己记的'?'bf':''}">${k}</span><button class="ib" title="改">${ic('edit','width:14px;height:14px')}</button><button class="ib" title="删除">${ic('trash','width:14px;height:14px')}</button></div>`).join('')}</div>`).join('')}</div>`;
 }else if(S.memTab==='日志'){
  b=`<div style="max-width:640px">${[['10:20','记住了','回复简练，普通问答不用做成卡片'],['09:12','改了','「每周一交周报」→「每周一要交组会周报，用 W 加周次命名」'],['昨天 23:10','忘掉了','三个月没用到的：「用 Word 写报告」']].map(([t,a,x])=>`<div class="lrow"><span style="width:76px;color:var(--muted);font-size:12px">${t}</span><span class="tag ${a==='忘掉了'?'off':''}">${a}</span><div class="w" style="font-size:13px">${x}</div><a class="lk" style="font-size:12.5px">撤销</a></div>`).join('')}</div>`;
 }else b=sBody('记忆');
 return fp([['最近','memory'],['日志','clock'],['设置','gear']],S.memTab,'memTab',b);
}
const SKILLS=[
 ['pd','pend','组会纪要整理','蝶君在沙箱里试过 3 次','<span class="tag wait">等你确认</span>'],
 ['sk','sk1','规格书要点提取','从传感器规格书里抽精度、量程、接口、价格','<span class="tag bf">蝶君写的</span>'],
 ['sk','sk2','周报卡片','把周报、简报做成排版好的卡片','<span class="tag">可用</span>'],
 ['sk','sk3','Excel 表格处理','读写 xlsx、批量清洗和汇总','<span class="tag off">已停用</span>'],
 ['sv','mcp1','Zotero 文献库','搜文献、读条目、加笔记','<span class="tag">可用</span>'],
 ['sv','mcp2','飞书文档','读写飞书云文档','<span class="tag bad">连不上</span>'],
];
function vSkills(){
 const rowS=([g,id,n,s,p])=>`<div class="li ${S.skSel===id?'on':''}" data-a="set" data-k="skSel" data-v="${id}"><div class="w">${n}<small>${s}</small></div>${p}</div>`;
 const want=S.skTab==='技能'?['pd','sk']:['sv'];
 const list=`<div><div class="drop">${ic('folder','width:14px;height:14px;vertical-align:-2px')} 把技能文件夹拖进来，或者 <a class="lk">选一个</a></div>
  ${want.includes('pd')?`<div class="grp">等你确认</div>${SKILLS.filter(x=>x[0]==='pd').map(rowS).join('')}`:''}
  ${want.includes('sk')?`<div class="grp">技能</div>${SKILLS.filter(x=>x[0]==='sk').map(rowS).join('')}`:''}
  ${want.includes('sv')?`<div class="grp">连接的服务</div>${SKILLS.filter(x=>x[0]==='sv').map(rowS).join('')}<div class="inset" style="margin-top:10px">想接别的？在对话里说「帮我接上 Notion」</div>`:''}</div>`;
 const s=SKILLS.find(x=>x[1]===S.skSel)||SKILLS[1];
 let det;
 if(s[0]==='sv'){const bad=s[1]==='mcp2';
  det=`<div class="det"><div class="hd"><b>${s[2]}</b>${s[4]}<span style="flex:1"></span>${tg(!bad)}<button class="ib" title="更多">${ic('more')}</button></div><div class="bd"><div style="color:var(--ink2);font-size:13.5px;margin-bottom:10px">${s[3]}</div>
  ${bad?`<div class="cnote">${ic('info','width:14px;height:14px')}飞书说应用凭证过期了。去飞书开放平台重新生成一个，填到下面。</div>`:''}
  ${sh(bad?'工具':'工具 · 5 个')}${bad?'<div class="inset">连上以后显示</div>':card([['搜索文献','search_items',1,''],['读取一条文献','get_item',1,''],['给文献加笔记','add_note',1,'改东西，先问我'],['删除文献','delete_item',0,'改东西，先问我']].map(([d,c,on,w])=>row(d,tg(on),{d:`<code style="font-family:var(--mono)">${c}</code>${w?' · '+w:''}`})).join(''))}
  ${sh('连接方式')}${card(row('命令',`<code style="font-family:var(--mono);font-size:12.5px">${bad?'npx @larksuite/mcp':'npx zotero-mcp'}</code>`)+row(bad?'FEISHU_APP_SECRET':'ZOTERO_API_KEY',`<span class="num">•••••••• <small>改</small></span>`))}
  <div class="kv" style="margin-top:12px"><span>来源</span><span>你在对话里让工作台接上的 · 11月6日</span></div><div class="kv"><span>用过</span><span>${bad?'0 次':'23 次 · 上次 今天 09:40'}</span></div></div>
  <div class="ft"><button class="btn">测试连接</button><span style="flex:1"></span><button class="btn pri">保存</button></div></div>`;
 }else{const pend=s[1]==='pend';
  det=`<div class="det"><div class="hd"><b>${s[2]}</b>${s[4]}<span style="flex:1"></span>${pend?'':tg(s[1]!=='sk3')}<button class="ib" title="更多">${ic('more')}</button></div><div class="bd"><div style="color:var(--ink2);font-size:13.5px">${s[3]}</div>
  <div style="margin:10px 0">${pend?`<div class="kv"><span>来源</span><span>蝶君写的 · 参考 GitHub 上的 meeting-notes</span></div><div class="kv"><span>试用</span><span>沙箱里 3 份录音，程序核对都通过</span></div><div class="kv"><span>会做的事</span><span>只读你给的文件，结果写成新文件</span></div>`:`<div class="kv"><span>来源</span><span>${s[1]==='sk1'?'蝶君写的 · 11月12日':'内置'}</span></div><div class="kv"><span>用过</span><span>6 次 · 上次 昨天</span></div><div class="kv"><span>谁在用</span><span>${s[1]==='sk1'?'蝶君 · <a class="lk">也给工作台用</a>':'工作台、蝶君'}</span></div>`}</div>
  <div class="files2"><div class="tree"><div class="on">${ic('file','width:13px;height:13px')}SKILL.md</div><div>${ic('folder','width:13px;height:13px')}scripts/</div><div style="padding-left:26px">extract.py</div><div>${ic('folder','width:13px;height:13px')}examples/</div></div>
  <div class="pv"><div style="font-weight:700;color:var(--ink);text-align:center;margin-bottom:4px">${s[2]}</div>读一份规格书（PDF），抽出精度、量程、接口、供电和参考价格，填进对比表。数字要带单位和出处页码，找不到的写「没写」。</div></div></div>
  <div class="ft">${pend?'<button class="btn pri">采用</button><button class="btn">不要</button><span style="flex:1"></span><button class="btn">试一下</button>':'<button class="btn">试一下</button><span style="flex:1"></span><button class="btn warn">删除</button>'}</div></div>`;}
 return fp([['技能','skills'],['连接的服务','hub']],S.skTab,'skTab',`<div class="ph" style="margin-top:0"><div><h1>百工</h1><span class="plain">技能和连接的服务</span></div><span class="sp"></span><button class="btn">${ic('plus','width:13px;height:13px')}新建</button></div><div class="two">${list}${det}</div>`);
}
function vSpend(){
 const bars=[30,55,20,70,45,80,35,60,25,50,65,40,72,38,55,62,28,45,90,52,40,33,58,66,47,71,36,49,60,44];
 const byAmt=S.spendBy==='金额';
 const ring=(parts)=>{let a=0;return `conic-gradient(${parts.map(([p,c])=>{const s=`${c} ${a}% ${a+p}%`;a+=p;return s;}).join(',')})`;};
 const donut=(title,parts,labels)=>`<div class="card" style="padding:14px 16px;display:flex;gap:18px;align-items:center"><div class="donut" style="background:${ring(parts)};-webkit-mask:radial-gradient(circle,transparent 54%,#000 55%);mask:radial-gradient(circle,transparent 54%,#000 55%)"></div><div style="flex:1"><div style="font-weight:600;margin-bottom:8px">${title}</div><div class="legend">${labels.map(([l,v],i)=>`<div><i style="background:${parts[i][1]}"></i>${l}<span style="margin-left:auto;color:var(--muted)">${v}</span></div>`).join('')}</div></div></div>`;
 const C=['var(--accent)','var(--ochre)','var(--ok)','var(--muted)'];
 return fp([['花费','coin']],'花费','x',`<div class="ph" style="margin-top:0"><div><h1>锱铢</h1><span class="plain">花费</span></div><span class="sp"></span>${seg(['金额','次数'],S.spendBy,'spendBy')}</div>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:14px">${[['今天',byAmt?'$0.42':'38 次'],['这个月',byAmt?'$9.86':'1,204 次'],['每月上限',byAmt?'$40.00':'—']].map(([k,v])=>`<div class="card" style="padding:14px 16px"><div style="font-size:12px;color:var(--muted)">${k}</div><div style="font-family:var(--serif);font-size:24px;font-weight:600">${v}</div></div>`).join('')}</div>
  <div class="card" style="padding:14px 16px;margin-bottom:14px"><div style="display:flex;font-weight:600">近 30 天<span style="flex:1"></span><span style="font-weight:400;font-size:12px;color:var(--muted)">悬停看当天明细</span></div><div class="bars">${bars.map((h,i)=>`<i style="height:${h}%" title="11月${i+1}日 · ${byAmt?'$'+(h/100).toFixed(2):h*3+' 次'}"></i>`).join('')}</div></div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">${donut('按用途',[[52,C[0]],[26,C[1]],[14,C[2]],[8,C[3]]],[['工作台对话','52%'],['蝶君自己做事','26%'],['记忆整理','14%'],['其他','8%']])}${donut('按模型',[[61,C[0]],[30,C[1]],[9,C[2]]],[['DeepSeek V4.1 Flash','61%'],['GPT-6.1 Sol','30%'],['GLM-4.6V','9%']])}</div>`);
}
function vInbox(){
 if(S.inboxEmpty)return {main:`<div class="top"><span class="sp"></span></div><div class="scroll"><div class="page inbox-empty"><div class="ph"><div><h1>案头</h1><span class="plain">等你处理</span></div></div><div class="inbox-rest"><span class="inbox-rest-icon">${ic('inbox','width:25px;height:25px')}</span><div>没有待处理的事项</div></div></div></div>`,right:null};
 const rule=S.inboxRule?`<div class="icard decide"><div class="from">蝶君 · 规则</div><div class="what">${S.inboxRule==='obs'?'规则开始观察了：命中时只记一笔，不动手':'没采用这条规则'}</div></div>`:
 `<div class="icard decide"><div class="from">蝶君 · 起草了一条规则</div><div class="what">要不要让蝶君以后自动做这件事？</div>${S.inboxEdit?`<div class="fld"><label>名称</label><input value="工作日 9 点整理新纪要"></div><div class="fld"><label>要做的事</label><input value="工作日早上 9 点，把「资料/组会」里的新纪要整理成要点，只读原件"></div><div class="acts"><button class="btn pri" data-a="tog" data-v="inboxEdit">保存</button><button class="btn" data-a="tog" data-v="inboxEdit">取消</button></div>`:`<div class="why" style="font-family:var(--serif);background:var(--sunk);border-radius:8px;padding:8px 10px">工作日早上 9 点，把「资料/组会」文件夹里的新纪要整理成要点，只读原件，结果放进交付，不对外发送。</div><div class="acts"><button class="btn pri" data-a="set" data-k="inboxRule" data-v="obs">先观察</button><button class="btn" data-a="tog" data-v="inboxEdit">改一改</button><button class="btn" data-a="set" data-k="inboxRule" data-v="no">不要</button></div>`}</div>`;
 return {main:`<div class="top"><span class="sp"></span></div><div class="scroll"><div class="page"><div class="ph"><div><h1>案头</h1><span class="plain">等你处理</span></div></div>
 <div class="ihead">${ic('flag','color:var(--accent)')}待你决定 · 2</div>
 <div class="icard decide"><div class="from">蝶君 · 整理三款温湿度传感器对比</div><div class="what">海外那款要算进对比吗？</div><div class="why">不答的话 14:20 后按「先不算」继续</div><div class="acts"><button class="btn">算进去</button><button class="btn pri">先不算</button><button class="btn line" data-a="go" data-v="chat">去对话里说</button></div></div>
 ${rule}
 <div class="ihead">${ic('x','color:var(--seal)')}卡住了 · 1</div>
 <div class="icard block"><div class="from">蝶君 · 整理组会纪要模板</div><div class="what">找不到「资料/组会」文件夹</div><div class="why">你上周把它挪走了？给我新位置就能接着做</div><div class="acts"><button class="btn pri">选文件夹</button><button class="btn">暂停这个目标</button></div></div>
 <div class="ihead">${ic('check','color:var(--ok)')}等你验收 · 1</div>
 <div class="icard accept"><div class="from">蝶君 · 学 Silero 语音检测</div><div class="what">学习笔记写好了，程序核对过 3 项证据</div><div class="why">silero-notes.md · 4.2 KB · 附 2 段可运行的示例</div><div class="acts"><button class="btn pri">打开看看</button><button class="btn">收下</button><button class="btn">还要改</button></div></div>
 </div></div>`,right:null};
}
function vSchedule(){
 const days=[];[26,27,28,29,30,31].forEach(d=>days.push({d,out:1}));for(let d=1;d<=30;d++)days.push({d});while(days.length%7)days.push({d:days.length-35,out:1});
 const ev={3:[['组会纪要','past']],10:[['组会纪要','past']],12:[['交传感器对比','fail']],14:[['14:00 导师见面','']],17:[['组会纪要','']],20:[['交周报','']],24:[['组会纪要','']]};
 const items=[['08:00','提醒吃药','每天 · 只提醒','已提醒','ok'],['12:00','提醒吃药','每天 · 只提醒','已提醒','ok'],['14:00','导师见面','你建的 · 只提醒','',''],['15:00','交传感器报告','蝶君去做','',''],['18:00','提醒吃药','每天 · 只提醒','','']];
 return {main:`<div class="top"><span class="sp"></span></div><div class="scroll"><div class="page" style="max-width:1080px"><div class="ph"><div><h1>时令</h1><span class="plain">日程</span></div><span class="sp"></span><span style="font-size:12.5px;color:var(--muted)">巡检：09:30 无需行动 · 下次 10:00</span><button class="btn pri">${ic('plus','width:13px;height:13px')}新建</button></div>
 <div style="display:grid;grid-template-columns:1fr 320px;gap:16px;align-items:start">
  <div><div style="display:flex;align-items:center;gap:6px;margin-bottom:8px"><button class="ib">${ic('left')}</button><b style="font-family:var(--serif);font-size:16px">2026 年 11 月</b><button class="ib">${ic('right')}</button><span class="sp" style="flex:1"></span><span class="chip" style="padding:3px 10px">每天：提醒吃药 · 8、12、18、22 点</span></div>
  <div class="cal">${['一','二','三','四','五','六','日'].map(d=>`<div class="dh">${d}</div>`).join('')}${days.map(x=>`<div class="day ${x.out?'out':''} ${!x.out&&x.d===13?'today':''} ${!x.out&&x.d===S.selDay?'sel':''}" data-a="day" data-v="${x.out?'':x.d}"><span class="d">${x.d}</span>${!x.out&&ev[x.d]?ev[x.d].map(([t,c])=>`<div class="e ${c}">${t}</div>`).join(''):''}</div>`).join('')}</div></div>
  <div class="card" style="padding:12px 16px"><div style="font-family:var(--serif);font-weight:600;font-size:16px;margin-bottom:6px">11 月 ${S.selDay} 日</div>${S.selDay===14?items.map(([t,n,d,r,c])=>`<div class="it"><span class="tm">${t}</span><div class="w">${n}<small>${d}</small></div><span class="${c}" style="font-size:12px">${r}</span></div>`).join(''):S.selDay===12?`<div class="it"><span class="tm">09:00</span><div class="w">交传感器对比<small>蝶君去做</small></div><span class="bad" style="font-size:12px">没做成</span></div><div class="cnote" style="margin-top:8px">网页打不开，价格没抓到。<span class="sp"></span><a>现在再做一次</a></div>`:'<div class="empty" style="padding:24px">这天没有安排</div>'}</div>
 </div></div></div>`,right:null};
}
// 内测版反馈表（用户的腾讯文档）。
const FEEDBACK_URL='https://docs.qq.com/doc/DVm1zU2VmU1JIVHZn';
function vWizard(){
 const n=S.wz,man=S.ed==='managed';
 const dots=n>=1?`<div class="dots">${[1,2,3,4,5].map(i=>`<i class="${i===n?'on':i<n?'done':''}"></i>`).join('')}</div>`:'';
 const nav=(o={})=>`<div class="wnav">${n>1?'<button class="btn" style="background:none" data-a="wz" data-v="-1">上一步</button>':''}<span class="sp"></span>${o.skip?'<button class="btn" style="background:none;color:var(--muted)" data-a="wz" data-v="1">跳过</button>':''}<button class="btn pri" data-a="wz" data-v="1" ${o.block?'disabled':''}>${o.label||'下一步'}</button></div>`;
 let c='';
 // 内测版（2026-11-19 用户定）：第一次启动只有这一张卡片，激活成功直接进界面；其余几步全用默认。
 if(man){const t=S.wzT;c=`<div style="text-align:center;padding:20px 0 6px">${bf(96,'float')}<h2 class="poetic" style="font-size:30px;font-weight:400;margin-top:16px">输入激活码</h2>
  <div class="fld" style="margin-top:18px"><input type="password" value="${t?'sk-••••••••••••••••':''}" placeholder="粘贴激活码" style="text-align:center"></div>
  ${t==='busy'?`<div style="display:flex;gap:8px;align-items:center;justify-content:center;font-size:13px;color:var(--muted)"><span class="spin"></span>正在激活…</div>`:t==='ok'?`<div style="font-size:13px" class="ok">${ic('check','width:14px;height:14px;vertical-align:-2px')} 激活成功</div>`:t==='bad'?`<div style="font-size:13px" class="bad">${ic('x','width:14px;height:14px;vertical-align:-2px')} 激活码不对或已经停用</div>`:''}
  <button class="btn pri" style="padding:8px 34px;margin-top:16px" data-a="go" data-v="home" ${t!=='ok'?'disabled':''}>进入</button>
  <div class="demo-sw" style="margin-top:14px">${['','busy','ok','bad'].map((v,i)=>`<button class="chip ${S.wzT===v?'on':''}" style="font-size:11px;padding:2px 8px;border-style:dashed" data-a="set" data-k="wzT" data-v="${v}">演示：${['未填','激活中','成功','不对'][i]}</button>`).join(' ')}</div></div>`;}
 else if(n===0)c=`<div style="text-align:center;padding:20px 0 6px">${bf(96,'float')}<h2 class="poetic" style="font-size:30px;font-weight:400;margin-top:16px">你好，我是 DreamFlutter</h2><div class="sub">住在你电脑里的助手。花一分钟设好，就能开始。</div><button class="btn pri" style="padding:8px 34px" data-a="wz" data-v="1">开始</button></div>`;
 else if(n===1)c=`${dots}<h2>数据放在哪</h2><div class="sub">对话、记忆、设置都存在这里</div><div class="choice on"><span class="rd"></span><div>跟软件放在一起（推荐）<small>E:\\DreamFlutter\\data · 剩余 142 GB</small></div></div><div class="choice"><span class="rd"></span><div>选别的文件夹…</div></div>${nav()}`;
 else if(n===2)c=`${dots}<h2>怎么称呼你</h2><div class="sub">随时能改</div><div class="fld"><input value="小周"></div>${nav()}`;
 else if(n===3&&!man){const t=S.wzT;c=`${dots}<h2>连接一个模型</h2><div class="sub">密钥只存在这台电脑上</div><div class="provs">${['DeepSeek','智谱','OpenCode Go','其他'].map((p,i)=>`<div class="prov ${i===0?'on':''}">${p}</div>`).join('')}</div>
  <div class="fld"><label>密钥<a class="lk">去 DeepSeek 拿密钥 ↗</a></label><input type="password" value="${t?'sk-••••••••••••••••':''}" placeholder="粘贴后自动测试"></div>
  ${t==='busy'?`<div class="state" style="display:flex;gap:8px;align-items:center;font-size:13px;color:var(--muted)"><span class="spin"></span>正在试连接…</div>`:t==='ok'?`<div style="font-size:13px" class="ok">${ic('check','width:14px;height:14px;vertical-align:-2px')} 连上了。对话用 DeepSeek V4.1 Flash，大任务用 DeepSeek V4.1，以后在输入框里能换。</div>`:t==='bad'?`<div style="font-size:13px" class="bad">${ic('x','width:14px;height:14px;vertical-align:-2px')} DeepSeek 说这个密钥无效。回网站重新复制一次，注意前后别多出空格。</div>`:''}
  <div class="demo-sw" style="margin-top:8px">${['','busy','ok','bad'].map((v,i)=>`<button class="chip ${S.wzT===v?'on':''}" style="font-size:11px;padding:2px 8px;border-style:dashed" data-a="set" data-k="wzT" data-v="${v}">演示：${['未填','测试中','连上','不对'][i]}</button>`).join(' ')}</div>${nav({block:t!=='ok',skip:true})}`;}
 else if(n===4)c=`${dots}<h2>常用的项目文件夹</h2><div class="sub">工作台默认在这里干活</div><div style="display:flex;gap:8px"><div class="path" style="flex:1;color:var(--muted)">还没选</div><button class="btn">选一个</button></div>${nav({skip:true})}`;
 else c=`${dots}<h2>蝶君</h2><div class="sub">选一种说话的样子，以后可以在设置里改</div><div class="pcards" style="padding-top:0">${['静','暖','利落','灵动'].map(k=>`<button class="pcard ${S.persona===k?'on':''}" data-a="set" data-k="persona" data-v="${k}"><b>${k}</b></button>`).join('')}</div><div class="choice on"><span class="rd"></span><div>现在准备沙箱（推荐）<small>后台进行，大约 3 分钟，不影响先用工作台</small></div></div><div class="choice"><span class="rd"></span><div>以后再说</div></div>${nav({label:'开始使用'})}`;
 return {full:`<div class="wzbg" style="position:relative;overflow:hidden"><div style="position:absolute;right:-60px;bottom:-80px;opacity:.07;transform:rotate(-14deg)">${bf(520)}</div><div class="inscr" style="right:auto;left:48px;top:60px;bottom:auto;font-size:22px;opacity:.18">昔者庄周梦为胡蝶</div><div class="wz" style="position:relative">${c}</div></div>`};
}

/* ---------- notes ---------- */
const NOTES={
home:`<h4>首页</h4><ul><li>布局照 HanaAgent：主区一条中线，蝴蝶、问候、引文、输入框、例子从上往下，四周大留白。</li><li>我们的东西：问候是书法字、墨色到主题色的渐变；蝴蝶轻轻浮动；头上一层主题色的淡晕；整个窗口一层宣纸纹理（设置 › 外观可调）。</li><li>输入框占位文字轮换成用法提示。例子点了只填进输入框，不发送。</li><li>侧栏：上面工作台 / 蝶君；导航只留新对话、等你处理、（日程）、记忆、技能；搜索框下面是工作区选择；对话两行（标题 + 时间 · 当前模型），分「今天 / 更早」；分支默认折叠，主对话左边的钮展开；右下角竖排题字跟着主题换；底部是你、花费、设置（图标不带字，悬停看名字）。</li></ul>`,
chat:`<h4>对话</h4><ul><li>正文最宽 720，衬线体；你的话在右边浅底气泡，回复开头一只小蝴蝶（写的时候扇翅，写完留着当头像）。</li><li>过程块轻：浅底、不加框，折叠时和标题一样宽；展开后一行一步。</li><li>回复下面一行照旧（模型 · 速度 · 用时 · 几点，不写花费），按钮悬停才出现。</li><li>代码块、图表：头上一行语言名，按钮平时很淡；图表可以切到源码。表格细线全框，引用左边一条线。</li><li>右栏「这个对话」：工作台分文件 / Git / 后台 / 上下文四页；蝶君是目标、后台、交付、定时竖着排。</li><li>顶上切到蝶君能看目标、计划条、提问卡。</li></ul>`,
inbox:`<h4>等你处理（案头）</h4><ul><li>三组固定顺序：待你决定 → 卡住了 → 等你验收；卡片左边一条细色带。每张卡片写清是谁、哪件事、现在怎样，再给能直接按的按钮。</li></ul>`,
schedule:`<h4>日程（时令）</h4><ul><li>左边月历，右边那天的清单；过去没做成的标红，点开在清单下面给「现在再做一次」。顶上一行巡检状态。</li></ul>`,
settings:`<h4>设置（一方天地）</h4><ul><li>改成 HanaAgent 那样盖在窗口上的大面板：左边搜索 + 分组导航（我与蝶君 / 工作 / 应用 / 更多），右边内容，Esc 关。</li><li>11 个分页每一项都画了。写法统一：名字在左，控件在右、同类同宽；说明只写「改了会怎样」；几个档位用分段按钮；开关打开后子项缩进出现；列表为空时给例子；危险的值红字。</li><li>「外观」里点主题卡片，整个界面马上换，试试幻蝶、石青。</li><li>演示开关「托管版」打开后就是内测版：「模型」页换成模型池（激活码、本机已花、四个用途写死），不显示模型组和渠道；「关于」只留版本、反馈、诊断，没有更新。</li></ul>`,
memory:`<h4>记忆（梦君记）</h4><ul><li>浮在窗口上的面板，上面三个标签：最近 / 日志 / 设置。最近按天排成时间线，每条一个书法字当记号，标出来源和分组；改和删都在条目上。</li></ul>`,
skills:`<h4>技能（百工）</h4><ul><li>浮层面板，「技能 / 连接的服务」两个标签；左边列表（等你确认在最上），右边详情：技能能看 SKILL.md 和文件；服务每个工具一个开关，底部固定测试连接、保存。</li></ul>`,
spend:`<h4>花费（锱铢）</h4><ul><li>照旧是图表：近 30 天柱状、按用途和按模型两个环，金额 / 次数可切。上面三个大数字。</li></ul>`,
wizard:`<h4>第一次启动</h4><ul><li>五步，每步一张卡片居中，顶上进度条。模型那步粘贴密钥自动测试，可以跳过；托管版（内测版）只有一张「输入激活码」卡片，激活成功点「进入」直接到首页，其余几步全用默认。</li></ul>`};

/* ---------- render ---------- */
const SCENES=[['home','首页'],['chat','对话'],['inbox','等你处理'],['schedule','日程'],['wizard','第一次启动']];
const OVS=[['settings','设置'],['memory','记忆'],['skills','技能'],['spend','花费']];
function render(){
 applyTheme();
 $('#demo').innerHTML=`<b>DreamFlutter 重做（演示）</b>${SCENES.map(([k,t])=>`<button class="${S.scene===k&&!S.overlay?'on':''}" data-a="go" data-v="${k}">${t}</button>`).join('')}<span style="opacity:.4">|</span>${OVS.map(([k,t])=>`<button class="${S.overlay===k?'on':''}" data-a="ov" data-v="${k}">${t}</button>`).join('')}<span class="sp"></span>
 <button class="${S.space==='bf'?'on':''}" data-a="space" data-v="${S.space==='wb'?'bf':'wb'}">${S.space==='wb'?'切到蝶君':'切到工作台'}</button><button class="${S.ed==='managed'?'on':''}" data-a="ed">托管版</button><button class="${S.notes?'on':''}" data-a="notes">说明</button><button data-a="dark">${S.dark?'浅色':'深色'}</button>`;
 const v=S.scene==='home'?vHome():S.scene==='chat'?vChat():S.scene==='inbox'?vInbox():S.scene==='schedule'?vSchedule():vWizard();
 const sideEl=$('#side'),rightEl=$('#right');
 if(v.full){sideEl.style.display='none';rightEl.style.display='none';$('#main').innerHTML=v.full;}
 else{sideEl.style.display='';sideEl.className=S.side?'':'closed';sideEl.innerHTML=side();$('#main').innerHTML=(S.side?'':`<button class="ib" style="position:absolute;left:10px;top:10px;z-index:5" title="展开侧栏" data-a="side">${ic('side')}</button>`)+v.main;rightEl.style.display=v.right?'':'none';rightEl.innerHTML=v.right||'';}
 const ov=S.overlay==='settings'?vSettings():S.overlay==='memory'?vMemory():S.overlay==='skills'?vSkills():S.overlay==='spend'?vSpend():'';
 let o=$('#ov');if(!o){o=document.createElement('div');o.id='ov';$('#app').appendChild(o);}o.innerHTML=ov;
 const corner=craftEdge('corner');
 for(const card of document.querySelectorAll('#main .page .card, #main .icard, #right .blk, #ov .sbody .in > .card')){
  card.insertAdjacentHTML('beforeend',corner);
 }
 $('#notes').innerHTML=NOTES[S.overlay||S.scene]||'';$('#notes').classList.toggle('on',S.notes);
 const ta=$('[data-in="draft"]');if(ta)ta.oninput=e=>{S.draft=e.target.value;const sd=$('.send:not(.stop)');if(sd){sd.classList.toggle('ready',!!S.draft);sd.disabled=!S.draft;}};
}
document.addEventListener('click',e=>{
 const t=e.target.closest('[data-a]');if(!t)return;
 const a=t.dataset.a,v=t.dataset.v;
 if(a==='close'){if(e.target.closest('[data-stop]')&&t.dataset.a==='close'&&t.classList.contains('scrim'))return;S.overlay=null;}
 else if(a==='go'){if(v==='home'&&t.matches('#side > .nav[data-v="home"]'))nextHomeQuoteSession();S.scene=v;S.overlay=null;if(v==='wizard')S.wz=0;}
 else if(a==='ov'){S.overlay=v;if(v==='settings'&&!S.setTab)S.setTab='通用';}
 else if(a==='space'){S.space=v;if(S.scene==='schedule'&&v==='wb')S.scene='home';}
 else if(a==='dark')S.dark=!S.dark;
 else if(a==='notes')S.notes=!S.notes;
 else if(a==='ed')S.ed=S.ed==='managed'?'open':'managed';
 else if(a==='side')S.side=!S.side;
 else if(a==='right')S.right=!S.right;
 else if(a==='rtab')S.rtab=v;
 else if(a==='context'){S.right=true;S.rtab='上下文';}
 else if(a==='rsection'){e.preventDefault();S.rClosed??={};S.rClosed[v]=!S.rClosed[v];}
 else if(a==='br')S.br=!S.br;
 else if(a==='wk')S.wk[v]=!(S.wk[v]??document.querySelector(`[data-a="wk"][data-v="${v}"]`).parentElement.classList.contains('open'));
 else if(a==='row')S.row[v]=!S.row[v];
 else if(a==='src')S.src=v==='1';
 else if(a==='ans')S.ans=v;
 else if(a==='approval-answer'){if(S.approvalAnswer)return;S.approvalAnswer=v;S.approvalHistoryOpen=false;}
 else if(a==='approval-history')S.approvalHistoryOpen=!S.approvalHistoryOpen;
 else if(a==='plan')S.plan=!S.plan;
 else if(a==='fill')S.draft=v;
 else if(a==='send'){if(S.draft){S.draft='';S.scene='chat';}}
 else if(a==='stab')S.setTab=v;
 else if(a==='theme'){const th=TH.find(x=>x.id===v);if(th.dark){S.night=v;S.dark=true;}else{S.day=v;S.dark=false;}}
 else if(a==='tog')S[v]=!S[v];
 else if(a==='set'){const k=t.dataset.k;if(k==='mode'){S.dark=v==='深色';}else if(k==='cloud')S.cloud=v==='云端';else S[k]=v;}
 else if(a==='day'){if(!v)return;S.selDay=+v;}
 else if(a==='wz')S.wz=Math.max(0,Math.min(5,S.wz+(+v)));
 const sc=$('#main .scroll'),keep=sc?sc.scrollTop:0,sb=$('.sbody'),keep2=sb?sb.scrollTop:0;
 render();
 if(['wk','row','src','ans','plan','rtab','approval-answer','approval-history'].includes(a)){const s2=$('#main .scroll');if(s2)s2.scrollTop=keep;}
 if(a==='approval-answer'||a==='approval-history')$('[data-a="approval-history"]')?.focus({preventScroll:true});
 if(['set','tog','theme'].includes(a)){const s3=$('.sbody');if(s3)s3.scrollTop=keep2;}
});
document.addEventListener('mousedown',e=>{if(e.target.classList&&e.target.classList.contains('scrim')){S.overlay=null;render();}});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&S.overlay){S.overlay=null;render();}});
setInterval(()=>{if(S.space==='wb'&&!S.draft){S.tip++;const ta=$('[data-in="draft"]');if(ta&&document.activeElement!==ta)ta.placeholder=TIPS[S.tip%TIPS.length];}},4500);
setInterval(()=>{if(S.scene==='chat'&&S.space==='bf'&&!S.ans&&S.ask>0){S.ask--;const el=$('.ask .tm');if(el)el.textContent=`${Math.floor(S.ask/60)}:${String(S.ask%60).padStart(2,'0')} 后按「先不算」继续`;}},1000);
const q=new URLSearchParams(location.search);
for(const k of ['scene','space','overlay','setTab','memTab','skTab','skSel','rtab','ed','day','night','approve','inboxEmpty'])if(q.get(k))S[k]=q.get(k);
if(q.get('dark'))S.dark=true;if(q.get('plan'))S.plan=true;if(q.get('motion')==='off')S.motion=false;if(q.get('wz'))S.wz=+q.get('wz');if(q.get('wzT'))S.wzT=q.get('wzT');if(q.get('notes'))S.notes=true;
render();
