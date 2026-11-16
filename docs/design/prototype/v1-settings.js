/* Settings: every group designed, nothing "as in 0.8.3". */
const tg=(on,k)=>`<span class="tg ${on?'on':''}" ${k?`data-a="tog" data-v="${k}"`:''}></span>`;
const seg=(opts,cur,k)=>`<span class="seg">${opts.map(o=>`<button class="${o===cur?'on':''}" ${k?`data-a="set" data-k="${k}" data-v="${o}"`:''}>${o}</button>`).join('')}</span>`;
const sel=(v,cls='')=>`<span class="sel ${cls}">${v}${ic('chev','width:13px;height:13px')}</span>`;
const num=(v,u)=>`<span class="num">${v}${u?` <small>${u}</small>`:''}</span>`;
const row=(l,c,o={})=>`<div class="row ${o.cls||''}"><div class="l">${l}${o.d?`<small class="${o.warn?'warn':''}">${o.d}</small>`:''}</div>${c||''}</div>`;
const sh=(t,extra='')=>`<div class="sh"><span class="bfm">${bf(14)}</span>${t}<span class="sp"></span>${extra}</div>`;
const card=h=>`<div class="card">${h}</div>`;
const GROUPS=[
 ['我与蝶君',[['通用','user'],['蝶君','spark'],['记忆','memory']]],
 ['工作',[['模型','hub'],['工作台','chat']]],
 ['应用',[['外观','brush'],['窗口与通知','window'],['数据与安全','shield']]],
 ['更多',[['归档与回收','arch'],['关于与更新','info'],['开发者选项','code']]],
];
const TITLES={通用:'通用',蝶君:'蝶君',记忆:'记忆',模型:'模型',工作台:'工作台',外观:'外观',窗口与通知:'窗口与通知',数据与安全:'数据与安全',归档与回收:'归档与回收',关于与更新:'关于与更新',开发者选项:'开发者选项'};
function sBody(t){
 const P={静:'嗯，都整理好了。还差一项，明天你确认就行。',暖:'辛苦啦！两份资料都整理好啦，还差一项明天等你看看，不急哦～',利落:'两份完成，1 项待你明天确认。',灵动:'两份资料已经乖乖排好队啦，只剩一位等你明天点名～'};
 switch(t){
 case '通用':return `${sh('你')}${card(`<div class="row"><span class="av" style="width:52px;height:52px;font-size:20px">周</span><div class="l">称呼<small>蝶君和工作台都这样叫你</small></div><span class="num" style="min-width:180px;justify-content:flex-start">小周</span></div>
  ${row('关于你',null,{d:'',cls:'col'}).replace('</div></div>','</div><div class="inset" style="font-size:13px;color:var(--ink2)">读研二，做环境传感器方向的毕设；写东西喜欢简洁，数字带单位。</div></div>')}`)}
  ${sh('语音输入')}${card(`${row('识别方式',seg(['本机','云端'],S.cloud?'云端':'本机','cloud'),{d:S.cloud?'用阿里云百炼，需要填 Key':'声音不出这台电脑，不花钱'})}
  ${S.cloud?row('服务',sel('阿里云百炼'),{cls:'sub'})+row('Key',`<span class="num" style="min-width:200px">sk-•••••••• <small>改</small></span>`,{cls:'sub'}):''}
  ${row('快捷键','<span><span class="keycap">Ctrl</span> <span class="keycap">Shift</span> <span class="keycap">M</span></span>',{d:'按一次开始说，再按一次结束'})}`)}
  ${sh('界面')}${card(`${row('文字大小',seg(['−2','−1','标准','+1','+2'],'标准'))}${row('界面缩放',seg(['90%','100%','110%','125%'],'100%'),{d:'也可以按 Ctrl + 加号 / 减号'})}`)}`;
 case '外观':{
  const tc=x=>{const v=x.v||{};const bg=v.bg||(x.dark?'#26221E':'#F7F3EB'),ink=v.ink||(x.dark?'#F0E5D6':'#392F2A'),ac=v.accent||(x.dark?'#E6A17A':'#A54C28');const cur=x.dark?S.night:S.day;
   return `<div class="tcard ${cur===x.id?'on':''}" style="background:${bg};color:${ink}" data-art="${x.id}" data-a="theme" data-v="${x.id}"><i class="tmotif">${motif(x.id)}</i><b>${x.name}${x.isNew?' <span style="font:500 10px var(--sans);color:'+ac+'">新</span>':''}</b><span style="color:${ac}">${x.work}</span></div>`;};
  return `${sh('明暗')}${card(row('明暗',seg(['浅色','深色','跟随系统'],S.dark?'深色':'浅色','mode'),{d:'跟随系统时，白天和夜里各用下面选的主题'}))}
  ${sh('白天的主题','<small>点一下马上换</small>')}<div class="tgrid">${TH.filter(x=>!x.dark).map(tc).join('')}</div>
  ${sh('夜里的主题')}<div class="tgrid">${TH.filter(x=>x.dark).map(tc).join('')}</div>
  ${sh('纸')}${card(`<div class="prev">昔者庄周梦为胡蝶，栩栩然胡蝶也。</div>${row('纸质纹理',seg(['关','宣纸','棉纸','细颗粒'],'宣纸'),{d:'给背景和卡片加一点纸的质感'})}${row('纹理强度','<input type="range" min="0" max="10" value="5" style="width:180px;accent-color:var(--accent)">',{cls:'sub'})}${row('蝴蝶动起来',tg(S.motion,'motion'),{d:'等回复时扇翅、呼吸。关掉后装饰和蝴蝶都静止'})}`)}`;}
 case '窗口与通知':return `${sh('窗口')}${card(`${row('关窗口时',seg(['缩到托盘','退出'],'缩到托盘'),{d:'缩到托盘时，蝶君的事继续做'})}${row('开机启动',tg(false))}${row('只开一个窗口',tg(true),{d:'再次双击图标时，把已有窗口调到前面'})}`)}
  ${sh('通知')}${card(`${row('系统通知',tg(true))}${row('蝶君做完了',tg(true),{cls:'sub'})}${row('蝶君卡住、等你决定',tg(true),{cls:'sub'})}${row('工作台要你批准',tg(true),{cls:'sub'})}${row('工作台回复完了',sel('窗口不在前面时','short'),{cls:'sub'})}`)}`;
 case '蝶君':return `${sh('性格')}${card(`<div class="pcards">${Object.keys(P).map(k=>`<button class="pcard ${S.persona===k?'on':''}" data-a="set" data-k="persona" data-v="${k}"><b>${k}</b><p>${{静:'安静可靠，话少',暖:'亲切，关心你',利落:'只说结论和下一步',灵动:'活泼，爱用比喻'}[k]}</p></button>`).join('')}</div><div class="bubbles"><span class="q">资料整理得怎么样了？</span><span class="r">${P[S.persona]}</span></div>`)}
  ${sh('主动')}${card(`${row('主动性',seg(['低','中','高'],S.pro,'pro'),{d:{低:'只做你交代的事和规则命中的事',中:'再按你给的长期目标自己往前推',高:'再加空闲时自己学、写技能，有发现会来找你聊，每天最多 5 次'}[S.pro]})}${row('自己做事每天最多花',num('$0.50'),{d:'到了就停，第二天再接着做'})}${row('夜间不打扰',tg(S.night23,'night23'),{d:'这段时间不来找你，你让它提醒的事除外'})}${S.night23?row('开始',`<span class="num">23:00 ${ic('clock','width:13px;height:13px;color:var(--muted)')}</span>`,{cls:'sub'})+row('结束',`<span class="num">07:30 ${ic('clock','width:13px;height:13px;color:var(--muted)')}</span>`,{cls:'sub'}):''}`)}
  ${sh('长期目标','<a class="lk" style="font-size:13px;font-weight:400">+ 加一个</a>')}${card(`${row('把传感器选型的门道摸清楚',tg(true),{d:'空闲时自己学 · 上次 昨天 23:10'})}${row('熟悉 GB/T 7714 的细节',tg(false),{d:'暂停了'})}`)}
  ${sh('规则','<a class="lk" style="font-size:13px;font-weight:400">+ 加一条</a>')}${card(`${[['工作日 9 点整理新纪要','观察'],['「资料/论文」有新 PDF 时做摘要','自动'],['每周五提醒备份','关']].map(([t,v])=>row(t,seg(['关','观察','自动'],v))).join('')}`)}
  ${sh('日程与巡检')}${card(`${row('巡检',tg(true),{d:'定时看一眼有没有要做的事，没事只记一句「无需行动」'})}${row('多久一次',seg(['15 分钟','30 分钟','1 小时'],'30 分钟'),{cls:'sub'})}${row('提醒到点时',sel('系统通知','short'))}${row('错过的日程',seg(['补做一次','跳过'],'补做一次'))}`)}
  ${sh('沙箱','<span class="tag">已就绪</span>')}${card(`${row('蝶君沙箱',`<span class="acts"><button class="btn">自检</button><button class="btn warn">重置</button></span>`,{d:'蝶君在这台电脑上一个隔离的 Linux 里干活，碰不到你的系统 · 占用 2.1 GB'})}${row('允许联网',tg(true),{d:'按下马上生效'})}${row('单次最多轮数',num(40),{d:'没人看着时，一件事最多走这么多步'})}`)}`;
 case '记忆':return `<div class="banner" style="margin-top:4px"><div style="flex:1"><span class="t poetic">梦君记</span><small>214 条记忆 · 这周新记住 3 条</small></div><button class="btn pri" data-a="ov" data-v="memory">打开记忆</button></div>
  ${card(`${row('自动记忆',tg(true),{d:'聊天时它自己判断什么值得记'})}${row('记住前问我',tg(false),{cls:'sub',d:'每条新记忆先给你看一眼'})}${row('暂停整理',tg(false),{cls:'sub'})}`)}
  ${sh('记多少')}${card(`${row('详细程度',seg(['简要','标准','详细'],'标准'))}${row('什么时候记',seg(['每次回复后','换任务或关闭时'],'每次回复后'))}${row('每次带上的记忆',num('2,000','token'),{d:'越多越懂你，也越贵'})}${row('记忆容量',num('40,000','token'),{d:'满了以后先忘掉最久没用的'})}${row('每天整理预算',num('$0.20'))}`)}`;
 case '模型':{
  const m=(l,v,d)=>row(l,sel(v),{d});
  const chains=[['日常',[['ok','ChatGPT · GPT-6.1 Sol'],['ok','OpenCode Go · DeepSeek V4.1'],['wait','智谱 · GLM-4.6']]],['看图',[['ok','智谱 · GLM-4.6V'],['off','OpenRouter · Qwen3-VL']]]];
  const col={ok:'var(--ok)',wait:'var(--ochre)',off:'var(--muted)'};
  return `${S.ed==='managed'?`${sh('模型池')}${card(`${row('提供方','<span>梦蝶模型池</span>')}${row('本月额度',`<span style="width:180px"><div class="meter" style="height:6px"><i style="width:72%"></i></div><small style="color:var(--muted);font-size:12px">还剩 72% · 12 月 1 日恢复</small></span>`)}${row('激活码',`<span class="num">MENG-7Q4K-•••• <small>换一个</small></span>`)}${row('数据怎么处理','<a class="lk">查看</a>')}`)}`:''}
  ${sh('用哪个模型')}${card(`${m('对话','DeepSeek V4.1 Flash · OpenCode Go','聊天和工作台默认用它')}${m('小任务','跟对话一样','起标题、整理记忆')}${m('大任务','日常（模型组）','整理上下文、深度分析')}${m('看图','看图（模型组）','对话模型看不了图时用它')}${row('思考深度',seg(['自动','低','中','高','最高'],'自动'))}`)}
  ${S.ed==='managed'?'':`${sh('模型组','<a class="lk" style="font-size:13px;font-weight:400">+ 新建模型组</a>')}<div class="sdesc">排在前面的用不了，自动换下一个</div>${card(chains.map(([n,c])=>`<div class="lrow">${ic('more','color:var(--muted);transform:rotate(90deg)')}<div class="w">${n}<div class="chain">${c.map(([s,t],i)=>`${i?'→':''}<span><i style="background:${col[s]}"></i>${t}</span>`).join(' ')}</div></div>${ic('right','color:var(--muted)')}</div>`).join(''))}
  ${sh('渠道','<a class="lk" style="font-size:13px;font-weight:400">+ 添加渠道</a>')}${card([['ChatGPT','订阅 · 已登录 · 43 个模型','ok'],['OpenCode Go','按量 · 12 个模型','ok'],['智谱','编程套餐 · 额度用完，12:00 恢复','wait'],['OpenRouter','按量 · 密钥无效','bad']].map(([n,d,s])=>`<div class="lrow"><span class="sd" style="background:${{ok:'var(--ok)',wait:'var(--ochre)',bad:'var(--seal)'}[s]}"></span><div class="w">${n}<small>${d}</small></div>${ic('right','color:var(--muted)')}</div>`).join(''))}`}`;}
 case '工作台':return `${sh('工作区')}${card(`<div class="row col"><div class="l">默认工作区<small>新对话在这个文件夹里读写文件、执行命令</small></div><div style="display:flex;gap:8px"><div class="path" style="flex:1">E:\\毕设\\传感器数据</div><button class="btn">更换</button></div></div>
  ${row('操作前问我',seg(['修改与命令','每次操作','不询问'],S.approve,'approve'),{d:{修改与命令:'读文件和搜索直接做，改文件、跑命令先问你',每次操作:'每一步都先问你',不询问:'全部直接做，适合你盯着的时候'}[S.approve],warn:S.approve==='不询问'})}
  <div class="row col"><div class="l">总是允许的操作</div><div class="inset">还没有。比如：允许运行 npm test。在批准卡上点「这个对话里都允许」时会加到这里</div></div>`)}
  ${sh('对话')}${card(`${row('默认模式',seg(['标准','极简'],'标准'),{d:'极简模式只给它读写文件和跑命令'})}${row('自动起标题',tg(true))}${row('自动整理上下文',tg(true),{d:'对话太长时把前面的压成摘要'})}${row('用到多少时整理',num('80','%'),{cls:'sub'})}${row('后台整理',seg(['自动','开启','关闭'],'自动'),{cls:'sub'})}${row('它提问时等多久',seg(['30 秒','1 分钟','5 分钟','一直等'],'1 分钟'),{d:'到时间按默认选项继续'})}${row('单次最多轮数',num(60))}${row('空闲对话保留',num(10,'分钟'),{d:'过了这个时间先放下，回来时再接上'})}`)}
  ${sh('花费上限')}${card(`${row('每天',num('$3.00'),{d:'到了就停，等你点头再继续'})}${row('每月',num('$40.00'))}`)}
  ${sh('网络')}${card(`${row('联网搜索',sel('自动'),{d:'按下面的顺序试，前一个不行换下一个'})}<div class="row col"><div class="inset" style="padding:4px 12px">${['博查','Tavily','DuckDuckGo'].map(n=>`<div class="lrow" style="padding:7px 0">${n}<span class="sp" style="flex:1"></span><button class="ib" title="往上">${ic('up2','width:13px;height:13px')}</button><button class="ib" title="往下">${ic('down2','width:13px;height:13px')}</button></div>`).join('')}</div></div>${row('软件源',sel('清华镜像'),{d:'装 Python、Node 包时从这里下'})}${row('代理',sel('跟随系统'))}`)}`;
 case '数据与安全':return `${sh('数据位置')}${card(`<div class="row col"><div class="l">数据目录<small>对话、记忆、设置都在这里 · 3.4 GB</small></div><div style="display:flex;gap:8px"><div class="path" style="flex:1">E:\\DreamFlutter\\data</div><button class="btn">打开</button><button class="btn">搬到别处</button></div></div>
  <div class="row col"><div style="display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--sunk)"><i style="width:42%;background:var(--accent)"></i><i style="width:24%;background:var(--ochre)"></i><i style="width:12%;background:var(--ok)"></i></div><div style="display:flex;gap:14px;font-size:12px;color:var(--muted)"><span><i class="sd" style="background:var(--accent)"></i> 蝶君沙箱 2.1 GB</span><span><i class="sd" style="background:var(--ochre)"></i> 对话 0.8 GB</span><span><i class="sd" style="background:var(--ok)"></i> 记忆 0.4 GB</span></div></div>`)}
  ${sh('备份','<button class="btn" style="font-weight:400">立即备份</button>')}${card(`${row('自动备份',seg(['每天','每周','关'],'每天'),{d:'只留最近 7 份'})}${[['今天 03:00','自动 · 412 MB'],['昨天 03:00','自动 · 409 MB'],['11月10日 21:14','手动 · 398 MB']].map(([t,d])=>`<div class="lrow"><div class="w">${t}<small>${d}</small></div><button class="btn">恢复</button><button class="ib" title="在文件夹中显示">${ic('folder','width:14px;height:14px')}</button></div>`).join('')}`)}
  ${sh('敏感路径')}${card(`<div class="row col"><div class="l">不让它碰的地方<small>这些位置读写前一律先问你，就算你选了「不询问」</small></div><div class="inset" style="color:var(--ink2)">C:\\Windows · 用户目录下的 .ssh、.aws · 浏览器的密码文件</div></div>${row('操作记录',`<button class="btn">查看</button>`,{d:'每次读写敏感位置都记一笔'})}`)}
  ${sh('卸载')}${card(row('卸载 DreamFlutter',`<button class="btn warn">卸载…</button>`,{d:'会先问你要不要保留数据'}))}`;
 case '归档与回收':return `${sh('已归档','<small>4 个</small>')}${card([['参考文献格式统一成 GB/T 7714','论文写作 · 11月10日'],['实验数据画成箱线图','毕设-传感器数据 · 11月8日']].map(([t,d])=>`<div class="lrow"><div class="w">${t}<small>${d}</small></div><button class="btn">放回</button></div>`).join(''))}
  ${sh('回收站','<a class="lk" style="font-size:13px;font-weight:400;color:var(--seal)">清空</a>')}<div class="sdesc">删掉的对话在这里留 30 天</div>${card([['问一下：pandas 怎么读 xlsx','11月12日删除 · 还剩 28 天']].map(([t,d])=>`<div class="lrow"><div class="w">${t}<small>${d}</small></div><button class="btn">恢复</button><button class="btn warn">彻底删除</button></div>`).join(''))}`;
 case '关于与更新':return `<div class="about">${bf(72,'float')}<div class="wm">DreamFlutter</div><p>住在你电脑里的助手，一只认真的蝴蝶。</p><code>v1.0.0 · 2026-12</code><p style="margin-top:8px;color:var(--muted);font-size:12.5px">已是最新 · 上次检查 今天 09:12</p><div class="acts" style="justify-content:center;margin-top:10px"><button class="btn">检查更新</button><button class="btn">更新历史</button></div></div>
  ${card(`${row('自动检查更新',tg(true))}${row('接收测试版',tg(false))}${row('导出诊断',`<button class="btn">导出…</button>`,{d:'不含对话内容，导出前可以先看一遍'})}${row('反馈问题','<a class="lk">写给我们</a>')}${row('许可证','<span style="color:var(--muted)">开源许可 · 查看</span>')}`)}`;
 case '开发者选项':return `${sh('原有连接配置')}${card(`${row('从别处导入',`<span class="acts"><button class="btn">models.json</button><button class="btn">cc-switch</button></span>`,{d:'把 Pi 或 cc-switch 里配好的服务商搬过来'})}`)}
  ${sh('实验')}${card(`${row('后台整理上下文',tg(true),{d:'整理时不打断对话 <span class="tags">· Beta · 低风险 · 新对话生效</span>'})}${row('更积极地派子任务',tg(false),{d:'大范围查找交给子任务，主对话更专注 <span class="tags">· Alpha · 中风险 · 新对话生效</span>'})}`)}
  ${sh('版本细节')}${card(`${[['构建号','1.0.0+20261201.1'],['后台','core 1.0.0 · Node 22.23'],['Pi','0.62.1'],['平台','Windows 11 x64'],['签名','已签名']].map(([k,v])=>row(k,`<code style="font-family:var(--mono);font-size:12.5px;color:var(--ink2)">${v}</code>`)).join('')}`)}`;
 }
 return '';
}
function vSettings(){
 const q=S.sq||'';
 const nav=GROUPS.map(([g,items])=>`<div class="sgh">${g}</div>${items.map(([n,i])=>`<button class="sni ${S.setTab===n?'on':''}" data-a="stab" data-v="${n}">${ic(i)}${n}</button>`).join('')}`).join('');
 return `<div class="scrim" data-a="close"><div class="panel" data-stop="1"><div class="snav"><div class="ssearch">${ic('search','width:14px;height:14px')}<input placeholder="搜索设置" value="${esc(q)}"></div>${nav}</div>
 <div class="sbody"><button class="ib x" title="关闭（Esc）" data-a="close">${ic('x')}</button><div class="in"><div class="sttl">${TITLES[S.setTab]}</div>${sBody(S.setTab)}</div></div></div></div>`;
}
