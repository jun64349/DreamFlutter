import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import '../state/agent_controller.dart';
import '../state/installation.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'home_page.dart';
import 'settings_controls.dart';
import 'settings_workspace.dart';

class WizardFrame extends StatelessWidget {
  const WizardFrame({super.key,required this.step,required this.child,this.back,this.next,this.nextLabel='下一步',this.busy=false,this.error});
  final int step; final Widget child; final VoidCallback? back,next; final String nextLabel; final bool busy; final String? error;
  @override Widget build(BuildContext context)=>Scaffold(body:Center(child:ConstrainedBox(constraints:const BoxConstraints(maxWidth:620),child:Column(children:[
    if(step>0)Padding(padding:const EdgeInsets.only(top:24,bottom:12),child:Row(mainAxisAlignment:MainAxisAlignment.center,children:[for(var i=1;i<=5;i++)Padding(padding:const EdgeInsets.all(5),child:AnimatedContainer(duration:AppTokens.motion(context,AppTokens.fast),width:i==step?22:7,height:7,decoration:BoxDecoration(color:i<=step?context.colors.accent:context.colors.border,borderRadius:BorderRadius.circular(9))))])),
    Expanded(child:SingleChildScrollView(padding:const EdgeInsets.all(28),child:AnimatedSize(duration:AppTokens.motion(context,AppTokens.medium),alignment:Alignment.topCenter,child:child))),
    if(error!=null)Padding(padding:const EdgeInsets.symmetric(horizontal:28,vertical:8),child:Text(error!,style:TextStyle(color:context.colors.danger))),
    Padding(padding:const EdgeInsets.fromLTRB(28,12,28,24),child:Row(children:[if(back!=null)TextButton(onPressed:busy?null:back,child:const Text('上一步')),const Spacer(),if(busy)const Padding(padding:EdgeInsets.only(right:16),child:SizedBox(width:18,height:18,child:CircularProgressIndicator(strokeWidth:2))),FilledButton(onPressed:busy?null:next,child:Text(nextLabel))])),
  ]))));
}

/// No backend or preferences store exists until the user chooses the root.
class FreshInstallation extends StatefulWidget {
  const FreshInstallation({super.key,required this.initialRoot,required this.launch,this.rememberRoot});
  final String initialRoot; final Future<void> Function(String) launch;final Future<void> Function(String)? rememberRoot;
  @override State<FreshInstallation> createState()=>_FreshInstallationState();
}
class _FreshInstallationState extends State<FreshInstallation>{
  int _step=0;late String _root=widget.initialRoot;int? _free;bool _busy=false;String? _error;
  @override void initState(){super.initState();_space();}
  Future<void> _space()async{final root=_root;try{final free=await Installation.freeBytes(root);if(mounted&&root==_root)setState(()=>_free=free);}catch(_){} }
  Future<void> _next()async{
    if(_step==0){setState(()=>_step=1);return;}
    setState((){_busy=true;_error=null;});
    try{if(!p.isAbsolute(_root)||File(_root).existsSync())throw ArgumentError('请选择有效的文件夹');await Directory(_root).create(recursive:true);final probe=File(p.join(_root,'.setup-write-$pid-${DateTime.now().microsecondsSinceEpoch}'));try{await probe.writeAsString('',flush:true);}finally{if(await probe.exists())await probe.delete();}await (widget.rememberRoot??Installation.remember)(_root);await widget.launch(_root);}catch(_){if(mounted)setState((){_busy=false;_error='这个位置暂时无法使用，请选择其他文件夹后重试。';});}
  }
  @override Widget build(BuildContext context)=>WizardFrame(step:_step,busy:_busy,error:_error,back:_step==1?()=>setState(()=>_step=0):null,next:_next,nextLabel:_step==0?'开始':'下一步',child:_step==0?const _Welcome():Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[Text('数据放在哪',style:context.text.headlineMedium),const SizedBox(height:28),ListTile(leading:Icon(_root==widget.initialRoot?Icons.radio_button_checked:Icons.radio_button_off),title:const Text('跟软件放在一起（推荐）'),subtitle:Text(widget.initialRoot),onTap:(){setState(()=>_root=widget.initialRoot);_space();}),ListTile(leading:const Icon(Icons.folder_open),title:const Text('选别的文件夹…'),subtitle:_root==widget.initialRoot?null:Text(_root),onTap:()async{final root=await getDirectoryPath();if(root!=null){setState(()=>_root=root);_space();}}),if(_free!=null)Padding(padding:const EdgeInsets.all(16),child:Text('剩余 ${(_free!/1073741824).toStringAsFixed(1)} GB',style:context.text.bodySmall))]));
}
class _Welcome extends StatelessWidget{
  const _Welcome();
  @override Widget build(BuildContext context)=>Padding(padding:const EdgeInsets.symmetric(vertical:65),child:Column(children:[const ButterflyMark(size:100),const SizedBox(height:28),Text('你好，我是 DreamFlutter',textAlign:TextAlign.center,style:context.text.headlineMedium?.copyWith(fontFamily:'Ma Shan Zheng')),const SizedBox(height:16),const Text('住在你电脑里的助手。花一分钟设好，就能开始。',textAlign:TextAlign.center)]));
}

class SetupGate extends StatefulWidget{
  const SetupGate({super.key,required this.dataRoot,this.initialStep=0,this.onSetupVisible});
  final String dataRoot; final int initialStep;final ValueChanged<bool>? onSetupVisible;
  @override State<SetupGate> createState()=>_SetupGateState();
}
class _SetupGateState extends State<SetupGate>{
  Json? _status;String? _error;bool _loading=false;String _progress='正在连接后台…';Timer? _timer;
  @override void initState(){super.initState();_timer=Timer.periodic(const Duration(milliseconds:250),(_)=>_readProgress());}
  Future<void> _readProgress()async{if(_status!=null)return;try{final data=jsonDecode(await File(p.join(widget.dataRoot,'core-startup.json')).readAsString()) as Map;final text=(data['current'] as Map?)?['text'];if(mounted&&text is String&&text!=_progress)setState(()=>_progress=text);}catch(_){} }
  @override void dispose(){_timer?.cancel();super.dispose();}
  Future<void> _load(AgentController a)async{if(_loading)return;_loading=true;try{final status=asJsonMap(await a.backend.call('setup.status'));if(mounted){setState((){_status=status;_error=null;});widget.onSetupVisible?.call(status['completed']!=true);}}catch(_){if(mounted)setState(()=>_error='没能读取首次设置，请重试。');}finally{_loading=false;}}
  @override Widget build(BuildContext context){final a=AgentScope.of(context);if(_status==null&&a.coreInfo.isNotEmpty&&!_loading&&_error==null)unawaited(_load(a));if(_status?['completed']==true)return const HomePage();if(_status!=null)return SetupWizard(status:_status!,initialStep:widget.initialStep,onComplete:(){setState(()=>_status={..._status!,'completed':true});widget.onSetupVisible?.call(false);});return Scaffold(body:Center(child:Padding(padding:const EdgeInsets.all(28),child:Column(mainAxisSize:MainAxisSize.min,children:[const ButterflyMark(size:84),const SizedBox(height:22),Text(_error??a.backendProblem??_progress),if(_error!=null||a.backendProblem!=null)TextButton(onPressed:()async{await a.restart();if(a.coreInfo.isNotEmpty)await _load(a);},child:const Text('重试'))]))));}
}

class SetupWizard extends StatefulWidget{
  const SetupWizard({super.key,required this.status,required this.onComplete,this.initialStep=0});
  final Json status;final VoidCallback onComplete;final int initialStep;
  @override State<SetupWizard> createState()=>_SetupWizardState();
}
class _SetupWizardState extends State<SetupWizard>{
  late int _step=widget.initialStep;late final _name=TextEditingController(text:widget.status['userName'] as String? ?? '');late final _workspace=TextEditingController(text:widget.status['defaultWorkspace'] as String? ?? '');final _key=TextEditingController(),_url=TextEditingController(),_customModel=TextEditingController();
  List<GatewayPlatform> _platforms=[];GatewayPlatform? _platform;String? _channel,_fingerprint,_testedFingerprint;Json _models={};String _sandbox='now';bool _busy=false;String? _error;final _keyFocus=FocusNode();
  AgentController get a=>AgentScope.read(context);
  @override void initState(){super.initState();_keyFocus.addListener((){if(!_keyFocus.hasFocus&&_key.text.trim().isNotEmpty)unawaited(_test());});WidgetsBinding.instance.addPostFrameCallback((_)=>_load());}
  Future<void> _load()async{try{final values=jsonRows(await a.backend.call('gateway.platforms')).map(GatewayPlatform.fromJson).toList();final configured=asJsonMap(widget.status['models'])['conversation'] as String?;if(configured!=null)await a.refreshGateway();final existing=a.gatewayChannels.where((c)=>configured?.startsWith('${c.provider}/')==true&&!c.oauth&&c.enabled).firstOrNull;if(mounted)setState((){_platforms=values;_choose(values.where((v)=>v.id==(existing?.platform??'deepseek')).firstOrNull??values.firstOrNull);if(existing!=null){_channel=existing.id;_fingerprint=_currentFingerprint;}});}catch(_){if(mounted)setState(()=>_error='没能读取服务商，请重试。');}}
  void _choose(GatewayPlatform? v){_platform=v;_channel=null;_testedFingerprint=null;_models={};_url.text=v?.endpoints.firstOrNull?.baseUrl??'';}
  String get _currentFingerprint=>jsonEncode([_platform?.id,_key.text.trim(),_url.text.trim(),_customModel.text.trim()]);
  Future<void> _test()async{
    if(_busy||_key.text.trim().isEmpty&&_channel==null||_testedFingerprint==_currentFingerprint)return;
    final platform=_platform;if(platform==null)return;
    setState((){_busy=true;_error=null;});final fingerprint=_currentFingerprint;
    try{
      if(_channel==null||_fingerprint!=fingerprint){
        final models=platform.modelDetails.isNotEmpty?platform.modelDetails:[{'id':_customModel.text.trim()}];
        if(models.any((m)=>'${m['id']??''}'.isEmpty))throw StateError('请填写模型名称');
        final saved=await a.backend.call('gateway.saveChannel',{'id':?_channel,'name':platform.name,'platform':platform.id,'kind':platform.kind,'api':platform.endpoints.firstOrNull?.api??'openai-completions','baseUrl':_url.text.trim(),'models':models,'keys':[{'secret':_key.text.trim()}]});
        _channel=saved is String?saved:asJsonMap(saved)['id'] as String?;_fingerprint=fingerprint;
      }
      if(_channel==null)throw StateError('连接未保存');
      final tested=asJsonMap(await a.backend.call('setup.testChannel',{'channel':_channel},const Duration(seconds:60)));
      if(tested['ok']!=true)throw StateError('连接没有成功，请检查密钥和地址。');
      final models=asJsonMap(await a.backend.call('setup.recommendModels',{'channel':_channel}));
      if(mounted&&_currentFingerprint==fingerprint)setState((){_models=models;_testedFingerprint=fingerprint;});
    }catch(e){if(mounted)setState(()=>_error='连接未完成：${SessionRuntime.describeError(e)}');}finally{if(mounted)setState(()=>_busy=false);}
  }
  Future<void> _next()async{
    FocusManager.instance.primaryFocus?.unfocus();
    if(_step<5){if(_step==3&&_testedFingerprint!=_currentFingerprint)return;setState((){_step++;_error=null;});return;}
    setState((){_busy=true;_error=null;});try{await a.backend.call('setup.complete',{'dataRoot':widget.status['dataRoot'],'userName':_name.text.trim(),'channelId':_channel,'models':_models,'defaultWorkspace':_workspace.text.trim().isEmpty?null:_workspace.text.trim(),'sandbox':_sandbox},const Duration(minutes:5));await a.updateCoreSettings({});if(_workspace.text.trim().isNotEmpty)await a.setWorkspace(_workspace.text.trim());await a.finishOnboarding();if(mounted)widget.onComplete();}catch(e){if(mounted)setState(()=>_error='还没完成：${SessionRuntime.describeError(e)}');}finally{if(mounted)setState(()=>_busy=false);}
  }
  @override void dispose(){for(final c in [_name,_workspace,_key,_url,_customModel]){c.dispose();}_keyFocus.dispose();super.dispose();}
  @override Widget build(BuildContext context){
    final title=['','数据放在哪','怎么称呼你','连接一个模型','常用的项目文件夹','蝶君'][_step];
    final content=<Widget>[];
    if(_step==1){content.addAll([Text('${widget.status['dataRoot']}'),const SizedBox(height:12),const Text('已有数据可在设置里按类别搬迁。')]);}
    if(_step==2)content.add(TextField(controller:_name,maxLength:100,autofocus:true,decoration:const InputDecoration(labelText:'称呼',hintText:'比如：小周')));
    if(_step==3){content.addAll([
      DropdownButtonFormField<String>(key:ValueKey(_platform?.id),initialValue:_platform?.id,isExpanded:true,decoration:const InputDecoration(labelText:'服务商'),items:[for(final v in _platforms)DropdownMenuItem(value:v.id,child:Text(v.name))],onChanged:_busy?null:(v)=>setState(()=>_choose(_platforms.firstWhere((e)=>e.id==v)))),
      const SizedBox(height:18),TextField(controller:_key,focusNode:_keyFocus,obscureText:true,enableSuggestions:false,autocorrect:false,decoration:InputDecoration(labelText:'密钥',hintText:_channel!=null?'留空沿用已保存的密钥':null),onChanged:(_)=>setState(()=>_testedFingerprint=null),onSubmitted:(_)=>_test(),onTapOutside:(_)=>_keyFocus.unfocus()),
      if(_platform?.endpoints.isEmpty??false)...[const SizedBox(height:16),TextField(controller:_url,decoration:const InputDecoration(labelText:'服务地址'),onChanged:(_)=>setState(()=>_testedFingerprint=null)),const SizedBox(height:16),TextField(controller:_customModel,decoration:const InputDecoration(labelText:'模型名称'),onChanged:(_)=>setState(()=>_testedFingerprint=null))],
      const SizedBox(height:12),Align(alignment:Alignment.centerLeft,child:TextButton(onPressed:_busy?null:_test,child:Text(_testedFingerprint==_currentFingerprint?'连接成功':'测试连接'))),
      if(_testedFingerprint==_currentFingerprint)for(final role in [('对话模型','conversation'),('小任务模型','small'),('大任务模型','large')])SettingRow(role.$1,child:ModelSettingMenu(label:role.$1,selected:_models[role.$2] as String?,extra:{for(final value in _models.values.whereType<String>())value:modelDisplayName(a,value,fallback:{for(final m in _platform?.modelDetails??<Json>[]) '${m['id']}':'${m['name']??m['id']}'})},onChanged:(v)async{setState(()=>_models={..._models,role.$2:v});})),
      if(_platforms.isEmpty)TextButton(onPressed:_load,child:const Text('重试')),
    ]);}
    if(_step==4)content.addAll([TextField(controller:_workspace,decoration:InputDecoration(labelText:'文件夹（可跳过）',suffixIcon:IconButton(tooltip:'选择文件夹',icon:const Icon(Icons.folder_open),onPressed:()async{final v=await getDirectoryPath();if(v!=null)_workspace.text=v;}))),const SizedBox(height:12),Align(alignment:Alignment.centerLeft,child:TextButton(onPressed:(){_workspace.clear();_next();},child:const Text('跳过')))]);
    if(_step==5)content.addAll([ListTile(leading:Icon(_sandbox=='now'?Icons.radio_button_checked:Icons.radio_button_off),title:const Text('现在准备沙箱（推荐）'),onTap:()=>setState(()=>_sandbox='now')),ListTile(leading:Icon(_sandbox=='later'?Icons.radio_button_checked:Icons.radio_button_off),title:const Text('以后再说'),onTap:()=>setState(()=>_sandbox='later'))]);
    return WizardFrame(step:_step,busy:_busy,error:_error,back:_step>0?()=>setState((){_step--;_error=null;}):null,next:_step==3&&_testedFingerprint!=_currentFingerprint?null:_next,nextLabel:_step==0?'开始':_step==5?'开始使用':'下一步',child:_step==0?const _Welcome():Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[Text(title,style:context.text.headlineMedium),const SizedBox(height:28),...content]));
  }
}
