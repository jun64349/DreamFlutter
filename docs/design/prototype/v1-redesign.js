/* DreamFlutter full redesign prototype (2026-11-14). Plain JS, no build step. */
const ICON={
 plus:'<path d="M12 5v14M5 12h14"/>',search:'<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
 inbox:'<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
 memory:'<path d="M12 3a6 6 0 0 0-4 10.5V17h8v-3.5A6 6 0 0 0 12 3z"/><path d="M9.5 21h5"/>',
 skills:'<path d="M14.5 3.5 20.5 9.5 9.5 20.5H3.5v-6z"/><path d="m12 6 6 6"/>',
 coin:'<circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .9-3 2s1.3 1.7 3 2 3 .9 3 2-1.3 2-3 2c-1.4 0-2.5-.5-3-1.5M12 6v2M12 16v2"/>',
 gear:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
 panel:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',side:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
 chev:'<path d="m6 9 6 6 6-6"/>',up:'<path d="m6 15 6-6 6 6"/>',right:'<path d="m9 6 6 6-6 6"/>',left:'<path d="m15 6-6 6 6 6"/>',
 more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
 attach:'<path d="m21 11-8.6 8.6a5 5 0 0 1-7-7l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l8-8"/>',
 send:'<path d="M12 19V5M5 12l7-7 7 7"/>',stop:'<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
 check:'<path d="M20 6 9 17l-5-5"/>',x:'<path d="M18 6 6 18M6 6l12 12"/>',
 file:'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
 folder:'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
 branch:'<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
 cal:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
 mic:'<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
 clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',term:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
 eye:'<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
 edit:'<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',copy:'<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
 refresh:'<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
 shield:'<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/>',spark:'<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
 think:'<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z"/>',
 globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
 db:'<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
 info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',code:'<path d="m8 8-4 4 4 4M16 8l4 4-4 4"/>',
 arch:'<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9M10 13h4"/>',
 user:'<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',chat:'<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
 hub:'<circle cx="12" cy="12" r="3"/><circle cx="4" cy="6" r="2"/><circle cx="20" cy="6" r="2"/><circle cx="12" cy="21" r="2"/><path d="m6 7 4 3M18 7l-4 3M12 15v4"/>',
 brush:'<path d="M18 3l3 3-9.5 9.5-3-3z"/><path d="M8.5 12.5C6 13 4 15 4 18c0 1.5-1 2-2 2 2 1.5 6 1.5 8-1 1.2-1.5 1.5-3 1.5-3.5"/>',
 window:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',bell:'<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4"/>',
 lock:'<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',key:'<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3"/>',
 trash:'<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',up2:'<path d="M12 19V5M6 11l6-6 6 6"/>',down2:'<path d="M12 5v14M6 13l6 6 6-6"/>',
 filter:'<path d="M3 5h18l-7 9v5l-4 2v-7z"/>',sort:'<path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/>',
 flag:'<path d="M5 21V4h11l-1.5 4L16 12H5"/>',pause:'<path d="M8 5v14M16 5v14"/>',play:'<path d="m7 4 13 8-13 8z"/>',
 sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
 leaf:'<path d="M5 19c8 0 14-6 14-14C11 5 5 11 5 19zM5 19l8-8"/>',mood:'<path d="M12 3c2 3 6 4 6 9a6 6 0 0 1-12 0c0-5 4-6 6-9z"/>',
};
const ic=(n,s='')=>{
 const family=document.documentElement.dataset.craft||'curved';
 const themed=CRAFT_ICONS[family]?.[n];
 const type=themed?(n==='stop'?' craft-solid':family==='angular'?' craft-angular':''):'';
 return `<svg class="ic${type}" viewBox="0 0 24 24" ${s?`style="${s}"`:''} aria-hidden="true">${themed||ICON[n]||''}</svg>`;
};
const bf=(sz=24,cls='')=>`<span class="bf ${cls}" style="width:${sz}px;height:${sz}px"><svg viewBox="0 0 1024 1024"><use href="#bf"/></svg></span>`;
const $=s=>document.querySelector(s);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* ---------- painting themes (live) ---------- */
const TH=[
 {id:'warm',name:'暖纸',work:'默认 · 白天',ins:'栩栩然胡蝶也'},
 {id:'jiadie',name:'蛱蝶',work:'赵昌《写生蛱蝶图》',ins:'栩栩然胡蝶也',v:{bg:'#F3ECDD',side:'#EDE4D1',card:'#FAF6EC',ink:'#2B2620',ink2:'#4E4537',muted:'#7D725F',line:'#DDD2BC',accent:'#3F6E5E','accent-soft':'rgba(63,110,94,.11)','bf-wing':'#5E8F7C','bf-glow':'#D9E6DC'}},
 {id:'caodie',name:'草蝶',work:'梵高《开花的长草与蝴蝶》',ins:'Long Grass with Butterflies',lat:1,v:{bg:'#F6F7EC',side:'#E9ECD9',card:'#FFFFFB',ink:'#1F281B',ink2:'#3E4A37',muted:'#6B7763',line:'#DCE0C8',accent:'#3C6B32','accent-soft':'rgba(60,107,50,.11)','bf-wing':'#C9B53C','bf-glow':'#EEE8B8'},r:'18px'},
 {id:'yuhua',name:'羽化',work:'梅里安《苏里南昆虫变态图谱》',ins:'Metamorphosis insectorum',lat:1,v:{bg:'#F7F3E9',side:'#EDE6D4',card:'#FFFFFF',ink:'#241E19',ink2:'#463C32',muted:'#776B5D',line:'#DED4C0',accent:'#18649A','accent-soft':'rgba(24,100,154,.10)','bf-wing':'#2F7CB4','bf-glow':'#D3E3EF'},r:'4px'},
 {id:'shensi',name:'神思',work:'多西《朱庇特、墨丘利与美德》',ins:'Silentium',lat:1,v:{bg:'#F7F2E7',side:'#EDE5D3',card:'#FFFDF8',ink:'#29211B',ink2:'#4B4037',muted:'#7A6D60',line:'#E0D5C2',accent:'#9C3328','accent-soft':'rgba(156,51,40,.10)','bf-wing':'#B8923C','bf-glow':'#F0E2C0'},r:'8px'},
 {id:'qiandie',name:'千蝶',work:'神坂雪佳《蝶千种》',ins:'蝶千種',isNew:1,v:{bg:'#FAF7F0',side:'#EFEADF',card:'#FFFFFF',ink:'#242220',ink2:'#45413C',muted:'#78726A',line:'#E3DDD0',accent:'#C24C38','accent-soft':'rgba(194,76,56,.10)','bf-wing':'#C7A242','bf-glow':'#F2E6C2'},r:'10px'},
 {id:'muse',name:'暮色',work:'默认 · 夜里',dark:1,ins:'栩栩然胡蝶也'},
 {id:'moye',name:'墨夜',work:'赵昌《写生蛱蝶图》，灯下',dark:1,ins:'栩栩然胡蝶也',v:{bg:'#211E19',side:'#1B1814',card:'#2A2620',ink:'#ECE3D2',ink2:'#CFC4AE',muted:'#A0947D',line:'#3E372D',accent:'#86B8A6','accent-soft':'rgba(134,184,166,.14)','bf-wing':'#86B8A6','bf-glow':'#2E3F38','on-accent':'#211E19'}},
 {id:'youhua',name:'幽华',work:'德·黑姆的花卉静物',dark:1,ins:'Vanitas',lat:1,v:{bg:'#131517',side:'#181B1E',card:'#1F2328',ink:'#EDE7DD',ink2:'#CFC8BC',muted:'#9399A0',line:'#30353B',accent:'#E2676A','accent-soft':'rgba(226,103,106,.14)','bf-wing':'#E2676A','bf-glow':'#3A2426','on-accent':'#131517'},r:'12px'},
 {id:'liuguang',name:'琉光',work:'蒂芙尼工作室蝴蝶台灯',dark:1,ins:'Tiffany Studios',lat:1,v:{bg:'#171513',side:'#1D1A17',card:'#28241F',ink:'#F2EAE0',ink2:'#D4CABC',muted:'#A39B8F',line:'#3B352E',accent:'#E09F3E','accent-soft':'rgba(224,159,62,.15)','bf-wing':'#E09F3E','bf-glow':'#3B2E1A','on-accent':'#171513'},r:'16px'},
 {id:'huandie',name:'幻蝶',work:'雷东《蝴蝶》',dark:1,isNew:1,ins:'Papillons',lat:1,v:{bg:'#121721',side:'#161C28',card:'#1E2635',ink:'#EEF3FA',ink2:'#C9D3E3',muted:'#8E9BB4',line:'#2C3547',accent:'#38B8B0','accent-soft':'rgba(56,184,176,.14)','bf-wing':'#A86ECC','bf-glow':'#26304A','on-accent':'#121721'},r:'18px'},
 {id:'shiqing',name:'石青',work:'清同治 平金百蝶坎肩',dark:1,isNew:1,ins:'百蝶翩跹',v:{bg:'#141A21',side:'#18202A',card:'#202A36',ink:'#F2EDE4',ink2:'#D2CCC0',muted:'#97A2B0',line:'#2F3A48',accent:'#D4AF37','accent-soft':'rgba(212,175,55,.14)','bf-wing':'#D4AF37','bf-glow':'#3A3420','on-accent':'#141A21'},r:'10px'},
];
function applyTheme(){
 const t=TH.find(x=>x.id===(S.dark?S.night:S.day));
 const root=document.documentElement;root.dataset.theme=S.dark?'dark':'light';
 root.dataset.art=t?t.id:'warm';root.dataset.motion=S.motion?'on':'off';
 root.dataset.craft=CRAFT_ANGULAR_ART.has(root.dataset.art)?'angular':'curved';
 root.removeAttribute('style');
 if(t&&t.v)for(const[k,v]of Object.entries(t.v))root.style.setProperty('--'+k,v);
 if(t&&t.r)root.style.setProperty('--r',t.r);
}
const curTheme=()=>TH.find(x=>x.id===(S.dark?S.night:S.day));
const craftEdge=place=>`<span class="craft-ornament ${place}" aria-hidden="true">${craftOrnament(curTheme()?.id||'warm')}</span>`;

/* ---------- state ---------- */
const S={scene:'home',space:'wb',dark:false,day:'warm',night:'muse',right:true,side:true,notes:false,marks:false,
 overlay:null,setTab:'通用',memTab:'最近',skTab:'技能',skSel:'sk1',spendBy:'金额',
 wk:{},row:{},src:false,ans:null,plan:false,persona:'静',pro:'高',draft:'',tip:0,rtab:'文件',
 approvalAnswer:null,approvalHistoryOpen:false,
 wz:0,wzT:'',ed:'open',noModel:false,approve:'修改与命令',selDay:14,openEv:'e2',inboxEdit:false,ask:118,br:false,
 night23:true,cloud:false,mood:false,motion:true};

/* ---------- sidebar ---------- */
const CONVS_WB=[
 {g:'今天',t:'整理本周温湿度数据成周报',m:'10:12 · DeepSeek V4.1 Flash',id:'c1',kids:2},
 {t:'问一下：露点温度怎么算',m:'10:15 · DeepSeek V4.1 Flash',child:1,id:'c1a'},
 {t:'分支：换成 pandas 实现',m:'10:18 · DeepSeek V4.1 Flash',child:1,id:'c1b'},
 {g:'今天',t:'ESP32 MQTT 断线重连',m:'09:40 · DeepSeek V4.1',dot:'run',id:'c2'},
 {g:'更早',t:'第三章 文献综述润色',m:'11月12日 · DeepSeek V4.1 Flash',id:'c3'},
 {g:'更早',t:'参考文献格式统一成 GB/T 7714',m:'11月10日 · DeepSeek V4.1 Flash',id:'c4'},
 {g:'更早',t:'实验数据画成箱线图',m:'11月8日 · DeepSeek V4.1',id:'c5'},
];
const CONVS_BF=[
 {g:'今天',t:'整理三款温湿度传感器对比',m:'在推进 · 计划 2/5',dot:'run',id:'b1'},
 {g:'今天',t:'每天提醒吃药',m:'日程 · 下次 18:00',id:'b2'},
 {g:'更早',t:'学 Silero 语音检测',m:'暂停了',dot:'pause',id:'b3'},
 {g:'更早',t:'整理组会纪要模板',m:'卡住了 · 等你给文件夹',dot:'block',id:'b4'},
];
function side(){
 const wb=S.space==='wb',convs=wb?CONVS_WB:CONVS_BF;
 const on=S.scene==='chat'?(wb?'c1':'b1'):null;
 let g='',list='';
 for(const c of convs){if(c.child&&!S.br)continue;if(c.g&&c.g!==g){g=c.g;list+=`<div class="grp">${g}</div>`;}
  list+=`<div class="conv ${c.child?'child':''} ${c.id===on?'on':''}" data-a="go" data-v="chat">${c.id===on?craftEdge('selection'):''}${c.kids?`<button class="brt" title="${S.br?'收起分支':'展开分支（'+c.kids+'）'}" data-a="br">${ic(S.br?'chev':'right','width:12px;height:12px')}${S.br?'':`<em>${c.kids}</em>`}</button>`:''}${c.child?ic('branch','width:13px;height:13px;margin-top:3px;color:var(--muted)'):''}${c.dot?`<span class="dot ${c.dot}"></span>`:''}<div class="w"><div class="t">${c.t}</div><div class="m">${c.m}</div></div></div>`;}
 const t=curTheme();
 return `<div class="brand">${bf(24,'float')}<span class="wm">DreamFlutter</span><small>梦蝶</small><span class="sp"></span><button class="ib" title="收起侧栏（Ctrl + B）" data-a="side">${ic('side')}</button></div>
 <div class="space"><button class="${wb?'on':''}" data-a="space" data-v="wb">${wb?craftEdge('selection'):''}${ic('chat','width:14px;height:14px')}工作台</button><button class="${wb?'':'on'}" data-a="space" data-v="bf">${wb?'':craftEdge('selection')}${bf(15)}蝶君</button></div>
 <button class="nav ${S.scene==='home'?'on':''}" data-a="go" data-v="home">${ic('plus')}新对话</button>
 <button class="nav ${S.scene==='inbox'?'on':''}" data-a="go" data-v="inbox">${ic('inbox')}等你处理<span class="badge">4</span></button>
 ${wb?'':`<button class="nav ${S.scene==='schedule'?'on':''}" data-a="go" data-v="schedule">${ic('cal')}日程<span class="cnt">今天 5</span></button>`}
 <button class="nav ${S.overlay==='memory'?'on':''}" data-a="ov" data-v="memory">${ic('memory')}记忆<span class="cnt">新 3</span></button>
 <button class="nav ${S.overlay==='skills'?'on':''}" data-a="ov" data-v="skills">${ic('skills')}技能${'<span class="cnt"><span class="sd" style="background:var(--ochre)"></span></span>'}</button>
 <div style="height:14px;flex:none"></div>
 <div class="search">${ic('search','width:14px;height:14px')}搜索对话<span style="margin-left:auto;font-size:11px">Ctrl K</span></div>
 ${wb?`<div class="ws">${craftEdge('selection')}${ic('folder','color:var(--ochre)')}<span class="n">毕设-传感器数据</span>${ic('chev','width:14px;height:14px;color:var(--muted)')}</div>`:''}
 <div class="list">${list}</div>
 <div class="inscr ${t&&t.lat?'lat':''}">${t?t.ins:''}</div>
  <div class="foot"><span class="me"><span class="av">周</span>小周</span><button class="ib ${S.overlay==='spend'?'on':''}" title="花费" data-a="ov" data-v="spend">${ic('coin')}</button><button class="ib ${S.overlay==='settings'?'on':''}" title="设置（Ctrl + ,）" data-a="ov" data-v="settings">${ic('gear')}</button></div>
  ${craftEdge('side')}`;
}

/* ---------- composer ---------- */
const TIPS=['说点什么…','试试把一个表格文件拖进来','输入 / 用技能','想让蝶君替你盯着一件事？切到蝶君说','Shift + Enter 换行'];
function composer(o={}){
 const wb=S.space==='wb',has=!!S.draft;
 const running=o.running;
 return `<div class="composer"><textarea rows="1" placeholder="${o.ph||TIPS[S.tip%TIPS.length]}" data-in="draft">${esc(S.draft)}</textarea>
 <div class="crow">
  <button class="ib" title="加文件或图片">${ic('attach')}</button>
  ${wb?`<button class="pill" title="这次不保存、不记忆">${ic('eye','width:14px;height:14px')}无痕</button><button class="pill on" title="改文件、跑命令前问你">${ic('shield','width:14px;height:14px')}先问我</button>`:''}
  <span class="sp"></span>
  <button class="pill box" title="换模型">${S.ed==='managed'?'DeepSeek V4.1 Flash · 模型池':'DeepSeek V4.1 Flash · OpenCode Go'}${ic('chev','width:12px;height:12px')}</button>
  <button class="pill" title="思考深度">${ic('think','width:14px;height:14px')}中</button>
  <button class="context-ring" data-a="context" aria-label="${S.scene==='home'?'上下文尚未使用':'上下文已用 59k / 128k'}" title="${S.scene==='home'?'上下文尚未使用':'上下文已用 59k / 128k'}" style="--used:${S.scene==='home'?0:59/128}"><span></span></button>
  <button class="ib" title="说话（Ctrl + Shift + M）">${ic('mic')}</button>
  ${running?`<button class="send stop" title="停下这一步">${ic('stop','width:14px;height:14px')}</button>`:`<button class="send ${has?'ready':''}" title="发送（Enter）" data-a="send"${has?'':' disabled'}>${ic('send')}</button>`}
 </div></div>`;
}

/* ---------- home ---------- */
function vHome(){
 const wb=S.space==='wb';
 const quoteCulture=['warm','muse','jiadie','moye','shiqing'].includes(curTheme().id)?'zh':'en';
 const quote=currentHomeQuote(quoteCulture);
 const quoteHtml=quoteCulture==='zh'
  ? `${esc(quote[0])}<cite>${esc(quote[1])}</cite>`
  : `<span class="quote-en">${esc(quote[0])}</span><span class="quote-translation">${esc(quote[1])}</span><cite>${esc(quote[2])}</cite>`;
 const greet=wb?['晨安，小周','让念头，开始飞翔','今天也一起把事做完'][S.tip%3]:'交给我吧，你去忙别的';
 const ex=wb?['整理这个文件夹里的资料','帮我读懂这段代码','一起梳理今天的工作','对比这几份资料的差别','把这篇文章整理成摘要']:['每周一帮我整理上周的组会纪要','把这 30 篇文献统一成 GB/T 7714 格式','查一下三款温湿度传感器，列个对比表','把这份资料整理成摘要','明天下午三点提醒我交报告'];
 return {main:`<div class="top"><span class="sp"></span>${S.right?'':`<button class="ib" title="详情" data-a="right">${ic('panel')}</button>`}</div>
 <div class="scroll"><div class="home"><div class="wash"></div><div class="artmotif">${motif(curTheme().id)}</div>
  <div class="home-mark">${bf(104,'home-breathe')}</div>
  <div class="greet inkgreet">${greet}</div><div class="brush"></div>
  <div class="quote">${quoteHtml}</div>
  ${composer({ph:wb?undefined:'交代一件事，或者只是聊聊'})}
  <div class="chips">${ex.map(e=>`<button class="chip" data-a="fill" data-v="${esc(e)}">${e}</button>`).join('')}</div>
 </div></div>`,right:null};
}

/* ---------- conversation ---------- */
const P=(d,f)=>`<span class="p" title="${d}${f}"><span class="d">${d}</span><span class="f">${f}</span></span>`;
const OK=ic('check','width:13px;height:13px;color:var(--ok)');
function step(o){
 const open=o.id&&S.row[o.id];
 return `<div class="st ${o.cls||''}" ${o.body?`data-a="row" data-v="${o.id}" style="cursor:pointer"`:''}>${o.lead||`<span class="lead">${ic(o.icon,'width:14px;height:14px')}</span>`}<span>${o.verb}</span>${o.what||''}<span class="r">${o.right||''}${o.body?ic(open?'up':'chev','width:12px;height:12px'):''}</span></div>${open&&o.body?o.body:''}`;
}
function work(k,o){
 const open=S.wk[k]??o.open;
 return `<div class="wk ${open?'open':''} ${o.err?'err':''}"><button class="wk-h" data-a="wk" data-v="${k}">${o.mark}<span class="t">${o.title.replace(/^(思考[^·]*)(.*)$/, '<em>$1</em>$2')}</span>${o.err?`<span class="n bad">${o.err}</span>`:''}<span class="n">${o.n||''}</span>${ic(open?'up':'chev','width:13px;height:13px;color:var(--muted)')}</button>${open?`<div class="wk-b">${o.rows}</div>`:''}</div>`;
}
const think=(id,s,t)=>step({id,icon:'think',cls:'think',verb:`<em>思考 · ${s} 秒</em>`,body:`<div style="margin:0 12px 6px 34px;font-size:12.5px;color:var(--muted);font-style:italic;line-height:1.75">${t}</div>`});
const read=(d,f,t)=>step({icon:'file',verb:'读取',what:P(d,f),right:`${t}${OK}`});
function reply(body,facts,o={}){
 return `<div class="a ${o.active?'active':''} ${o.process?'process':''}"><span class="mk">${bf(22,o.active?'flap':'')}</span>${o.pre||''}<div class="body">${body}</div>${facts?`<div class="facts">${facts}<span class="acts"><button class="ib" title="复制">${ic('copy','width:14px;height:14px')}</button><button class="ib" title="重新生成">${ic('refresh','width:14px;height:14px')}</button><button class="ib" title="从这里重来">${ic('branch','width:14px;height:14px')}</button><button class="ib" title="它参考了哪些记忆">${ic('memory','width:14px;height:14px')}</button><button class="ib" title="更多">${ic('more','width:14px;height:14px')}</button></span></div>`:''}</div>`;
}
function vChat(){
 return S.space==='wb'?vChatWb():vChatBf();
}
function approvalCard(answer){
 const actions=answer
  ? `<div class="why" style="margin:8px 0 0;color:${answer==='拒绝'?'var(--muted)':'var(--accent)'}">${answer==='拒绝'?'已拒绝':'已允许'}</div>`
  : `<div class="acts"><button class="btn pri" data-a="approval-answer" data-v="允许">允许</button><button class="btn" data-a="approval-answer" data-v="拒绝">拒绝</button><button class="btn line" data-a="approval-answer" data-v="这个对话里都允许这类操作">这个对话里都允许这类操作</button></div>`;
 return `<div class="approve"><h4>${ic('shield')}修改 reports/周报-W45.md</h4><div class="why">把结论压成两句（+2 −5）</div><div class="diff"><div class="de">-这周室内温度整体平稳，周三那场雨让夜里的湿度连续超限……</div><div class="ad">+温度平稳；周三夜里湿度超限 14 次。</div><div class="ad">+实验柜注意防潮。</div></div>${actions}</div>`;
}
function vChatWb(){
 const w1=work('w1',{open:false,mark:OK,title:'思考了 6 秒 · 读取 3 个文件 · 运行 1 条命令 · 修改 1 个文件',n:'3.5 秒',rows:[
  think('t1',4,'raw 下按月分文件夹，11 月的文件名带周次。周三下过雨，湿度会有一段明显升高，要单独标出来。'),
  read('data/raw/2026-11/','传感器-温湿度-第45周.csv','0.2 秒'),read('data/raw/2026-11/','1110.csv','0.1 秒'),read('reports/','周报-W44.md','0.1 秒'),
  step({id:'c1',icon:'term',verb:'运行',what:`<span class="p"><span class="f">python scripts/summary.py --week 45</span></span>`,right:`3.1 秒${OK}`,body:`<div class="code" style="margin:2px 12px 6px 34px"><pre>读取 7 天 · 2016 条记录\n平均温度 22.4 ℃，湿度 61.8 %\n周三 19:00–次日 06:00 湿度超限 14 次</pre></div>`}),
  step({id:'e1',icon:'edit',verb:'修改',what:P('reports/','周报-W45.md'),right:`<span class="ok">+12</span><span class="bad">−1</span>${OK}`,body:`<div class="diff" style="margin:2px 12px 6px 34px"><div> 温度：22.4 ℃（+0.6）</div><div class="de">-湿度：待补充</div><div class="ad">+湿度：61.8 %，周三夜间 14 次超限</div></div>`})].join('')});
 const body1=`<p>W45 周报写好了。这周室内温度整体平稳，周三那场雨让夜里的湿度连续超限，露点接近 18 ℃，实验柜要注意防潮。</p>
 <table><tr><th>指标</th><th>本周</th><th>上周</th></tr><tr><td>平均温度</td><td>22.4 ℃</td><td>21.8 ℃</td></tr><tr><td>平均湿度</td><td>61.8 %</td><td>55.2 %</td></tr><tr><td>湿度超限</td><td>14 次</td><td>3 次</td></tr></table>
 <blockquote>超限都集中在 19:00 以后，和下雨的时间对得上。</blockquote>`;
 const pendingApproval=!S.approvalAnswer;
 const approval=pendingApproval
  ? work('w2',{open:true,mark:'<span class="bdot"></span>',title:'等你批准：修改 reports/周报-W45.md',n:'前面 1 步',rows:[read('reports/','周报-W45.md','0.1 秒'),step({icon:'edit',verb:'修改',what:P('reports/','周报-W45.md'),right:'<span style="color:var(--ochre)">等你批准</span>'})].join('')})+approvalCard()
  : `<button class="btn line" data-a="approval-history" aria-expanded="${S.approvalHistoryOpen}">${ic(S.approvalHistoryOpen?'up':'chev','width:13px;height:13px')}已处理 1 项审批</button>${S.approvalHistoryOpen?approvalCard(S.approvalAnswer):''}`;
 return {main:`<div class="top"><span class="ttl">整理本周温湿度数据成周报</span><span class="meta">毕设-传感器数据 · 记忆开</span><span class="sp"></span><button class="btn line" title="从当前位置分出一个新对话">${ic('branch','width:14px;height:14px')}分支</button>${S.right?'':`<button class="ib" title="详情" data-a="right">${ic('panel')}</button>`}</div>
 <div class="scroll"><div class="chat">
  <div class="u"><div class="b">把 data/raw 里这周的温湿度数据整理成周报，结论写进 reports/周报-W45.md</div></div>
  ${reply(body1,'DeepSeek V4.1 Flash · 62 字/秒 · 38 秒 · 10:12',{pre:w1})}
  <div class="u"><div class="b">再画个图说明数据怎么流到周报，顺便给我汇总脚本的核心部分</div></div>
  ${reply(`<p>数据一共走四步：</p>
   <div class="code"><div class="h">Mermaid 图<span class="sp"></span><span class="seg"><button class="${S.src?'':'on'}" data-a="src" data-v="0">图</button><button class="${S.src?'on':''}" data-a="src" data-v="1">源码</button></span><button class="ib" title="复制源码">${ic('copy','width:14px;height:14px')}</button><button class="ib" title="放大">${ic('eye','width:14px;height:14px')}</button></div>
   ${S.src?`<pre>flowchart LR\n  A[网关导出 CSV] --> B[data/raw/2026-11]\n  B --> C[summary.py 汇总]\n  C --> D[周报-W45.md]</pre>`:`<div style="padding:10px 14px 16px"><svg viewBox="0 0 560 60" style="width:100%" font-family="Noto Sans SC" font-size="12.5">${[['网关导出 CSV',0],['data/raw/2026-11',145],['summary.py 汇总',290],['周报-W45.md',435]].map(([t,x])=>`<rect x="${x+2}" y="12" width="122" height="36" rx="10" fill="var(--card)" stroke="var(--line)"/><text x="${x+63}" y="35" text-anchor="middle" fill="var(--ink)">${t}</text>`).join('')}${[124,269,414].map(x=>`<path d="M${x+5} 30h15M${x+15} 26l5 4-5 4" fill="none" stroke="var(--accent)" stroke-width="1.4"/>`).join('')}</svg></div>`}</div>
   <div class="code"><div class="h">python<span class="sp"></span><button class="ib" title="复制代码">${ic('copy','width:14px;height:14px')}</button></div><pre><span style="color:var(--accent)">def</span> weekly(df):
    df = df.resample(<span style="color:var(--ok)">"1h"</span>).mean()
    over = df[df.humidity &gt; <span style="color:var(--ochre)">75</span>]
    <span style="color:var(--accent)">return</span> df.mean(), len(over)</pre></div>`,'DeepSeek V4.1 Flash · 58 字/秒 · 12 秒 · 10:16')}
  <div class="u"><div class="b">结论那段改得简短一点</div></div>
  ${reply('','',{active:pendingApproval,pre:approval})}
 </div></div>
 <div class="cwrap">${composer({running:pendingApproval})}</div>`,right:rightWb()};
}
function vChatBf(){
 const plan=[['读三款的规格书','d'],['抓京东、淘宝的价格','d'],['整理成对比表','c'],['写推荐结论',''],['交付 report.md','']];
 const ask=S.ans?`<div class="hint"><span class="ln"></span>${OK}你选了「${S.ans}」<span class="ln"></span></div>`:
 `<div class="ask"><div class="q">${ic('info','color:var(--accent)')}三款里有一款只在海外卖，要算进对比吗？<span class="tm">${Math.floor(S.ask/60)}:${String(S.ask%60).padStart(2,'0')} 后按「先不算」继续</span></div>
  <div class="opts"><button class="opt" data-a="ans" data-v="算进去">算进去<small>运费按 60 元估</small></button><button class="opt on" data-a="ans" data-v="先不算">先不算<small>默认</small></button><button class="opt" data-a="ans" data-v="换一款国内的">换一款国内的<small>我来挑</small></button></div>
  <div class="acts"><span class="pill box" style="flex:1;color:var(--muted)">自己回答…</span><a class="lk" data-a="ans" data-v="跳过" style="font-size:13px">跳过</a></div></div>`;
 return {main:`<div class="top"><span class="ttl">整理三款温湿度传感器对比</span><span class="meta"><span class="dot run" style="display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px"></span>在推进</span><span class="sp"></span>${S.right?'':`<button class="ib" title="详情" data-a="right">${ic('panel')}</button>`}</div>
 <div class="scroll"><div class="chat">
  ${reply(`<div class="proactive">今天 09:12 · 蝶君来找你</div><p>早上好。昨晚空闲的时候我把 SHT40 的数据手册读完了，它的湿度精度比 DHT22 高一截，正好能用在你的传感器对比里。要我顺手加进去吗？</p>`,'DeepSeek V4.1 Flash · 09:12')}
  <div class="u"><div class="b">加进去吧，三款一起对比，下午之前给我一份报告</div></div>
  ${reply(`<p>好，这件事我按目标来推进，做完会核对交付再告诉你。先抓了一轮价格，画了张对比图：</p><div style="border-radius:12px;overflow:hidden;background:var(--card);box-shadow:0 0 0 1px var(--line2);max-width:420px;margin:6px 0"><div style="display:flex;align-items:flex-end;gap:10px;height:110px;padding:14px 18px 0">${[40,72,55,90,35,62].map(h=>`<i style="flex:1;height:${h}%;background:var(--accent);opacity:.7;border-radius:3px 3px 0 0"></i>`).join('')}</div><div style="font-family:var(--sans);font-size:11.5px;color:var(--muted);padding:6px 12px">price.png · python scripts/plot.py</div></div>`,'DeepSeek V4.1 Flash · 41 秒 · 10:05',{process:true,pre:work('b1',{open:false,mark:OK,title:'读取 3 份规格书 · 运行 2 条命令',n:'1 分 12 秒',rows:read('资料/规格书/','SHT40-Datasheet.pdf','2.0 秒')})})}
  <div class="hint"><span class="ln"></span>${ic('cal','width:13px;height:13px')}建了日程「下午 3 点交传感器报告」<a data-a="go" data-v="schedule">看日程</a><span class="ln"></span></div>
  ${ask}
 </div></div>
 <div class="cwrap"><div class="planbox"><div class="plan" data-a="plan">${ic('flag','width:13px;height:13px;color:var(--accent)')}计划 2/5 <b>${S.plan?'':'· 正在：整理成对比表'}</b><span class="bar"><i style="width:40%"></i></span>${ic(S.plan?'chev':'up','width:13px;height:13px')}</div>
 ${S.plan?`<div class="planlist">${plan.map(([t,c])=>`<div class="${c}">${c==='d'?OK:c==='c'?'<span class="bdot"></span>':'<span style="width:14px"></span>'}${t}</div>`).join('')}</div>`:''}
 ${composer({ph:'交代一件事，或者只是聊聊'})}</div></div>`,right:rightBf()};
}

/* ---------- right panel ---------- */
function rightWb(){
 if(!S.right)return null;
 const tabs=['文件','Git','后台','上下文'];
 const sections=tabs.map(tab=>{
 let b='';
 if(tab==='文件')b=`<div class="tool">2 个改动 · 3 个读过<span class="sp"></span><button class="ib" title="只看某类">${ic('filter','width:14px;height:14px')}</button><button class="ib" title="排序">${ic('sort','width:14px;height:14px')}</button></div><div class="rbody">
  ${[['MD','#5E7FA8','周报-W45.md','reports · 改了 +12 −1'],['PY','#4E8A5E','summary.py','scripts · 新建'],['CSV','#B5793F','传感器-温湿度-第45周.csv','data/raw/2026-11 · 读过'],['CSV','#B5793F','1110.csv','data/raw/2026-11 · 读过'],['MD','#5E7FA8','周报-W44.md','reports · 读过']].map(([k,c,n,m])=>`<div class="file"><span class="ficon" style="background:${c}22;color:${c}">${k}</span><div class="w"><div>${n}</div><small>${m}</small></div></div>`).join('')}</div>`;
 else if(tab==='Git')b=`<div class="rbody"><div class="blk"><h5>${ic('branch','width:13px;height:13px')}main<span class="sp"></span>2 个改动</h5><div class="file" style="padding:4px 0"><span class="ficon" style="background:var(--accent-soft);color:var(--accent)">M</span><div class="w"><div>reports/周报-W45.md</div><small>+12 −1</small></div></div><div class="file" style="padding:4px 0"><span class="ficon" style="background:rgba(84,108,93,.15);color:var(--ok)">A</span><div class="w"><div>scripts/summary.py</div><small>新文件</small></div></div><div class="acts" style="margin-top:8px"><button class="btn pri">提交这些改动</button><button class="btn">看差异</button></div></div></div>`;
 else if(tab==='后台')b=`<div class="rbody"><div class="blk"><div class="job"><span class="dot run" style="width:7px;height:7px;border-radius:50%"></span><div class="w"><code>python crawl_prices.py</code><small>3 分 12 秒</small></div><button class="ib" title="看输出">${ic('eye','width:14px;height:14px')}</button><button class="ib" title="停止">${ic('stop','width:14px;height:14px')}</button></div><div class="job" style="opacity:.55"><div class="w"><code>pip install pandas</code><small>结束 · 18 秒</small></div></div></div></div>`;
 else b=`<div class="rbody"><div class="blk"><h5>这个对话用了多少</h5><div class="meter" style="height:8px"><i style="width:46%"></i></div><div class="kv"><span>已用</span><span>59k / 128k</span></div><div class="kv"><span>用到 80% 时</span><span>自动整理</span></div><div class="acts" style="margin-top:8px"><button class="btn">现在整理</button></div></div></div>`;
 return `<details class="rsection" ${S.rClosed?.[tab]?'':'open'}><summary data-a="rsection" data-v="${tab}">${tab}</summary>${b}</details>`;
 }).join('');
 return `<div class="rh">这个对话<span class="sp"></span><button class="ib" title="收起" data-a="right">${ic('x')}</button></div><div class="right-sections">${sections}</div>`;
}
function rightBf(){
 if(!S.right)return null;
 return `<div class="rh">这个对话<span class="sp"></span><button class="ib" title="收起" data-a="right">${ic('x')}</button></div><div class="rbody">
 <div class="blk"><h5>${ic('flag','width:13px;height:13px')}目标<span class="sp"></span><span class="tag">在推进</span></h5>
  <div style="font-family:var(--serif);font-weight:600;font-size:15px">整理成对比表</div>
  <div style="font-size:12.5px;color:var(--ink2);margin:2px 0 8px">三款温湿度传感器的规格和价格对比，写成 report.md</div>
  <div style="font-size:12.5px;padding:6px 10px;border-radius:8px;background:var(--sunk)">下一步：等你回答海外那款算不算</div>
  <div class="kv" style="margin-top:8px"><span>预算</span><span>$0.06 / $0.50</span></div><div class="meter"><i style="width:12%"></i></div><div class="kv"><span>用时</span><span>14 分</span></div>
  <div class="acts" style="margin-top:8px"><button class="btn">${ic('pause','width:12px;height:12px')}暂停</button><button class="btn warn">停止</button><span class="sp" style="flex:1"></span><button class="ib" title="更多（紧急停止）">${ic('more')}</button></div></div>
 <div class="blk"><h5>${ic('term','width:13px;height:13px')}后台<span class="sp"></span>2 个在跑</h5><div class="job"><span class="dot run" style="width:7px;height:7px;border-radius:50%"></span><div class="w"><code>python crawl_prices.py</code><small>3 分 12 秒</small></div><button class="ib" title="看输出">${ic('eye','width:14px;height:14px')}</button></div><div class="job"><span class="dot run" style="width:7px;height:7px;border-radius:50%"></span><div class="w">子任务：读 BME280 规格书<small>1 分 40 秒</small></div><button class="ib" title="看输出">${ic('eye','width:14px;height:14px')}</button></div></div>
 <div class="blk"><h5>${ic('check','width:13px;height:13px')}交付<span class="sp"></span>还没有</h5><div style="font-size:12.5px;color:var(--muted)">做完会出现在这里，蝶君核对过才算交付。</div></div>
 <div class="blk"><h5>${ic('clock','width:13px;height:13px')}定时</h5><div class="kv"><span>下午 3 点交传感器报告</span><span>今天 15:00</span></div></div></div>`;
}
