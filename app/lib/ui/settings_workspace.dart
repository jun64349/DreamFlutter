import 'package:flutter/material.dart';
import 'package:file_selector/file_selector.dart';
import '../main.dart' show appVersion;
import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'settings_controls.dart';
import 'shell_widgets.dart';
import 'zoom.dart';
import 'gateway_pages.dart';
import 'model_settings.dart';
import 'sandbox_panel.dart';
import 'backup_panel.dart';
import 'data_storage_panel.dart';
import 'security_panel.dart';
import 'web_search_panel.dart';
import 'package_sources_panel.dart';
import 'about_panel.dart';
import 'pi_compatibility_panel.dart';

class _Setting { const _Setting(this.words,this.child); final String words;final Widget child;
  String get searchText=>'$words ${switch(child){AutoSaveField c=>c.label,SettingRow c=>c.title,SettingsSwitch c=>c.title,EditableSetting c=>c.title,SettingChoice c=>c.title,_=>''}}';
}
class _SettingsGroup { const _SettingsGroup(this.name,this.icon,this.entries,this.advanced); final String name;final IconData icon;final List<_Setting> entries,advanced; }

class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key,this.category}); final String? category;
  @override State<SettingsPage> createState()=>_SettingsPageState();
}
class _SettingsPageState extends State<SettingsPage>{
  late String _selected=const {'外观':'通用','模型与网关':'模型','对话':'工作台','安全与审批':'工作台','运行上限':'工作台','蝶君沙箱':'蝶君','工具':'工作台','数据与迁移':'数据与安全','关于':'关于与更新'}[widget.category] ?? widget.category ?? '通用';
  final _search=TextEditingController();String _query='';
  @override void dispose(){_search.dispose();super.dispose();}
  List<_SettingsGroup> _groups(AgentController a){
    final s=a.coreSettings;
    Future<void> save(String key,Object? v)async{await a.updateCoreSettings({key:v});if(a.coreSettings[key]!=v)throw StateError('未能保存，请重试');}
    Widget toggle(String title,String key,bool fallback)=>SettingsSwitch(title,value:s[key] as bool? ?? fallback,save:(v)=>save(key,v));
    Widget number(String title,String key,num fallback,{num min=0,num? max,bool integer=false})=>AutoSaveField(key:ValueKey(key),label:title,value:'${s[key] ?? fallback}',number:true,validator:(v){final n=num.tryParse(v);return n==null||!n.isFinite||n<min||max!=null&&n>max||integer&&n!=n.round()?'请输入有效${integer?'整数':'数值'}':null;},save:(v)=>save(key,integer?int.parse(v):num.parse(v)));
    Widget choice<T>(String title,T value,Map<T,String> choices,Future<void> Function(T) change)=>SettingChoice<T>(title,value:value,choices:choices,save:change);
    Widget model(String label,String setting)=>SettingRow(label,child:ModelSettingMenu(label:label,selected:s[setting] as String?,inheritLabel:setting=='defaultModel'?'自动':'跟对话模型一样',onChanged:(v)=>save(setting,v)));
    Widget override(String label,String purpose){final overrides=asJsonMap(s['modelOverrides']);return SettingRow(label,child:ModelSettingMenu(label:label,selected:overrides[purpose] as String?,extra:purpose=='compaction'?const {'session':'当前对话','small':'小任务模型'}:const {},onChanged:(v)=>a.updateCoreSettings({'modelOverrides':{...overrides,purpose:v}})));}
    return [
      _SettingsGroup('通用',Icons.tune,[
        _Setting('称呼 名字',EditableSetting(key:const ValueKey('userName'),title:'称呼',value:s['userName'] as String? ?? '',save:(v)=>save('userName',v.trim()))),
        const _Setting('明暗 主题 浅色 深色 跟随系统',SettingRow('明暗',child:ThemeModeControl())),
        // The theme is a preference, not a mechanism: it sits in the main list as in the 1.0 prototype.
        const _Setting('主题 名画 日间',SettingRow('日间主题',child:ThemeChoiceRow(brightness:Brightness.light))),
        const _Setting('主题 名画 夜间',SettingRow('夜间主题',child:ThemeChoiceRow(brightness:Brightness.dark))),
        _Setting('关窗口 托盘 退出',choice('关窗口时',s['closeBehavior'] as String? ?? 'tray',const {'tray':'缩到托盘','quit':'退出'},(v)async{await save('closeBehavior',v);await a.preferences.setCloseBehaviorChoice(v);})),
        _Setting('系统通知 提醒',toggle('系统通知','notifications',true)),
      ],[
        const _Setting('缩放 放大 缩小',SettingRow('界面缩放',child:ZoomControl())),
        const _Setting('文字大小 字号',SettingRow('文字大小',child:TextSizeControl())),
        const _Setting('名画 主题 预览',ThemePicker(brightness:Brightness.light)),
        const _Setting('名画 主题 预览 夜间',ThemePicker(brightness:Brightness.dark)),
      ]),
      _SettingsGroup('模型',Icons.hub_outlined,[
        _Setting('对话模型',model('对话模型','defaultModel')),
        _Setting('小任务模型 标题 记忆整理',model('小任务模型','smallTaskModel')),
        _Setting('大任务模型 整理上下文 深度分析',model('大任务模型','largeTaskModel')),
        _Setting('看图模型 图片',model('看图模型','visionModel')),
        const _Setting('渠道 服务商 密钥 连接',ChannelList()),
      ],[
        _Setting('标题 小任务',override('起标题时使用','title')),
        _Setting('记忆整理 模型',override('记忆整理时使用','memory')),
        _Setting('整理上下文 模型',override('整理上下文时使用','compaction')),
        _Setting('深度分析 模型',override('深度分析时使用','analysis')),
        _Setting('默认思考深度',choice('思考深度',a.defaultThinkingLevel??'',const {'':'自动','off':'关闭','low':'低','medium':'中','high':'高','xhigh':'很高','max':'最高'},(v)=>save('defaultThinking',v.isEmpty?null:v))),
        const _Setting('上下文长度 模型范围',ModelWindowSetting()),
        const _Setting('模型组 备用 自动切换',GroupList()),
        const _Setting('导入原有连接配置',PiCompatibilityPanel()),
      ]),
      _SettingsGroup('工作台',Icons.chat_bubble_outline,[
        _Setting('默认工作区 文件夹',AutoSaveField(key:const ValueKey('defaultWorkspace'),label:'默认工作区',value:s['defaultWorkspace'] as String? ?? a.workspace,save:(v)=>save('defaultWorkspace',v.isEmpty?null:v),suffix:IconButton(tooltip:'选择工作区',icon:const Icon(Icons.folder_open),onPressed:()async{final path=await getDirectoryPath();if(path!=null)await save('defaultWorkspace',path);}))),
        _Setting('操作前问我 批准 修改 命令',SettingsSwitch('操作前问我',value:a.approvalMode.id!='off',save:(v)=>save('approvalMode',v?'changes':'off'))),
      ],[
        _Setting('标准 极简 默认模式',choice('默认模式',a.defaultAgentMode,const {'standard':'标准','minimal':'极简'},(v)=>save('agentMode',v))),
        _Setting('操作前问我 每次',choice('询问范围',s['approvalMode'] as String? ?? 'changes',const {'changes':'修改与命令','all':'每次操作','off':'不询问'},(v)=>save('approvalMode',v))),
        const _Setting('总是允许 工具规则',_ToolRules()),
        _Setting('自动标题',toggle('自动起标题','autoTitle',true)),
        _Setting('自动整理上下文',toggle('自动整理上下文','autoCompaction',true)),
        _Setting('整理阈值',number('整理时机（%）','compactionThresholdPercent',80,min:20,max:95,integer:true)),
        _Setting('后台整理上下文',choice('后台整理',s['backgroundCompaction'] as String? ?? 'auto',const {'auto':'自动','on':'开启','off':'关闭'},(v)=>save('backgroundCompaction',v))),
        _Setting('提问等待',choice('提问时等多久',(s['askTimeoutSeconds'] as num?)?.toInt()??60,const {30:'30 秒',60:'1 分钟',300:'5 分钟',0:'一直等'},(v)=>save('askTimeoutSeconds',v))),
        _Setting('轮数上限',number('单次最多轮数','maxTurnsPerRun',60,integer:true)),
        _Setting('每天花费上限',number('每天花费上限（美元）','dailyBudgetUsd',0)),
        _Setting('每月花费上限',number('每月花费上限（美元）','monthlyBudgetUsd',0)),
        _Setting('空闲回收',number('空闲对话保留时间（分钟）','idleSessionMinutes',10,min:1,integer:true)),
        _Setting('网络 联网搜索 软件源 代理',ExpansionTile(key:ValueKey('network-$_query'),tilePadding:EdgeInsets.zero,title:const Text('网络'),initiallyExpanded:_query.isNotEmpty,children:const [WebSearchPanel(),PackageSourcesPanel()])),
      ]),
      _SettingsGroup('蝶君',Icons.auto_awesome_outlined,[
        _Setting('开工 等待',choice('开工前等你多久',(s['butterflyStartWaitSeconds'] as num?)?.toInt()??60,const {10:'10 秒',60:'1 分钟',0:'一直等'},(v)=>save('butterflyStartWaitSeconds',v))),
        _Setting('联网 沙箱',toggle('允许联网','sandboxOnline',true)),
        const _Setting('沙箱 准备 自检 重置',SandboxPanel()),
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
        _Setting('本次记忆篇幅',number('每次带上的记忆篇幅','memoryBudgetTokens',2000,min:1,integer:true)),
        _Setting('后台预算',number('每天整理预算（美元）','memoryDailyBudgetUsd',.2)),
      ]),
      _SettingsGroup('数据与安全',Icons.folder_outlined,[
        const _Setting('数据位置 存储 搬迁',DataStoragePanel(locationsOnly:true)),
        const _Setting('备份 恢复 导入 导出',BackupPanel()),
      ],[
        const _Setting('敏感路径 例外 审计',SecurityPanel()),
        const _Setting('磁盘空间 记忆历史 占用',DataStoragePanel(maintenanceOnly:true)),
      ]),
      _SettingsGroup('关于与更新',Icons.info_outline,[
        _Setting('版本 更新 开机启动',AboutPanel(openData:()=>setState(()=>_selected='数据与安全'))),
        _Setting('版本',SettingRow('DreamFlutter',child:Text('v$appVersion'))),
      ],[
        _Setting('后台版本',SettingRow('后台版本',child:Text('${a.coreInfo['version'] ?? '未连接'}'))),
      ]),
    ];
  }
  @override
  Widget build(BuildContext context){
    final a=AgentScope.of(context), groups=_groups(a), q=_query.trim().toLowerCase();
    final current=groups.where((g)=>g.name==_selected).firstOrNull??groups.first;
    bool match(_SettingsGroup g,_Setting e)=>'${g.name} ${e.searchText}'.toLowerCase().replaceAll(RegExp(r'\s+'),'').contains(q.replaceAll(RegExp(r'\s+'),''));
    Widget section(_SettingsGroup g,List<_Setting> entries,{bool advanced=false})=>Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[if(q.isNotEmpty)Padding(padding:const EdgeInsets.only(top:18,bottom:8),child:Text('${g.name}${advanced?' · 高级':''}',style:context.text.titleMedium)),for(final e in entries)e.child]);
    final content=<Widget>[];
    if(q.isEmpty){content.add(section(current,current.entries));content.add(const SizedBox(height:20));content.add(ExpansionTile(key:ValueKey('advanced-${current.name}'),tilePadding:EdgeInsets.zero,title:const Text('高级'),children:[section(current,current.advanced)]));}
    else {for(final g in groups){for(final advanced in [false,true]){final rows=(advanced?g.advanced:g.entries).where((e)=>match(g,e)).toList();if(rows.isNotEmpty)content.add(section(g,rows,advanced:advanced));}}if(content.isEmpty)content.add(const Padding(padding:EdgeInsets.all(20),child:Text('没有找到设置')));}
    Widget search()=>TextField(controller:_search,decoration:InputDecoration(hintText:'搜索设置',prefixIcon:const Icon(Icons.search),suffixIcon:q.isEmpty?null:IconButton(tooltip:'清除',icon:const Icon(Icons.close),onPressed:(){_search.clear();setState(()=>_query='');})),onChanged:(v)=>setState(()=>_query=v));
    void choose(String name)async{FocusManager.instance.primaryFocus?.unfocus();await Future<void>.delayed(Duration.zero);if(mounted)setState((){_selected=name;_query='';_search.clear();});}
    return Scaffold(body:Column(children:[
      Padding(padding:const EdgeInsets.fromLTRB(24,22,24,16),child:LayoutBuilder(builder:(context,c)=>c.maxWidth<620?Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[const PoeticPageTitle('设置'),const SizedBox(height:12),search()]):Row(children:[const Expanded(child:PoeticPageTitle('设置')),SizedBox(width:260,child:search())]))),
      Expanded(child:LayoutBuilder(builder:(context,c){
        final list=ListView(key:ValueKey('settings-${q.isEmpty?current.name:'search'}'),padding:const EdgeInsets.fromLTRB(24,0,24,28),children:content);
        if(c.maxWidth<600)return Column(children:[Padding(padding:const EdgeInsets.fromLTRB(24,0,24,12),child:DropdownButtonFormField<String>(key:ValueKey(current.name),initialValue:current.name,isExpanded:true,items:[for(final g in groups)DropdownMenuItem(value:g.name,child:Text(g.name))],onChanged:(v){if(v!=null)choose(v);})),Expanded(child:list)]);
        return Row(crossAxisAlignment:CrossAxisAlignment.stretch,children:[SizedBox(width:180,child:ListView(padding:const EdgeInsets.symmetric(horizontal:10),children:[for(final g in groups)ListTile(dense:true,selected:g.name==current.name,selectedTileColor:context.colors.card,selectedColor:context.colors.ink,shape:RoundedRectangleBorder(borderRadius:BorderRadius.circular(10)),minLeadingWidth:18,horizontalTitleGap:10,leading:Icon(g.icon,size:18),title:Text(g.name,maxLines:1,softWrap:false),onTap:()=>choose(g.name))])),const VerticalDivider(width:1),Expanded(child:list)]);
      })),
    ]));
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
    return PopupMenuButton<String>(tooltip:'选择$label',onSelected:(v)async{try{await onChanged(v.isEmpty?null:v);}catch(e){if(context.mounted)ScaffoldMessenger.of(context).showSnackBar(SnackBar(content:Text('未保存：${SessionRuntime.describeError(e)}')));}},itemBuilder:(_)=>[
      CheckedPopupMenuItem(value:'',checked:selected==null,child:Text(inheritLabel)),
      for(final e in extra.entries)CheckedPopupMenuItem(value:e.key,checked:selected==e.key,child:Text(e.value)),
      for(final m in a.models)CheckedPopupMenuItem(value:m.key,checked:selected==m.key,child:Text('${m.name} · ${a.providerLabel(m.provider)}')),
    ],child:Padding(padding:const EdgeInsets.symmetric(vertical:8),child:Row(mainAxisSize:MainAxisSize.min,children:[Flexible(child:Text(model?.name??extra[selected]??(selected==null?inheritLabel:'暂不可用'),overflow:TextOverflow.ellipsis,style:TextStyle(color:context.colors.accent))),const Icon(Icons.expand_more,size:18)])));
  }
}
