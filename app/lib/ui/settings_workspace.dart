import 'package:flutter/material.dart';
import 'package:file_selector/file_selector.dart';
import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'settings_controls.dart';
import 'shell_widgets.dart';
import 'zoom.dart';
import 'gateway_pages.dart';
import 'sandbox_panel.dart';
import 'backup_panel.dart';
import 'data_storage_panel.dart';
import 'security_panel.dart';
import 'web_search_panel.dart';
import 'package_sources_panel.dart';
import 'about_panel.dart';
import 'pi_compatibility_panel.dart';
import 'settings_layout.dart';

/// One setting: the words search matches, the card it sits in, and the widget.
class _Setting { const _Setting(this.words,this.child,{this.card}); final String words;final Widget child;
  /// The card's title within its group (null: the group's first card, untitled).
  final String? card;
  String get searchText=>'$words ${card??''} ${switch(child){AutoSaveField c=>c.label,SettingRow c=>c.title,SettingsSwitch c=>c.title,EditableSetting c=>c.title,SettingChoice c=>c.title,_=>''}}';
}
class _SettingsGroup { const _SettingsGroup(this.name,this.icon,this.entries,this.advanced); final String name;final IconData icon;final List<_Setting> entries,advanced; }

class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key,this.category}); final String? category;
  @override State<SettingsPage> createState()=>_SettingsPageState();
}
class _SettingsPageState extends State<SettingsPage>{
  late String _selected=const {'外观':'通用','模型与网关':'模型','对话':'工作台','安全与审批':'工作台','运行上限':'工作台','蝶君沙箱':'蝶君','工具':'工作台','数据与迁移':'数据与安全','关于':'关于与更新','已归档':'归档/回收','回收站':'归档/回收'}[widget.category] ?? widget.category ?? '通用';
  final _search=TextEditingController();String _query='';
  AgentController? _agent;
  void _jump(){final target=_agent?.settingsTarget.value;if(target==null||!mounted)return;setState((){_selected=const {'已归档':'归档/回收','回收站':'归档/回收'}[target]??target;_query='';_search.clear();});_agent!.settingsTarget.value=null;}
  @override void didChangeDependencies(){super.didChangeDependencies();final a=AgentScope.read(context);if(identical(a,_agent))return;_agent?.settingsTarget.removeListener(_jump);_agent=a..settingsTarget.addListener(_jump);_jump();}
  @override void dispose(){_agent?.settingsTarget.removeListener(_jump);_search.dispose();super.dispose();}
  List<_SettingsGroup> _groups(AgentController a){
    final s=a.coreSettings;
    Future<void> save(String key,Object? v)async{await a.updateCoreSettings({key:v});if(a.coreSettings[key]!=v)throw StateError('未能保存，请重试');}
    Widget toggle(String title,String key,bool fallback)=>SettingsSwitch(title,value:s[key] as bool? ?? fallback,save:(v)=>save(key,v));
    Widget number(String title,String key,num fallback,{num min=0,num? max,bool integer=false,String? unit})=>AutoSaveField(key:ValueKey(key),label:title,compact:true,unit:unit,value:'${s[key] ?? fallback}',number:true,validator:(v){final n=num.tryParse(v);return n==null||!n.isFinite||n<min||max!=null&&n>max||integer&&n!=n.round()?'请输入有效${integer?'整数':'数值'}':null;},save:(v)=>save(key,integer?int.parse(v):num.parse(v)));
    Widget choice<T>(String title,T value,Map<T,String> choices,Future<void> Function(T) change)=>SettingChoice<T>(title,value:value,choices:choices,save:change);
    Widget model(String label,String setting)=>SettingRow(label,child:ModelSettingMenu(label:label,selected:s[setting] as String?,inheritLabel:setting=='defaultModel'?'自动':'跟对话模型一样',onChanged:(v)=>save(setting,v)));
    Widget override(String label,String purpose){final overrides=asJsonMap(s['modelOverrides']);return SettingRow(label,child:ModelSettingMenu(label:label,selected:overrides[purpose] as String?,extra:purpose=='compaction'?const {'session':'当前对话','small':'小任务模型'}:const {},onChanged:(v)=>a.updateCoreSettings({'modelOverrides':{...overrides,purpose:v}})));}
    final workspace=s['defaultWorkspace'] as String? ?? a.workspace;
    return [
      _SettingsGroup('通用',Icons.tune,[
        _Setting('称呼 名字',card:'你',EditableSetting(key:const ValueKey('userName'),title:'称呼',value:s['userName'] as String? ?? '',save:(v)=>save('userName',v.trim()))),
        const _Setting('明暗 主题 浅色 深色 跟随系统',card:'外观',SettingRow('明暗',child:ThemeModeControl())),
        // 0.8.1 S.2: themes are chosen in one place, the painting cards (day row, night row).
        const _Setting('主题 名画 日间',card:'外观',Padding(padding:EdgeInsets.symmetric(vertical:12),child:ThemePicker(brightness:Brightness.light))),
        const _Setting('主题 名画 夜间',card:'外观',Padding(padding:EdgeInsets.symmetric(vertical:12),child:ThemePicker(brightness:Brightness.dark))),
        _Setting('关窗口 托盘 退出',card:'窗口',choice('关窗口时',s['closeBehavior'] as String? ?? 'tray',const {'tray':'缩到托盘','quit':'退出'},(v)async{await save('closeBehavior',v);await a.preferences.setCloseBehaviorChoice(v);})),
        _Setting('系统通知 提醒',card:'窗口',toggle('系统通知','notifications',true)),
      ],[
        const _Setting('缩放 放大 缩小',SettingRow('界面缩放',child:ZoomControl())),
        const _Setting('文字大小 字号',SettingRow('文字大小',child:TextSizeControl())),
      ]),
      _SettingsGroup('模型',Icons.hub_outlined,[
        _Setting('对话模型',card:'用哪个模型',model('对话模型','defaultModel')),
        _Setting('小任务模型 标题 记忆整理',card:'用哪个模型',model('小任务模型','smallTaskModel')),
        _Setting('大任务模型 整理上下文 深度分析',card:'用哪个模型',model('大任务模型','largeTaskModel')),
        _Setting('看图模型 图片',card:'用哪个模型',model('看图模型','visionModel')),
        const _Setting('渠道 服务商 密钥 连接 添加',card:'渠道',ChannelList()),
      ],[
        _Setting('标题 小任务',override('起标题时使用','title')),
        _Setting('记忆整理 模型',override('记忆整理时使用','memory')),
        _Setting('整理上下文 模型',override('整理上下文时使用','compaction')),
        _Setting('深度分析 模型',override('深度分析时使用','analysis')),
        _Setting('默认思考深度',choice('思考深度',a.defaultThinkingLevel??'',const {'':'自动','off':'关闭','low':'低','medium':'中','high':'高','xhigh':'很高','max':'最高'},(v)=>save('defaultThinking',v.isEmpty?null:v))),
      ]),
      _SettingsGroup('工作台',Icons.chat_bubble_outline,[
        _Setting('默认工作区 文件夹',card:'工作区',SettingRow('默认工作区',child:Row(mainAxisSize:MainAxisSize.min,children:[Flexible(child:Tooltip(message:workspace,child:Text(workspace.isEmpty?'未设置':workspace,maxLines:1,overflow:TextOverflow.ellipsis,style:context.text.bodySmall?.copyWith(color:context.colors.muted)))),const SizedBox(width:6),TextButton.icon(icon:const Icon(Icons.folder_open,size:16),label:const Text('更换'),onPressed:()async{final path=await getDirectoryPath(initialDirectory:workspace.isEmpty?null:workspace);if(path!=null)await save('defaultWorkspace',path);})]))),
        _Setting('操作前问我 批准 修改 命令',card:'工作区',SettingsSwitch('操作前问我',value:a.approvalMode.id!='off',save:(v)=>save('approvalMode',v?'changes':'off'))),
        _Setting('网络 联网搜索 软件源 代理',card:'网络',ExpansionTile(key:ValueKey('network-$_query'),tilePadding:EdgeInsets.zero,shape:const Border(),collapsedShape:const Border(),title:const Text('联网搜索、软件源与代理'),initiallyExpanded:_query.isNotEmpty,children:const [WebSearchPanel(),PackageSourcesPanel()])),
      ],[
        _Setting('标准 极简 默认模式',choice('默认模式',a.defaultAgentMode,const {'standard':'标准','minimal':'极简'},(v)=>save('agentMode',v))),
        _Setting('操作前问我 每次',choice('询问范围',s['approvalMode'] as String? ?? 'changes',const {'changes':'修改与命令','all':'每次操作','off':'不询问'},(v)=>save('approvalMode',v))),
        const _Setting('总是允许 工具规则',_ToolRules()),
        _Setting('自动标题',toggle('自动起标题','autoTitle',true)),
        _Setting('自动整理上下文',toggle('自动整理上下文','autoCompaction',true)),
        _Setting('整理阈值',number('用到多少时整理','compactionThresholdPercent',80,min:20,max:95,integer:true,unit:'%')),
        _Setting('后台整理上下文',choice('后台整理',s['backgroundCompaction'] as String? ?? 'auto',const {'auto':'自动','on':'开启','off':'关闭'},(v)=>save('backgroundCompaction',v))),
        _Setting('提问等待',choice('提问时等多久',(s['askTimeoutSeconds'] as num?)?.toInt()??60,const {30:'30 秒',60:'1 分钟',300:'5 分钟',0:'一直等'},(v)=>save('askTimeoutSeconds',v))),
        _Setting('轮数上限',number('单次最多轮数','maxTurnsPerRun',60,integer:true)),
        _Setting('每天花费上限',number('每天花费上限','dailyBudgetUsd',0,unit:'美元')),
        _Setting('每月花费上限',number('每月花费上限','monthlyBudgetUsd',0,unit:'美元')),
        _Setting('空闲回收',number('空闲对话保留','idleSessionMinutes',10,min:1,integer:true,unit:'分钟')),
      ]),
      _SettingsGroup('蝶君',Icons.auto_awesome_outlined,[
        _Setting('联网 沙箱',card:'沙箱',toggle('允许联网','sandboxOnline',true)),
        const _Setting('沙箱 准备 自检 重置',card:'沙箱',SandboxPanel()),
      ],[
        _Setting('最多轮数',number('单次最多轮数','maxTurnsUnattended',40,min:1,integer:true)),
      ]),
      _SettingsGroup('记忆',Icons.lightbulb_outline,[
        _Setting('自动记忆',SettingsSwitch('自动记忆',value:s['memoryEnabled']!=false&&s['memoryAutoExtract']!=false,save:(v)=>a.updateCoreSettings({'memoryEnabled':v,'memoryAutoExtract':v}))),
      ],[
        _Setting('写入前确认',toggle('记住前问我','memoryConfirmWrites',false)),
        _Setting('暂停整理',toggle('暂停整理','memoryPaused',false)),
        _Setting('详细程度 强度',choice('记忆详细程度',s['memoryDetail'] as String? ?? 'standard',const {'brief':'简要','standard':'标准','detailed':'详细'},(v)=>save('memoryDetail',v))),
        _Setting('频率',choice('记忆频率',s['memoryWriteFrequency'] as String? ?? 'standard',const {'standard':'每次回复后','low':'换任务或关闭时'},(v)=>save('memoryWriteFrequency',v))),
        _Setting('容量',number('记忆容量','memoryCapacityTokens',40000,min:1,integer:true)),
        _Setting('本次记忆篇幅',number('每次带上的记忆','memoryBudgetTokens',2000,min:1,integer:true)),
        _Setting('后台预算',number('每天整理预算','memoryDailyBudgetUsd',.2,unit:'美元')),
      ]),
      _SettingsGroup('数据与安全',Icons.folder_outlined,[
        const _Setting('数据位置 存储 搬迁',card:'数据位置',DataStoragePanel(locationsOnly:true)),
        const _Setting('备份 恢复 导入 导出',card:'备份',BackupPanel()),
      ],[
        const _Setting('敏感路径 例外 审计',SecurityPanel()),
        const _Setting('磁盘空间 记忆历史 占用',DataStoragePanel(maintenanceOnly:true)),
      ]),
      // 0.8.2 (user test): 已归档 and 回收站 moved here from the sidebar's foot.
      _SettingsGroup('归档/回收',Icons.inventory_2_outlined,[
        const _Setting('已归档 归档 对话 放回',card:'已归档',ArchivedConversations()),
        const _Setting('回收站 删除 恢复',card:'回收站',RecycledConversations()),
      ],const []),
      _SettingsGroup('关于与更新',Icons.info_outline,[
        const _Setting('版本 更新 开机启动 诊断 反馈 许可证',AboutPanel()),
      ],const []),
      // 0.8.2 (user test): what only matters to someone debugging or migrating sits here, out of the way.
      _SettingsGroup('开发者选项',Icons.code,[
        const _Setting('导入原有连接配置 models.json 迁移 cc-switch pi',card:'原有连接配置',PiCompatibilityPanel()),
        const _Setting('构建号 后台版本 Pi 平台 签名',card:'版本细节',AboutPanel(details:true)),
      ],const []),
    ];
  }

  /// A group's settings as cards: consecutive entries with the same card title share one card.
  List<Widget> _cards(_SettingsGroup g,List<_Setting> entries,{bool search=false}){
    final out=<Widget>[];String? title;var rows=<Widget>[];var first=true;
    void flush(){if(rows.isEmpty)return;out.add(SettingsCard(title:search?'${g.name}${title==null?'':' › $title'}':title,children:rows));rows=<Widget>[];}
    for(final e in entries){if(first||e.card!=title){flush();title=e.card;first=false;}rows.add(e.child);}
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
      content.addAll(_cards(current,current.entries));
      if(current.advanced.isNotEmpty)content.add(SettingsCard(key:ValueKey('advanced-${current.name}'),title:'高级',collapsed:true,children:[for(final e in current.advanced)e.child]));
    } else {
      for(final g in groups){final rows=g.entries.where((e)=>match(g,e)).toList();content.addAll(_cards(g,rows,search:true));final adv=g.advanced.where((e)=>match(g,e)).toList();if(adv.isNotEmpty)content.add(SettingsCard(title:'${g.name} › 高级',children:[for(final e in adv)e.child]));}
      if(content.isEmpty)content.add(const Padding(padding:EdgeInsets.all(20),child:Text('没有找到设置')));
    }
    Widget search()=>TextField(controller:_search,decoration:InputDecoration(hintText:'搜索设置',isDense:true,prefixIcon:const Icon(Icons.search,size:18),suffixIcon:q.isEmpty?null:IconButton(tooltip:'清除',icon:const Icon(Icons.close),onPressed:(){_search.clear();setState(()=>_query='');})),onChanged:(v)=>setState(()=>_query=v));
    void choose(String name)async{FocusManager.instance.primaryFocus?.unfocus();await Future<void>.delayed(Duration.zero);if(mounted)setState((){_selected=name;_query='';_search.clear();});}
    final colors=context.colors;
    Widget nav()=>ListView(padding:const EdgeInsets.only(right:8),children:[for(final g in groups)Padding(padding:const EdgeInsets.only(bottom:2),child:_NavItem(key:ValueKey('settings-nav-${g.name}'),icon:g.icon,label:g.name,selected:q.isEmpty&&g.name==current.name,onTap:()=>choose(g.name)))]);
    // 0.8.2 (user test): one centred column, not stretched to the window's edges, so each label
    // stays near its value; the poetic title with a faint butterfly heads it.
    return Scaffold(body:LayoutBuilder(builder:(context,c){
      final narrow=c.maxWidth<720;
      final list=ListView(key:ValueKey('settings-${q.isEmpty?current.name:'search'}'),padding:const EdgeInsets.fromLTRB(4,4,4,32),children:content);
      final header=Padding(padding:const EdgeInsets.fromLTRB(4,22,4,18),child:narrow?Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[const PoeticPageTitle('设置'),const SizedBox(height:12),search()]):Row(crossAxisAlignment:CrossAxisAlignment.end,children:[const PoeticPageTitle('设置'),const SizedBox(width:14),Padding(padding:const EdgeInsets.only(bottom:10),child:Opacity(opacity:0.55,child:ButterflyMark(size:30))),const Spacer(),SizedBox(width:240,child:search())]));
      final body=narrow
          ? Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[header,DropdownButtonFormField<String>(key:ValueKey(current.name),initialValue:current.name,isExpanded:true,items:[for(final g in groups)DropdownMenuItem(value:g.name,child:Text(g.name))],onChanged:(v){if(v!=null)choose(v);}),const SizedBox(height:14),Expanded(child:list)])
          : Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[header,Expanded(child:Row(crossAxisAlignment:CrossAxisAlignment.stretch,children:[SizedBox(width:176,child:nav()),Container(width:0.5,margin:const EdgeInsets.only(right:20,bottom:24),color:colors.border),Expanded(child:list)]))]);
      return Center(child:ConstrainedBox(constraints:const BoxConstraints(maxWidth:176+21+settingsContentWidth+8),child:Padding(padding:const EdgeInsets.symmetric(horizontal:20),child:body)));
    }));
  }
}

/// A group in the settings' left column: icon and name, the chosen one on a card with an accent edge.
class _NavItem extends StatelessWidget {
  const _NavItem({super.key,required this.icon,required this.label,required this.selected,required this.onTap});
  final IconData icon;final String label;final bool selected;final VoidCallback onTap;
  @override
  Widget build(BuildContext context){
    final colors=context.colors;
    return Material(color:Colors.transparent,child:InkWell(borderRadius:BorderRadius.circular(8),onTap:onTap,child:AnimatedContainer(
      duration:AppTokens.motion(context,AppTokens.fast),curve:AppTokens.curve,height:36,
      decoration:BoxDecoration(color:selected?colors.card:Colors.transparent,borderRadius:BorderRadius.circular(8),border:Border(left:BorderSide(color:selected?colors.accent:Colors.transparent,width:3))),
      padding:const EdgeInsets.only(left:10,right:8),
      child:Row(children:[Icon(icon,size:17,color:selected?colors.accent:colors.muted),const SizedBox(width:10),Expanded(child:Text(label,maxLines:1,overflow:TextOverflow.ellipsis,style:context.text.bodyMedium?.copyWith(color:selected?colors.ink:colors.ink2,fontWeight:selected?FontWeight.w600:null)))]),
    )));
  }
}

class _ToolRules extends StatefulWidget {
  const _ToolRules();
  @override State<_ToolRules> createState()=>_ToolRulesState();
}
class _ToolRulesState extends State<_ToolRules>{
  List<String>? _tools;String? _cwd,_error;
  Future<void> _load(AgentController a)async{_cwd=a.workspace;try{final rows=await a.backend.call('workspace.toolRules',{'cwd':a.workspace});if(mounted)setState(()=>_tools=rows is List?[for(final r in rows.whereType<Map>())'${r['tool']}']:[]);}catch(_){if(mounted)setState(()=>_error='没能读取允许的操作');}}
  @override Widget build(BuildContext context){final a=AgentScope.of(context);if(_cwd!=a.workspace)WidgetsBinding.instance.addPostFrameCallback((_)=>_load(a));return Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[if(_tools?.isNotEmpty??false)SettingRow('这个工作区里总是允许',child:Wrap(spacing:8,runSpacing:8,children:[for(final t in _tools!)InputChip(label:Text(t),onDeleted:()async{try{await a.backend.call('workspace.removeToolRule',{'cwd':a.workspace,'tool':t});await _load(a);}catch(_){if(mounted)setState(()=>_error='未能恢复询问，请重试。');}})])),if(_error!=null)Text(_error!,style:TextStyle(color:context.colors.danger))]);}
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
  @override
  Widget build(BuildContext context){final a=AgentScope.of(context);final model=a.models.where((m)=>m.key==selected).firstOrNull;
    final choices=<String,String>{'':inheritLabel,...extra,for(final m in a.models)m.key:'${m.name} · ${a.providerLabel(m.provider)}'};
    return SettingMenu<String>(key:ValueKey('model-menu-$label'),value:selected??'',choices:choices,label:model?.name??extra[selected]??(selected==null?inheritLabel:'暂不可用'),onSelected:(v)async{try{await onChanged(v.isEmpty?null:v);}catch(e){if(context.mounted)ScaffoldMessenger.of(context).showSnackBar(SnackBar(content:Text('未保存：${SessionRuntime.describeError(e)}')));}});
  }
}
