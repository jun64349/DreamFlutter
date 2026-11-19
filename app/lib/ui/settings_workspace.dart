import 'package:flutter/material.dart';
import 'package:file_selector/file_selector.dart';
import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'settings_controls.dart';
import 'number_setting.dart';
import 'notification_settings.dart';
import 'zoom.dart';
import 'gateway_pages.dart';
import 'model_group_pages.dart';
import 'sandbox_panel.dart';
import 'backup_panel.dart';
import 'data_storage_panel.dart';
import 'security_panel.dart';
import 'web_search_panel.dart';
import 'package_sources_panel.dart';
import 'about_panel.dart';
import 'pi_compatibility_panel.dart';
import 'settings_layout.dart';
import 'schedule_settings.dart';
import 'settings_butterfly.dart';
import 'settings_voice.dart';
import 'settings_restore.dart';
import 'overlay_panel.dart';
import 'proto_icon.dart';
import 'shell_widgets.dart' show ShellButton, ShellButtonKind;
import 'notes.dart';
import 'guide_page.dart';
import 'onboarding_tour.dart';
import '../state/beta_edition.dart';
import 'beta_settings.dart';

/// One setting: the words search matches, the card it sits in, and the widget.
class _Setting { const _Setting(this.words,this.child,{this.card,this.trailing,this.cardDesc}); final String words;final Widget child;
  /// 节标题右边的东西（「+ 新建模型组」）和标题下的一行小字；取这张卡第一条的。
  final Widget? trailing; final String? cardDesc;
  /// The card's title within its group (null: the group's first card, untitled).
  final String? card;
  String get searchText=>'$words ${card??''} ${switch(child){AutoSaveField c=>c.label,SettingRow c=>c.title,SettingsSwitch c=>c.title,EditableSetting c=>c.title,SettingChoice c=>c.title,_=>''}}';
}
class _SettingsGroup { const _SettingsGroup(this.name,this.icon,this.entries,this.advanced); final String name,icon;final List<_Setting> entries,advanced; }

class SettingsOverlay extends StatefulWidget {
  const SettingsOverlay({super.key, required this.onClose, this.category});
  final VoidCallback onClose;
  final String? category;
  @override State<SettingsOverlay> createState()=>_SettingsOverlayState();
}
class _SettingsOverlayState extends State<SettingsOverlay>{
  final _page=GlobalKey<SettingsPageState>();
  bool _editing=false,_closing=false;
  Future<void> _close()async{
    if(_closing)return;
    _closing=true;
    try{if(await (_page.currentState?.confirmLeave()??Future.value(true))&&mounted)widget.onClose();}
    finally{_closing=false;}
  }
  @override Widget build(BuildContext context){
    final panel=ShellOverlay(label:'一方天地',padding:24,color:context.colors.background,onClose:_close,
      child:SettingsPage(key:_page,category:widget.category,onClose:_close,onEditingChanged:(value){if(mounted)setState(()=>_editing=value);}));
    // Clicking the exposed sidebar while editing must first resolve the draft.
    return ShellOverlaySidebar(width:_editing?0:ShellOverlaySidebar.widthOf(context),child:panel);
  }
}

class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key,this.category,this.onClose,this.embedded=false,this.onEditingChanged}); final String? category; final VoidCallback? onClose; final bool embedded;
  final ValueChanged<bool>? onEditingChanged;
  @override State<SettingsPage> createState()=>SettingsPageState();
}
class SettingsPageState extends State<SettingsPage>{
  late String _selected=const {'模型与网关':'模型','对话':'工作台','安全与审批':'工作台','运行上限':'工作台','蝶君沙箱':'蝶君','工具':'工作台','数据与迁移':'数据与安全','关于':'关于与更新','已归档':'归档与回收','回收站':'归档与回收'}[widget.category] ?? widget.category ?? '通用';
  final _search=TextEditingController();String _query='';
  final _groupEditor=GlobalKey<GroupEditorPageState>();
  final _channelEditor=GlobalKey<ChannelEditorPageState>();
  bool _groupOpen=false,_channelOpen=false,_navigating=false;
  void _edited()=>widget.onEditingChanged?.call(_groupOpen||_channelOpen);
  void _saved(bool group){setState((){if(group){_groupOpen=false;}else{_channelOpen=false;}});_edited();}
  Future<bool> confirmLeave()async{
    if(_navigating)return false;
    _navigating=true;
    try{
      if(!await (_groupEditor.currentState?.confirmLeave()??Future.value(true)))return false;
      return await (_channelEditor.currentState?.confirmLeave()??Future.value(true));
    }finally{_navigating=false;}
  }
  Future<void> _toggleEditor(bool group)async{
    final open=group?_groupOpen:_channelOpen;
    if(open){final allowed=group?await (_groupEditor.currentState?.confirmLeave()??Future.value(true)):await (_channelEditor.currentState?.confirmLeave()??Future.value(true));if(!allowed||!mounted)return;}
    if(!mounted)return;
    setState((){if(group){_groupOpen=!open;}else{_channelOpen=!open;}});_edited();
  }
  Future<void> _choose(String name)async{
    if(name==_selected&&_query.isEmpty)return;
    if(!await confirmLeave()||!mounted)return;
    setState((){_selected=name;_query='';_search.clear();_groupOpen=false;_channelOpen=false;});_edited();
  }
  Future<void> _searchFor(String value)async{
    if(_groupOpen||_channelOpen){
      if(!await confirmLeave()||!mounted){if(mounted){_search.text=_query;_search.selection=TextSelection.collapsed(offset:_query.length);}return;}
    }
    if(!mounted)return;
    if(_search.text!=value){_search.text=value;_search.selection=TextSelection.collapsed(offset:value.length);}
    setState((){_query=value;_groupOpen=false;_channelOpen=false;});_edited();
  }
  AgentController? _agent;
  void _jump(){if(widget.embedded)return;final target=_agent?.settingsTarget.value;if(target==null||!mounted)return;_agent!.settingsTarget.value=null;_choose(const {'已归档':'归档与回收','回收站':'归档与回收'}[target]??target);}
  @override void didChangeDependencies(){super.didChangeDependencies();final a=AgentScope.read(context);if(identical(a,_agent))return;_agent?.settingsTarget.removeListener(_jump);_agent=a..settingsTarget.addListener(_jump);_jump();}
  @override void dispose(){_agent?.settingsTarget.removeListener(_jump);_search.dispose();super.dispose();}
  List<_SettingsGroup> _groups(AgentController a) {
    final byName = {for (final group in _storedGroups(a)) group.name: group};
    return [for (final name in const ['通用', '蝶君', '记忆', '模型', '工作台', '外观', '窗口与通知', '数据与安全', '归档与回收', '关于与更新', '开发者选项']) byName[name]!];
  }

  List<_SettingsGroup> _storedGroups(AgentController a){
    final s=a.coreSettings;
    Future<void> save(String key,Object? v)async{await a.updateCoreSettings({key:v});if(a.coreSettings[key]!=v)throw StateError('未能保存，请重试');}
    Widget toggle(String title,String key,bool fallback,{String? desc,bool indented=false})=>SettingsSwitch(title,desc:desc,indented:indented,value:s[key] as bool? ?? fallback,save:(v)=>save(key,v));
    Widget number(String title,String key,num fallback,{num min=0,num? max,bool integer=false,String? unit,String? desc,bool indented=false})=>PresetNumberSetting(key:ValueKey(key),label:title,unit:unit,desc:desc,indented:indented,value:'${s[key] ?? fallback}',defaultValue:fallback,presets:settingNumberPresets[key]!,zeroLabel:key=='dailyBudgetUsd'||key=='monthlyBudgetUsd'?'不限':null,validator:(v){final n=num.tryParse(v);return n==null||!n.isFinite||n<min||max!=null&&n>max||integer&&n!=n.round()?'请输入有效${integer?'整数':'数值'}':null;},save:(v)=>save(key,integer?int.parse(v):num.parse(v)));
    Widget model(String label,String setting,{String? desc})=>SettingRow(label,desc:desc,child:ModelSettingMenu(label:label,selected:s[setting] as String?,inheritLabel:setting=='defaultModel'?'自动':'跟对话模型一样',onChanged:(v)=>save(setting,v)));
    Widget override(String label,String purpose){final overrides=asJsonMap(s['modelOverrides']);return SettingRow(label,child:ModelSettingMenu(label:label,selected:overrides[purpose] as String?,extra:purpose=='compaction'?const {'session':'当前对话','small':'小任务模型'}:const {},onChanged:(v)=>a.updateCoreSettings({'modelOverrides':{...overrides,purpose:v}})));}
    final workspace=s['defaultWorkspace'] as String? ?? a.workspace;
    return [
      _SettingsGroup('通用','user',[
        _Setting('称呼 名字',card:'你',Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[
          Row(children:[
            _NameAvatar(name:s['userName'] as String? ?? ''),
            const SizedBox(width:14),
            Expanded(child:EditableSetting(key:const ValueKey('userName'),title:'称呼',desc:'蝶君和工作台都这样叫你',value:s['userName'] as String? ?? '',save:(v)=>save('userName',v.trim()))),
          ]),
        ])),
        const _Setting('语音 识别 本机 云端 Key 快捷键',card:'语音输入',VoiceSettings()),
        const _Setting('语音 快捷键',card:'语音输入',SettingRow('快捷键',desc:'按一次开始说，再按一次结束',child:Row(mainAxisSize:MainAxisSize.min,children:[V1Keycap('Ctrl'),SizedBox(width:4),V1Keycap('Shift'),SizedBox(width:4),V1Keycap('M')]))),
        const _Setting('文字大小 字号',card:'界面',SettingRow('文字大小',child:TextSizeControl())),
        const _Setting('缩放 放大 缩小',card:'界面',SettingRow('界面缩放',desc:'也可以按 Ctrl + 加号 / 减号',child:ZoomControl())),
      ],const []),
      if(kBetaEdition)_SettingsGroup('模型','hub',[
        const _Setting('模型池 激活码 花费',card:'模型池',BetaPoolRows()),
        const _Setting('对话模型',card:'用哪个模型',BetaFixedModel('对话','GPT-6.1 Terra',desc:'聊天和工作台默认用它')),
        const _Setting('小任务模型 标题 记忆整理',card:'用哪个模型',BetaFixedModel('小任务','GPT-6.1 Terra',desc:'起标题、整理记忆')),
        const _Setting('大任务模型 整理上下文 深度分析',card:'用哪个模型',BetaFixedModel('大任务','GPT-6.2 Sol',desc:'整理上下文、深度分析')),
        const _Setting('看图模型 图片',card:'用哪个模型',BetaFixedModel('看图','GPT-6.1 Terra')),
        _Setting('默认思考深度',card:'用哪个模型',SettingsSeg<String>('思考深度',value:a.defaultThinkingLevel??'',options:const [('','自动'),('low','低'),('medium','中'),('high','高')],save:(v)=>save('defaultThinking',v.isEmpty?null:v))),
      ],const [])else _SettingsGroup('模型','hub',[
        _Setting('对话模型',card:'用哪个模型',model('对话','defaultModel',desc:'聊天和工作台默认用它')),
        _Setting('小任务模型 标题 记忆整理',card:'用哪个模型',model('小任务','smallTaskModel',desc:'起标题、整理记忆')),
        _Setting('大任务模型 整理上下文 深度分析',card:'用哪个模型',model('大任务','largeTaskModel',desc:'整理上下文、深度分析')),
        _Setting('看图模型 图片',card:'用哪个模型',model('看图','visionModel',desc:'对话模型看不了图时用它')),
        _Setting('默认思考深度',card:'用哪个模型',SettingsSeg<String>('思考深度',value:a.defaultThinkingLevel??'',options:const [('','自动'),('low','低'),('medium','中'),('high','高'),('xhigh','很高'),('max','最高')],save:(v)=>save('defaultThinking',v.isEmpty?null:v))),
        _Setting('模型组 自动切换 按顺序 订阅',card:'模型组',Column(children:[const GroupList(),if(_groupOpen)GroupEditorPage(key:_groupEditor,inline:true,onSaved:()=>_saved(true))]),trailing:SettingsHeadLink(_groupOpen?'收起':'新建模型组',onPressed:()=>_toggleEditor(true)),cardDesc:'排在前面的用不了，自动换下一个'),
        _Setting('渠道 服务商 密钥 连接 添加',card:'渠道',Column(children:[const ChannelList(),if(_channelOpen)ChannelEditorPage(key:_channelEditor,inline:true,onSaved:()=>_saved(false))]),trailing:TourAnchor('gateway-add',child:SettingsHeadLink(_channelOpen?'收起':'添加渠道',onPressed:()=>_toggleEditor(false)))),
      ],[
        _Setting('标题 小任务',override('起标题时使用','title')),
        _Setting('记忆整理 模型',override('记忆整理时使用','memory')),
        _Setting('整理上下文 模型',override('整理上下文时使用','compaction')),
        _Setting('深度分析 模型',override('深度分析时使用','analysis')),
      ]),
      _SettingsGroup('工作台','chat',[
        _Setting('默认工作区 文件夹',card:'工作区',Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[
          SettingRow('默认工作区',desc:'新对话在这个文件夹里读写文件、执行命令',child:const SizedBox.shrink()),
          Padding(padding:const EdgeInsets.only(bottom:10),child:Row(children:[
            Expanded(child:Container(
              padding:const EdgeInsets.symmetric(horizontal:12,vertical:8),
              decoration:BoxDecoration(color:context.colors.sunk,borderRadius:BorderRadius.circular(9)),
              child:Text(workspace.isEmpty?'未设置':workspace,maxLines:1,overflow:TextOverflow.ellipsis,
                style:TextStyle(fontFamily:AppTokens.monoFamily,fontFamilyFallback:AppTokens.monoFallback,fontSize:12.5,color:context.colors.ink)),
            )),
            const SizedBox(width:8),
            ShellButton('更换',small:true,onPressed:()async{final path=await getDirectoryPath(initialDirectory:workspace.isEmpty?null:workspace);if(path!=null)await save('defaultWorkspace',path);}),
          ])),
        ])),
        _Setting('操作前问我 批准 修改 命令',card:'工作区',SettingsSeg<String>('操作前问我',value:s['approvalMode'] as String? ?? 'changes',options:const [('changes','修改与命令'),('all','每次操作'),('off','不询问')],desc:switch(s['approvalMode']){'all'=>'连读文件和搜索都先问你','off'=>'读写和命令都直接做，出岔子自己负责',_=>'读文件和搜索直接做，改文件、跑命令先问你'},warnWhen:'off',save:(v)=>save('approvalMode',v))),
        const _Setting('总是允许的操作 批准 例外',card:'工作区',_ToolRules()),
        _Setting('默认模式 极简',card:'对话',SettingsSeg<String>('默认模式',value:a.defaultAgentMode,options:const [('standard','标准'),('minimal','极简')],desc:a.defaultAgentMode=='minimal'?'只给它读写文件和跑命令':'能用的都给它：文件、命令、网页、记忆',save:(v)=>save('agentMode',v))),
        _Setting('自动起标题 标题',card:'对话',toggle('自动起标题','autoTitle',true)),
        _Setting('自动整理上下文 压缩',card:'对话',toggle('自动整理上下文','autoCompaction',true,desc:'对话太长时把前面的压成摘要')),
        _Setting('上下文 用到多少 整理',card:'对话',number('用到多少时整理','compactionThresholdPercent',80,min:20,max:95,integer:true,unit:'%',indented:true)),
        _Setting('后台整理 空闲',card:'对话',SettingsSeg<String>('后台整理',indented:true,value:s['backgroundCompaction'] as String? ?? 'auto',options:const [('auto','自动'),('on','开启'),('off','关闭')],save:(v)=>save('backgroundCompaction',v))),
        _Setting('提问 等多久',card:'对话',PresetNumberSetting(key:const ValueKey('askTimeoutSeconds'),label:'它提问时等多久',value:'${s['askTimeoutSeconds']??60}',defaultValue:60,presets:settingNumberPresets['askTimeoutSeconds']!,unit:'秒',zeroLabel:'一直等',desc:'到时间按默认选项继续',validator:(v){final n=int.tryParse(v);return n==null||n<0?'请输入有效整数':null;},save:(v)=>save('askTimeoutSeconds',int.parse(v)))),
        _Setting('单次最多轮数 轮数上限',card:'对话',number('单次最多轮数','maxTurnsPerRun',60,integer:true,min:1)),
        _Setting('空闲对话保留',card:'对话',number('空闲对话保留','idleSessionMinutes',10,min:1,integer:true,unit:'分钟',desc:'过了这个时间先放下，回来时再接上')),
        _Setting('每天花费上限 花费',card:'花费上限',number('每天花费上限','dailyBudgetUsd',0,unit:'美元')),
        _Setting('每月花费上限 花费',card:'花费上限',number('每月花费上限','monthlyBudgetUsd',0,unit:'美元')),
        const _Setting('联网搜索 顺序',card:'网络',WebSearchPanel()),
        const _Setting('软件源 安装',card:'网络',PackageSourcesPanel()),
      ],const []),
      _SettingsGroup('蝶君','spark',[
        const _Setting('性格 安静 亲切 利落 活泼',card:'性格',PersonaChoices()),
        const _Setting('主动性 自己做事',card:'主动',ButterflyProactivity()),
        _Setting('夜间不打扰',card:'主动',_ButterflyQuiet()),
        const _Setting('长期目标',card:'长期目标',ButterflyLongGoals(section:true)),
        const _Setting('规则 观察 自动',card:'规则',ScheduleRules()),
        const _Setting('日程 巡检',card:'日程与巡检',ScheduleSettings()),
        const _Setting('沙箱 自检 重置',card:'沙箱',SandboxPanel()),
        _Setting('联网 沙箱',card:'沙箱',SettingsSwitch('允许联网',desc:'按下马上生效',value:s['sandboxOnline'] as bool? ?? true,save:(v)async{await a.backend.call('sandbox.setOnline',{'online':v});})),
        _Setting('沙箱 轮数',card:'沙箱',number('单次最多轮数','maxTurnsUnattended',40,integer:true,min:1,desc:'没人看着时，一件事最多走这么多步')),
      ],const []),
      _SettingsGroup('记忆','memory',[
        const _Setting('记忆 梦君记',MemorySettingsBanner()),
        _Setting('自动记忆',SettingsSwitch(
          '自动记忆',
          desc:'聊天时它自己判断什么值得记',
          value:s['memoryEnabled']!=false&&s['memoryAutoExtract']!=false,
          save:(v)=>a.updateCoreSettings({'memoryEnabled':v,'memoryAutoExtract':v}),
        )),
        _Setting('记住前问我',toggle('记住前问我','memoryConfirmWrites',false,desc:'每条新记忆先给你看一眼',indented:true)),
        _Setting('暂停整理',toggle('暂停整理','memoryPaused',false,indented:true)),
        _Setting('记忆详细程度',card:'记多少',SettingsSeg<String>('详细程度',value:s['memoryDetail'] as String? ?? 'standard',options:const [('brief','简要'),('standard','标准'),('detailed','详细')],save:(v)=>save('memoryDetail',v))),
        _Setting('记忆频率 什么时候记',card:'记多少',SettingsSeg<String>('什么时候记',value:s['memoryWriteFrequency'] as String? ?? 'standard',options:const [('standard','每次回复后'),('low','换任务或关闭时')],save:(v)=>save('memoryWriteFrequency',v))),
        _Setting('每次带上的记忆 token',card:'记多少',number('每次带上的记忆','memoryBudgetTokens',2000,min:1,integer:true,unit:'token',desc:'越多越懂你，也越贵')),
        _Setting('记忆容量 token',card:'记多少',number('记忆容量','memoryCapacityTokens',40000,min:1,integer:true,unit:'token',desc:'满了以后先忘掉最久没用的')),
        _Setting('每天整理预算',card:'记多少',number('每天整理预算','memoryDailyBudgetUsd',.2,unit:'美元')),
      ],[
        const _Setting('压缩 记忆 历史',DataStoragePanel(maintenanceOnly:true)),
      ]),
      _SettingsGroup('外观','brush',[
        const _Setting('明暗 浅色 深色 跟随系统',card:'明暗',SettingRow('明暗',desc:'跟随系统时，白天和夜里各用下面选的主题',child:ThemeModeControl())),
        const _Setting('名作主题集 白天 暖纸 蛱蝶 草蝶 羽化 神思 千蝶',card:'名作主题集 · 白天',ThemePicker(brightness:Brightness.light)),
        const _Setting('名作主题集 夜里 暮色 墨夜 幽华 琉光 幻蝶 石青',card:'名作主题集 · 夜里',ThemePicker(brightness:Brightness.dark)),
        const _Setting('纸 纹理 宣纸 棉纸 细颗粒 蝴蝶动起来',card:'纸',PaperSettings()),
      ],const []),
      _SettingsGroup('窗口与通知','window',[
        _Setting('关窗口 托盘 退出',card:'窗口',SettingsSeg<String>('关窗口时',value:s['closeBehavior'] as String? ?? 'tray',options:const [('tray','缩到托盘'),('quit','退出')],desc:'缩到托盘时，蝶君的事继续做',save:(v)async{await save('closeBehavior',v);await a.preferences.setCloseBehaviorChoice(v);})),
        const _Setting('开机启动',card:'窗口',AboutPanel(startupOnly:true)),
        _Setting('只开一个窗口',card:'窗口',const SettingRow('只开一个窗口',desc:'再次双击图标时，把已有窗口调到前面',child:V1Toggle(value:true,onChanged:null))),
        const _Setting('系统通知 工作台 蝶君 结果 问题',card:'通知',NotificationSettings()),
      ],const []),
      _SettingsGroup('数据与安全','shield',[
        const _Setting('备份 恢复 导出 导入',card:'备份',BackupPanel()),
        const _Setting('卸载 删除',card:'卸载',UninstallSetting()),
        const _Setting('敏感路径 不让它碰',card:'敏感路径',Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[
          SettingRow('不让它碰的地方',desc:'这些位置读写前一律先问你，就算你选了「不询问」',child:SizedBox.shrink()),
          Padding(padding:EdgeInsets.only(bottom:10),child:V1Inset(child:Text(r'C:\Windows · 用户目录下的 .ssh、.aws · 浏览器的密码文件'))),
        ])),
        const _Setting('路径例外 允许 操作记录 审计',card:'敏感路径',SecurityPanel()),
        const _Setting('数据 目录 位置 空间',card:'数据位置',DataStoragePanel(locationsOnly:true)),
      ],const []),
      _SettingsGroup('归档与回收','arch',[
        _Setting('归档 对话 放回',card:'已归档',const ArchivedConversations(),trailing:a.archivedSessions.isEmpty?null:Text('${a.archivedSessions.length} 个',style:TextStyle(fontSize:12.5,color:context.colors.muted))),
        const _Setting('回收站 删除 恢复',card:'回收站',RecycledConversations(),cardDesc:'删掉的对话在这里留 30 天'),
      ],const []),
      _SettingsGroup('关于与更新','info',[
        const _Setting('使用说明 入门 教程 帮助 新手',card:'使用说明',GuideEntry()),
        const _Setting('版本 更新 检查 诊断 反馈 许可证',AboutPanel()),
      ],const []),
      _SettingsGroup('开发者选项','code',[
        const _Setting('原有连接配置 导入',card:'原有连接配置',PiCompatibilityPanel()),
        const _Setting('版本细节 构建号',card:'版本细节',AboutPanel(details:true)),
      ],const []),
    ];
  }

  /// A group's settings as cards: consecutive entries with the same card title share one card.
  List<Widget> _cards(_SettingsGroup g,List<_Setting> entries,{bool search=false}){
    final out=<Widget>[];String? title;var rows=<Widget>[];var first=true;_Setting? head;
    void flush(){
      if(rows.isEmpty)return;
      if(out.isEmpty&&title!=null&&!search)out.add(const SizedBox(height:26));
      if(rows.length==1&&rows.single is ButterflyLongGoals){out.add(rows.single);rows=<Widget>[];return;}
      final bare=!search&&(g.name=='外观'&&(title=='白天的主题'||title=='夜里的主题')||g.name=='关于与更新'&&title==null);
      final cardKey=g.name=='工作台'&&title=='网络'
          ? ValueKey('network-$_query')
          : !search&&identical(head,g.advanced.firstOrNull) ? ValueKey('advanced-${g.name}') : null;
      out.add(SettingsCard(
        key:cardKey,
        title:search?'${g.name}${title==null?'':' › $title'}':title,
        desc:head?.cardDesc,bare:bare,padded:!bare,
        collapsed:g.name=='数据与安全'&&title=='数据位置'&&!search?true:null,
        trailing:head?.trailing??(g.name=='外观'&&title=='白天的主题'&&!search?Text('点一下马上换',style:TextStyle(fontSize:12.5,color:context.colors.muted)):null),
        children:rows,
      ));
      rows=<Widget>[];
    }
    for(final e in entries){if(first||e.card!=title){flush();title=e.card;head=e;first=false;}rows.add(e.child);}
    flush();
    return out;
  }

  @override
  Widget build(BuildContext context){
    final a=AgentScope.of(context), groups=_groups(a), q=_query.trim().toLowerCase();
    final current=groups.where((g)=>g.name==_selected).firstOrNull??groups.first;
    bool match(_SettingsGroup g,_Setting e)=>'${g.name} ${e.searchText}'.toLowerCase().replaceAll(RegExp(r'\s+'),'').contains(q.replaceAll(RegExp(r'\s+'),''));
    final content=<Widget>[];
    if(q.isEmpty){
      for(final entry in current.entries){
        if(entry.child is MemorySettingsBanner)content.add(entry.child);
      }
      content.addAll(_cards(current,[...current.entries.where((e)=>e.child is! MemorySettingsBanner),...current.advanced]));
    } else {
      for(final g in groups){final rows=g.entries.where((e)=>match(g,e)).toList();content.addAll(_cards(g,rows,search:true));final adv=g.advanced.where((e)=>match(g,e)).toList();if(adv.isNotEmpty)content.addAll(_cards(g,adv,search:true));}
      if(content.isEmpty)content.add(const Padding(padding:EdgeInsets.all(20),child:Text('没有找到设置')));
    }
    final colors=context.colors;
    if(widget.embedded){
      final memory=groups.firstWhere((g)=>g.name=='记忆');
      return ListView(key:const ValueKey('memory-settings'),padding:const EdgeInsets.fromLTRB(0,20,0,32),children:_cards(memory,[...memory.entries.where((e)=>e.child is! MemorySettingsBanner),...memory.advanced]));
    }
    Widget search(){
      final border=OutlineInputBorder(borderRadius:BorderRadius.circular(9),borderSide:BorderSide.none);
      final sunk=Color.alphaBlend(colors.ink.withValues(alpha:colors.background.computeLuminance()>.5 ? .045 : .05),colors.sidebar);
      return TextField(
        controller:_search,style:context.text.bodyMedium?.copyWith(fontSize:13,height:1.6),
        decoration:InputDecoration(
          hintText:'搜索设置',hintStyle:TextStyle(fontSize:13,color:colors.muted),isDense:true,
          contentPadding:const EdgeInsets.symmetric(horizontal:10,vertical:7),
          filled:true,fillColor:sunk,border:border,enabledBorder:border,focusedBorder:border,
          prefixIconConstraints:const BoxConstraints(minWidth:32),
          prefixIcon:Padding(padding:const EdgeInsets.only(left:10,right:8),child:ProtoIcon('search',size:14,color:colors.muted)),
          suffixIconConstraints:const BoxConstraints(minWidth:30,minHeight:30),
          suffixIcon:q.isEmpty?null:IconButton(tooltip:'清除',padding:EdgeInsets.zero,icon:const ProtoIcon('x',size:14),onPressed:()=>_searchFor('')),
        ),
        onChanged:_searchFor,
      );
    }
    void choose(String name)async{FocusManager.instance.primaryFocus?.unfocus();await Future<void>.delayed(Duration.zero);if(mounted)await _choose(name);}
    const headings={'通用':'我与蝶君','蝶君':'我与蝶君','记忆':'我与蝶君','模型':'工作','工作台':'工作','外观':'应用','窗口与通知':'应用','数据与安全':'应用','归档与回收':'更多','关于与更新':'更多','开发者选项':'更多'};
    Widget nav()=>ListView(padding:EdgeInsets.zero,children:[
      search(),
      const SizedBox(height:10),
      for(final (i,g) in groups.indexed) ...[
        if(i==0||headings[g.name]!=headings[groups[i-1].name])
          Padding(padding:const EdgeInsets.fromLTRB(10,12,10,4),child:Text(headings[g.name]!,style:TextStyle(fontSize:11.5,fontWeight:FontWeight.w600,color:colors.muted))),
        TourAnchor('settings-nav-${g.name}',child:_NavItem(key:ValueKey('settings-nav-${g.name}'),icon:g.icon,label:g.name,selected:q.isEmpty&&g.name==current.name,onTap:()=>choose(g.name))),
      ],
    ]);
    return LayoutBuilder(builder:(context,c){
      final narrow=c.maxWidth<=720;
      final compact=c.maxWidth+48<=860;
      final header=Padding(padding:const EdgeInsets.only(bottom:4),child:Text(q.isEmpty?current.name:'搜索',
        style:context.text.bodyMedium?.copyWith(fontSize:19,height:1.6,fontWeight:FontWeight.w600,color:colors.ink)));
      final list=ListView(
        key:ValueKey('settings-${q.isEmpty?current.name:'search'}'),
        padding:EdgeInsets.fromLTRB(0,narrow?0:compact?18:22,0,compact?30:40),
        children:[if(!narrow)header,...content],
      );
      final body=narrow
        ? Padding(padding:const EdgeInsets.fromLTRB(18,18,18,0),child:Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[
            header,search(),const SizedBox(height:10),
            DropdownButtonFormField<String>(key:ValueKey(current.name),initialValue:current.name,isExpanded:true,items:[for(final g in groups)DropdownMenuItem(value:g.name,child:Text(g.name))],onChanged:(v){if(v!=null)choose(v);}),
            const SizedBox(height:14),Expanded(child:list),
          ]))
        : Row(crossAxisAlignment:CrossAxisAlignment.stretch,children:[
            Container(width:compact?170:228,color:colors.sidebar,padding:const EdgeInsets.symmetric(horizontal:10,vertical:14),child:nav()),
            Expanded(child:Padding(padding:EdgeInsets.symmetric(horizontal:compact?18:40),
              child:Center(child:ConstrainedBox(constraints:const BoxConstraints(maxWidth:700),child:list)))),
          ]);
      return Stack(children:[
        Positioned.fill(child:body),
        if(widget.onClose!=null)Positioned(top:12,right:14,child:OverlayCloseButton(onClose:widget.onClose!)),
      ]);
    });
  }
}

class MemorySettingsBanner extends StatelessWidget {
  const MemorySettingsBanner({super.key});
  @override Widget build(BuildContext context) {
    final colors=context.colors;
    return Container(
      margin:const EdgeInsets.only(top:4,bottom:16),
      padding:const EdgeInsets.symmetric(horizontal:22,vertical:18),
      decoration:BoxDecoration(
        borderRadius:BorderRadius.circular(14),color:colors.card,
        gradient:LinearGradient(begin:Alignment.topLeft,end:Alignment.bottomRight,colors:[Color.alphaBlend(colors.accentSoft,colors.card),colors.card],stops:const [0,.7]),
        border:Border.all(color:colors.ink.withValues(alpha:.07)),
      ),
      child:Row(children:[
        Expanded(child:Text('梦君记',style:context.handwriting(context.text.headlineSmall).copyWith(color:colors.accent,fontSize:28))),
        const SizedBox(width:16),
        ShellButton('打开记忆',kind:ShellButtonKind.primary,onPressed:()=>AgentScope.read(context).showSection(AppSection.memory)),
      ]),
    );
  }
}

/// 原型的称呼头像：accentSoft 圆底、accent 色的末字。
class _NameAvatar extends StatelessWidget {
  const _NameAvatar({required this.name});
  final String name;
  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final initial = name.trim().isEmpty ? '·' : name.trim().characters.last;
    return Container(
      width: 52, height: 52,
      decoration: BoxDecoration(color: colors.accentSoft, shape: BoxShape.circle),
      alignment: Alignment.center,
      child: Text(initial, style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600, color: colors.accent)),
    );
  }
}

/// 蝶君的夜间不打扰：一个开关，开的时候下面是缩进的开始、结束两行。
class _ButterflyQuiet extends StatefulWidget {
  const _ButterflyQuiet();
  @override State<_ButterflyQuiet> createState() => _ButterflyQuietState();
}
class _ButterflyQuietState extends State<_ButterflyQuiet> {
  bool _busy = false;
  String? _error;
  Future<void> _save(AgentController a, Map<String, Object?> patch) async {
    setState(() { _busy = true; _error = null; });
    try { await a.updateCoreSettings(patch); }
    catch (e) { if (mounted) setState(() => _error = SessionRuntime.describeError(e)); }
    finally { if (mounted) setState(() => _busy = false); }
  }
  Future<void> _pickTime(bool start) async {
    final a = AgentScope.read(context);
    final s = a.coreSettings;
    final key = start ? 'patrolQuietStart' : 'patrolQuietEnd';
    final current = '${s[key] ?? (start ? '23:00' : '07:30')}';
    final parts = current.split(':');
    final picked = await showTimePicker(context: context, initialTime: TimeOfDay(hour: int.tryParse(parts.first) ?? (start ? 23 : 7), minute: int.tryParse(parts.length > 1 ? parts[1] : '') ?? (start ? 0 : 30)));
    if (picked == null) return;
    final value = '${picked.hour.toString().padLeft(2, '0')}:${picked.minute.toString().padLeft(2, '0')}';
    await _save(a, {key: value});
  }
  @override
  Widget build(BuildContext context) {
    final a = AgentScope.of(context), s = a.coreSettings;
    final on = s['patrolQuietEnabled'] != false;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      SettingsSwitch('夜间不打扰', desc: '这段时间不来找你，你让它提醒的事除外', value: on, save: (v) => _save(a, {'patrolQuietEnabled': v})),
      if (on) ...[
        SettingRow('开始', indented:true, child: _TimeChip(time: '${s['patrolQuietStart'] ?? '23:00'}', onTap: _busy ? null : () => _pickTime(true))),
        SettingRow('结束', indented:true, child: _TimeChip(time: '${s['patrolQuietEnd'] ?? '07:30'}', onTap: _busy ? null : () => _pickTime(false))),
      ],
      if (_error != null) Text(_error!, style: TextStyle(color: context.colors.danger)),
    ]);
  }
}

/// 原型的时间 .num：sunk 底、等宽数字、右边一个时钟小图标。
class _TimeChip extends StatelessWidget {
  const _TimeChip({required this.time, this.onTap});
  final String time;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return InkWell(
      borderRadius: BorderRadius.circular(9),
      onTap: onTap,
      child: Container(
        constraints:const BoxConstraints(minWidth:96),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(color: colors.sunk, borderRadius: BorderRadius.circular(9)),
        child: Row(mainAxisSize: MainAxisSize.min, mainAxisAlignment:MainAxisAlignment.end,children: [
          Text(time, style: TextStyle(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback, fontSize: 13, color: colors.ink2)),
          const SizedBox(width: 6),
          ProtoIcon('clock', size: 13, color: colors.muted),
        ]),
      ),
    );
  }
}

/// A group in the settings' left column: icon and name, the chosen one on a card with an accent edge.
class _NavItem extends StatelessWidget {
  const _NavItem({super.key,required this.icon,required this.label,required this.selected,required this.onTap});
  final String icon,label;final bool selected;final VoidCallback onTap;
  @override
  Widget build(BuildContext context){
    final colors=context.colors;
    final radius=BorderRadius.circular(8);
    return Material(color:selected?colors.accentSoft:Colors.transparent,borderRadius:radius,clipBehavior:Clip.antiAlias,
      child:InkWell(onTap:onTap,child:Stack(children:[
        if(selected)Positioned(top:0,bottom:0,left:0,child:ColoredBox(color:colors.accent,child:const SizedBox(width:2))),
        Padding(padding:const EdgeInsets.symmetric(horizontal:10,vertical:6),child:Row(children:[
          ProtoIcon(icon,color:selected?colors.accent:colors.muted),const SizedBox(width:10),
          Expanded(child:Text(label,maxLines:1,overflow:TextOverflow.ellipsis,style:TextStyle(fontSize:13.5,height:1.6,color:selected?colors.accent:colors.ink2,fontWeight:selected?FontWeight.w500:FontWeight.w400))),
        ])),
      ])),
    );
  }
}

class _ToolRules extends StatefulWidget {
  const _ToolRules();
  @override State<_ToolRules> createState()=>_ToolRulesState();
}
class _ToolRulesState extends State<_ToolRules>{
  List<String>? _tools;String? _cwd,_error;
  Future<void> _load(AgentController a)async{_cwd=a.workspace;try{final rows=await a.backend.call('workspace.toolRules',{'cwd':a.workspace});if(mounted)setState(()=>_tools=rows is List?[for(final r in rows.whereType<Map>())'${r['tool']}']:[]);}catch(_){if(mounted)setState(()=>_error='没能读取允许的操作');}}
  @override Widget build(BuildContext context){final a=AgentScope.of(context);if(_cwd!=a.workspace)WidgetsBinding.instance.addPostFrameCallback((_)=>_load(a));return Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[if(_tools?.isNotEmpty??false)SettingRow('这个工作区里总是允许',child:Wrap(spacing:8,runSpacing:8,children:[for(final t in _tools!)InputChip(label:Text(t),onDeleted:()async{try{await a.backend.call('workspace.removeToolRule',{'cwd':a.workspace,'tool':t});await _load(a);}catch(_){if(mounted)setState(()=>_error='未能恢复询问，请重试。');}})])),if(_tools?.isEmpty==true)const Padding(padding:EdgeInsets.symmetric(vertical:12),child:Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[Text('总是允许的操作'),SizedBox(height:8),V1Inset(child:Text('还没有。'))])),if(_error!=null)Text(_error!,style:TextStyle(color:context.colors.danger))]);}
}

String modelDisplayName(AgentController agent,String? key,{Map<String,String> fallback=const {}}){
  final live=agent.models.where((m)=>m.key==key).firstOrNull;
  if(live!=null)return live.name;
  for(final channel in agent.gatewayChannels){for(final m in channel.models){if('${channel.provider}/${m['id']}'==key&&m['name'] is String)return m['name'] as String;}}
  final id=key?.split('/').last;
  return fallback[id]??'暂不可用';
}

class ModelSettingMenu extends StatelessWidget {
  const ModelSettingMenu({super.key,required this.label,required this.selected,required this.onChanged,this.extra=const {},this.inheritLabel='自动'});
  final String label;final String? selected;final Future<void> Function(String?) onChanged;final Map<String,String> extra;final String inheritLabel;

  Future<void> _choose(BuildContext context,String? value)async{
    try{await onChanged(value);}catch(e){if(context.mounted)showNote('未保存：${SessionRuntime.describeError(e)}', kind: NoteKind.fail);}
  }

  /// 0.8.3: model groups first, then each channel's common models under its name; 「更多模型…」 for the rest.
  @override
  Widget build(BuildContext context){final a=AgentScope.of(context);final model=a.models.where((m)=>m.key==selected).firstOrNull;
    final sections=a.modelSections(keep:selected);
    final choices=<String,String>{'':inheritLabel,...extra};
    final headers=<String>{};
    for(final section in sections){
      if(sections.length>1){final h='#${section.title}';headers.add(h);choices[h]=section.title;}
      for(final m in section.models){choices[m.key]=m.name;}
    }
    return SettingMenu<String>(key:ValueKey('model-menu-$label'),value:selected??'',choices:choices,headers:headers,
      label:model==null?(extra[selected]??(selected==null?inheritLabel:'暂不可用')):model.provider==groupProvider?'${model.name}（模型组）':a.modelWithProvider(model.name,model.provider),
      more:a.hasMoreModels?('更多模型…',()async{final picked=await showModelSearch(context);if(picked!=null&&context.mounted)await _choose(context,picked.key);}):null,
      onSelected:(v)=>_choose(context,v.isEmpty?null:v));
  }
}
