import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:url_launcher/url_launcher.dart';
import '../state/agent_controller.dart';
import '../state/installation.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'home_page.dart';
import 'motion.dart';
import 'proto_icon.dart';
import 'settings_controls.dart';
import 'settings_workspace.dart';
import 'settings_butterfly.dart';
import 'settings_restore.dart';
import 'shell_widgets.dart';

class WizardFrame extends StatelessWidget {
  const WizardFrame({super.key,required this.step,required this.child,this.back,this.next,this.nextLabel='下一步',this.busy=false,this.error,this.skip});
  final int step;
  final Widget child;
  final VoidCallback? back,next,skip;
  final String nextLabel;
  final bool busy;
  final String? error;
  @override Widget build(BuildContext context)=>Scaffold(body:PaintingBackdrop(surface:PaintingSurface.home,showMotif:false,child:LayoutBuilder(builder:(context,bounds)=>Stack(children:[
    // .wzbg：顶部 30% 处一团 card → bg 的 radial 高光。
    Positioned.fill(child:DecoratedBox(decoration:BoxDecoration(gradient:RadialGradient(center:const Alignment(0,-.4),radius:1.1,colors:[context.colors.card,context.colors.background],stops:const [0,.7])))),
    if(bounds.maxWidth>=700)Positioned(left:48,top:60,child:ExcludeSemantics(child:Opacity(opacity:.18,child:Text('昔者庄周梦为胡蝶'.characters.join('\n'),style:context.handwriting(context.text.titleLarge).copyWith(fontSize:22,height:1.32))))),
    Positioned(right:-60,bottom:-80,child:ExcludeSemantics(child:Opacity(opacity:.07,child:Transform.rotate(angle:-.244,child:const SizedBox.square(dimension:520,child:Center(child:ButterflyMark(size:325))))))),
    // .wz：520 宽的卡片，垂直居中；内容比窗口高时退回顶部滚动。
    SafeArea(child:SingleChildScrollView(padding:const EdgeInsets.all(24),child:ConstrainedBox(constraints:BoxConstraints(minHeight:(bounds.maxHeight-48).clamp(0,double.infinity)),child:Center(child:ConstrainedBox(constraints:const BoxConstraints(maxWidth:520),child:Material(
      color:context.colors.card,
      elevation:12,
      shadowColor:context.colors.ink.withValues(alpha:.18),
      shape:RoundedRectangleBorder(borderRadius:BorderRadius.circular(20)),
      clipBehavior:Clip.antiAlias,
      child:Padding(padding:const EdgeInsets.fromLTRB(30,26,30,20),child:Column(mainAxisSize:MainAxisSize.min,crossAxisAlignment:CrossAxisAlignment.stretch,children:[
        if(step>0)Row(mainAxisAlignment:MainAxisAlignment.center,children:[
          for(var i=1;i<=5;i++)...[
            if(i>1)const SizedBox(width:6),
            AnimatedContainer(duration:AppTokens.motion(context,AppTokens.fast),width:i==step?18:7,height:7,
              decoration:BoxDecoration(color:i==step?context.colors.accent:i<step?Color.lerp(context.colors.border,context.colors.accent,.45):context.colors.border,borderRadius:BorderRadius.circular(4))),
          ],
        ]),
        if(step>0)const SizedBox(height:8),
        FadeSlideIn(key:ValueKey(step),child:child),
        if(error!=null)Padding(padding:const EdgeInsets.only(top:14),child:Text(error!,style:TextStyle(color:context.colors.danger))),
        const SizedBox(height:20),
        if(step==0)Center(child:TextButton(
          style:shellButtonStyle(context,ShellButtonKind.primary,small:true).copyWith(
            padding:const WidgetStatePropertyAll(EdgeInsets.symmetric(horizontal:34,vertical:8)),
            shape:WidgetStatePropertyAll(RoundedRectangleBorder(borderRadius:BorderRadius.circular(9))),
            textStyle:const WidgetStatePropertyAll(TextStyle(fontSize:13,height:1.6)),
          ),
          onPressed:busy?null:next,child:Text(nextLabel),
        ))
        else Wrap(alignment:WrapAlignment.spaceBetween,runSpacing:8,children:[
          if(back!=null)ShellButton('上一步',kind:ShellButtonKind.ghost,onPressed:busy?null:back),
          if(back==null)const SizedBox.shrink(),
          Wrap(spacing:8,crossAxisAlignment:WrapCrossAlignment.center,children:[
            if(busy&&step!=3)const SizedBox(width:18,height:18,child:CircularProgressIndicator(strokeWidth:2)),
            if(skip!=null)ShellButton('跳过',kind:ShellButtonKind.ghost,onPressed:busy?null:skip),
            Opacity(opacity: busy || next == null ? .45 : 1, child: ShellButton(nextLabel,kind:ShellButtonKind.primary,onPressed:busy?null:next)),
          ]),
        ]),
        if(step==0)const SizedBox(height:6),
      ])),
    ))))))
  ]))));
}

Widget _wizardHeading(BuildContext context, String title, String subtitle) => Column(children:[
  Text(title,textAlign:TextAlign.center,style:context.serif(context.text.titleLarge).copyWith(fontSize:20,height:1.6,fontWeight:FontWeight.w600)),
  const SizedBox(height:2),
  Text(subtitle,textAlign:TextAlign.center,style:context.text.bodySmall?.copyWith(fontSize:13,height:1.6,color:context.colors.muted)),
  const SizedBox(height:18),
]);

class _WizardChoice extends StatelessWidget {
  const _WizardChoice({required this.title,required this.selected,required this.onTap,this.subtitle});
  final String title;
  final String? subtitle;
  final bool selected;
  final VoidCallback onTap;
  @override Widget build(BuildContext context)=>Padding(padding:const EdgeInsets.only(bottom:8),child:
    ShellCard(selected:selected,onTap:onTap,padding:const EdgeInsets.symmetric(horizontal:14,vertical:11),child:Row(crossAxisAlignment:CrossAxisAlignment.start,children:[
      Padding(padding:const EdgeInsets.only(top:2),child:Container(width:16,height:16,decoration:BoxDecoration(shape:BoxShape.circle,border:Border.all(color:selected?context.colors.accent:context.colors.muted,width:selected?5:1.5)))),
      const SizedBox(width:10),
      Expanded(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
        Text(title,style:context.text.bodyMedium?.copyWith(height:1.6)),
        if(subtitle!=null)Text(subtitle!,style:context.text.bodySmall?.copyWith(fontSize:12,height:1.6,color:context.colors.muted)),
      ])),
    ])));
}

/// No backend or preferences store exists until the user chooses the root.
class FreshInstallation extends StatefulWidget {
  const FreshInstallation({super.key,required this.initialRoot,required this.launch,this.rememberRoot});
  final String initialRoot;
  final Future<void> Function(String) launch;
  final Future<void> Function(String)? rememberRoot;
  @override State<FreshInstallation> createState()=>_FreshInstallationState();
}
class _FreshInstallationState extends State<FreshInstallation>{
  int _step=0;
  late String _root=widget.initialRoot;
  int? _free;
  bool _busy=false;
  String? _error;
  @override void initState(){super.initState();_space();}
  Future<void> _space()async{final root=_root;try{final free=await Installation.freeBytes(root);if(mounted&&root==_root)setState(()=>_free=free);}catch(_){} }
  Future<void> _next()async{
    if(_step==0){setState(()=>_step=1);return;}
    setState((){_busy=true;_error=null;});
    try{if(!p.isAbsolute(_root)||File(_root).existsSync())throw ArgumentError('请选择有效的文件夹');await Directory(_root).create(recursive:true);final probe=File(p.join(_root,'.setup-write-$pid-${DateTime.now().microsecondsSinceEpoch}'));try{await probe.writeAsString('',flush:true);}finally{if(await probe.exists())await probe.delete();}await (widget.rememberRoot??Installation.remember)(_root);await widget.launch(_root);}catch(_){if(mounted)setState((){_busy=false;_error='这个位置暂时无法使用，请选择其他文件夹后重试。';});}
  }
  @override Widget build(BuildContext context){
    final standard=_root==widget.initialRoot;
    final path=standard?widget.initialRoot:_root;
    final location='${path.isEmpty?'未选择':path}${_free==null?'':' · 剩余 ${(_free!/1073741824).toStringAsFixed(1)} GB'}';
    return WizardFrame(step:_step,busy:_busy,error:_error,back:_step==1?()=>setState(()=>_step=0):null,next:_next,nextLabel:_step==0?'开始':'下一步',child:_step==0?const _Welcome():Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[
      _wizardHeading(context,'数据放在哪','对话、记忆、设置都存在这里'),
      _WizardChoice(title:'跟软件放在一起（推荐）',subtitle:location,selected:standard,onTap:(){setState(()=>_root=widget.initialRoot);_space();}),
      _WizardChoice(title:'选别的文件夹…',subtitle:standard?null:location,selected:!standard,onTap:()async{final root=await getDirectoryPath();if(root!=null){setState(()=>_root=root);_space();}}),
    ]));
  }
}
class _Welcome extends StatelessWidget{
  const _Welcome();
  @override Widget build(BuildContext context)=>Padding(padding:const EdgeInsets.only(top:20),child:Column(children:[
    const SizedBox.square(dimension:96,child:Center(child:ButterflyMark(size:60))),
    const SizedBox(height:16),
    Text('你好，我是 DreamFlutter',textAlign:TextAlign.center,style:context.handwriting(context.text.headlineMedium).copyWith(fontSize:30,height:1.6,fontWeight:FontWeight.w400)),
    const SizedBox(height:2),
    Text('住在你电脑里的助手。花一分钟设好，就能开始。',textAlign:TextAlign.center,style:context.text.bodySmall?.copyWith(fontSize:13,height:1.6,color:context.colors.muted)),
  ]));
}

class SetupGate extends StatefulWidget{
  const SetupGate({super.key,required this.dataRoot,this.initialStep=0,this.onSetupVisible});
  final String dataRoot;
  final int initialStep;
  final ValueChanged<bool>? onSetupVisible;
  @override State<SetupGate> createState()=>_SetupGateState();
}
class _SetupGateState extends State<SetupGate>{
  Json? _preserved;
  Json? _status;
  String? _error;
  bool _loading=false;
  String _progress='正在连接后台…';
  Timer? _timer;
  @override void initState(){super.initState();_timer=Timer.periodic(const Duration(milliseconds:250),(_)=>_readProgress());}
  Future<void> _readProgress()async{if(_status!=null)return;try{final data=jsonDecode(await File(p.join(widget.dataRoot,'core-startup.json')).readAsString()) as Map;final text=(data['current'] as Map?)?['text'];if(mounted&&text is String&&text!=_progress)setState(()=>_progress=text);}catch(_){} }
  @override void dispose(){_timer?.cancel();super.dispose();}
  Future<void> _load(AgentController a)async{if(_loading)return;_loading=true;try{final status=asJsonMap(await a.backend.call('setup.status'));final candidates=status['completed']==true?<Json>[]:await preservedCandidates(a);if(mounted){setState((){_status=status;_preserved=candidates.firstOrNull;_error=null;});widget.onSetupVisible?.call(status['completed']!=true);}}catch(_){if(mounted)setState(()=>_error='没能读取首次设置，请重试。');}finally{_loading=false;}}
  @override Widget build(BuildContext context){final a=AgentScope.of(context);if(_status==null&&a.coreInfo.isNotEmpty&&!_loading&&_error==null)unawaited(_load(a));if(_status?['completed']==true)return const HomePage();if(_preserved!=null)return Scaffold(body:PreservedDataWelcome(candidate:_preserved!,onContinue:()=>setState(()=>_preserved=null),onRestored:()=>_load(a)));if(_status!=null)return SetupWizard(status:_status!,initialStep:widget.initialStep,onComplete:(){setState(()=>_status={..._status!,'completed':true});widget.onSetupVisible?.call(false);});return Scaffold(body:Center(child:Padding(padding:const EdgeInsets.all(28),child:Column(mainAxisSize:MainAxisSize.min,children:[const ButterflyMark(size:84),const SizedBox(height:22),Text(_error??a.backendProblem??_progress),if(_error!=null||a.backendProblem!=null)TextButton(onPressed:()async{await a.restart();if(a.coreInfo.isNotEmpty)await _load(a);},child:const Text('重试'))]))));}
}

class SetupWizard extends StatefulWidget{
  const SetupWizard({super.key,required this.status,required this.onComplete,this.initialStep=0});
  final Json status;
  final VoidCallback onComplete;
  final int initialStep;
  @override State<SetupWizard> createState()=>_SetupWizardState();
}
class _SetupWizardState extends State<SetupWizard>{
  late int _step=widget.initialStep;
  late final _name=TextEditingController(text:widget.status['userName'] as String? ?? '');
  late final _workspace=TextEditingController(text:widget.status['defaultWorkspace'] as String? ?? '');
  final _key=TextEditingController(),_url=TextEditingController(),_customModel=TextEditingController();
  List<GatewayPlatform> _platforms=[];
  GatewayPlatform? _platform;
  String? _channel,_fingerprint,_testedFingerprint;
  Json _models={};
  String _sandbox='now';
  bool _busy=false;
  String? _error;
  final _keyFocus=FocusNode();
  Timer? _keyDebounce;
  AgentController get a=>AgentScope.read(context);
  @override void initState(){super.initState();_keyFocus.addListener((){if(!_keyFocus.hasFocus&&_key.text.trim().isNotEmpty)unawaited(_test());});WidgetsBinding.instance.addPostFrameCallback((_)=>_load());}
  Future<void> _load()async{try{final values=jsonRows(await a.backend.call('gateway.platforms')).map(GatewayPlatform.fromJson).toList();final configured=asJsonMap(widget.status['models'])['conversation'] as String?;if(configured!=null)await a.refreshGateway();final existing=a.gatewayChannels.where((c)=>configured?.startsWith('${c.provider}/')==true&&!c.oauth&&c.enabled).firstOrNull;if(mounted)setState((){_platforms=values;_choose(values.where((v)=>v.id==(existing?.platform??'deepseek')).firstOrNull??values.firstOrNull);if(existing!=null){_channel=existing.id;_fingerprint=_currentFingerprint;}});}catch(_){if(mounted)setState(()=>_error='没能读取服务商，请重试。');}}
  void _choose(GatewayPlatform? v){_keyDebounce?.cancel();_platform=v;_channel=null;_testedFingerprint=null;_models={};_url.text=v?.endpoints.firstOrNull?.baseUrl??'';_error=null;}
  String get _currentFingerprint=>jsonEncode([_platform?.id,_key.text.trim(),_url.text.trim(),_customModel.text.trim()]);
  void _keyChanged(String value){_keyDebounce?.cancel();setState(()=>_testedFingerprint=null);if(value.trim().isEmpty)return;_keyDebounce=Timer(const Duration(milliseconds:350),()=>unawaited(_test()));}
  Future<void> _test()async{
    if(_busy||_key.text.trim().isEmpty&&_channel==null||_testedFingerprint==_currentFingerprint)return;
    final platform=_platform;
    if(platform==null)return;
    setState((){_busy=true;_error=null;});
    final fingerprint=_currentFingerprint;
    try{
      if(_channel==null||_fingerprint!=fingerprint){
        final models=platform.modelDetails.isNotEmpty?platform.modelDetails:[{'id':_customModel.text.trim()}];
        if(models.any((m)=>'${m['id']??''}'.isEmpty))throw StateError('请填写模型名称');
        final saved=await a.backend.call('gateway.saveChannel',{'id':?_channel,'name':platform.name,'platform':platform.id,'kind':platform.kind,'api':platform.endpoints.firstOrNull?.api??'openai-completions','baseUrl':_url.text.trim(),'models':models,'keys':[{'secret':_key.text.trim()}]});
        _channel=saved is String?saved:asJsonMap(saved)['id'] as String?;
        _fingerprint=fingerprint;
      }
      if(_channel==null)throw StateError('连接未保存');
      final tested=asJsonMap(await a.backend.call('setup.testChannel',{'channel':_channel},const Duration(seconds:60)));
      if(tested['ok']!=true)throw StateError('连接没有成功，请检查密钥和地址。');
      final models=asJsonMap(await a.backend.call('setup.recommendModels',{'channel':_channel}));
      if(mounted&&_currentFingerprint==fingerprint)setState((){_models=models;_testedFingerprint=fingerprint;});
    }catch(e){if(mounted)setState(()=>_error='连接未完成：${SessionRuntime.describeError(e)}');}finally{if(mounted)setState(()=>_busy=false);}
  }
  void _skipModel(){_keyDebounce?.cancel();_key.clear();setState((){_channel=null;_fingerprint=null;_testedFingerprint=null;_models={};_step=4;_error=null;});}
  Future<void> _next({bool clearWorkspace=false})async{
    FocusManager.instance.primaryFocus?.unfocus();
    if(clearWorkspace)_workspace.clear();
    if(_step<5){if(_step==3&&_testedFingerprint!=_currentFingerprint)return;setState((){_step++;_error=null;});return;}
    setState((){_busy=true;_error=null;});
    try{await a.backend.call('setup.complete',{'dataRoot':widget.status['dataRoot'],'userName':_name.text.trim(),'channelId':_channel,'models':_models,'defaultWorkspace':_workspace.text.trim().isEmpty?null:_workspace.text.trim(),'sandbox':_sandbox},const Duration(minutes:5));await a.updateCoreSettings({});if(_workspace.text.trim().isNotEmpty)await a.setWorkspace(_workspace.text.trim());await a.finishOnboarding();if(mounted)widget.onComplete();}catch(e){if(mounted)setState(()=>_error='还没完成：${SessionRuntime.describeError(e)}');}finally{if(mounted)setState(()=>_busy=false);}
  }
  @override void dispose(){_keyDebounce?.cancel();for(final c in [_name,_workspace,_key,_url,_customModel]){c.dispose();}_keyFocus.dispose();super.dispose();}
  @override Widget build(BuildContext context){
    final title=['','数据放在哪','怎么称呼你','连接一个模型','常用的项目文件夹','蝶君'][_step];
    final subtitle=['','对话、记忆、设置都存在这里','随时能改','密钥只存在这台电脑上','工作台默认在这里干活','选一种说话的样子，以后可以在设置里改'][_step];
    final content=<Widget>[];
    if(_step==1)content.addAll([Container(padding:const EdgeInsets.all(12),decoration:BoxDecoration(color:context.colors.sunk,borderRadius:BorderRadius.circular(8)),child:Text('${widget.status['dataRoot']}',style:context.text.bodySmall?.copyWith(fontFamily:AppTokens.monoFamily))),const SizedBox(height:12),Text('已有数据可在设置里按类别搬迁。',style:context.text.bodySmall?.copyWith(color:context.colors.muted))]);
    if(_step==2)content.add(TextField(controller:_name,maxLength:100,autofocus:true,decoration:const InputDecoration(labelText:'称呼',hintText:'比如：小周')));
    if(_step==3){
      final colors=context.colors;
      final keyUrl=switch(_platform?.id){
        'deepseek'=>'https://platform.deepseek.com/api_keys',
        'glm'=>'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
        'opencode-go'=>'https://opencode.ai/console',
        _=>null,
      };
      final border=OutlineInputBorder(borderRadius:BorderRadius.circular(10),borderSide:BorderSide.none);
      final tested=_testedFingerprint==_currentFingerprint;
      content.addAll([
      LayoutBuilder(builder:(context,bounds){
        final columns=bounds.maxWidth>=360?4:2;
        return Wrap(spacing:8,runSpacing:8,children:[
          for(final platform in _platforms)SizedBox(width:(bounds.maxWidth-8*(columns-1))/columns,child:Semantics(
            selected:_platform?.id==platform.id,
            child:TextButton(onPressed:_busy?null:()=>setState(()=>_choose(platform)),style:TextButton.styleFrom(
              foregroundColor:colors.ink,backgroundColor:colors.background,
              minimumSize:Size.zero,tapTargetSize:MaterialTapTargetSize.shrinkWrap,visualDensity:VisualDensity.standard,
              padding:const EdgeInsets.symmetric(horizontal:6,vertical:9),
              shape:RoundedRectangleBorder(borderRadius:BorderRadius.circular(10)),
              side:BorderSide(color:_platform?.id==platform.id?colors.accent:colors.hairline,width:_platform?.id==platform.id?2:1),
              textStyle:context.text.bodySmall?.copyWith(fontSize:13,height:1.6),
            ),child:Text(platform.name,textAlign:TextAlign.center)),
          )),
        ]);
      }),
      const SizedBox(height:10),
      Row(children:[
        Text('密钥',style:context.text.bodySmall?.copyWith(fontSize:12.5,color:colors.muted)),
        const Spacer(),
        if(keyUrl!=null)TextButton(
          onPressed:()async{
            if(!await launchUrl(Uri.parse(keyUrl),mode:LaunchMode.externalApplication)&&mounted){
              setState(()=>_error='暂时打不开服务商网站，请在浏览器里打开。');
            }
          },
          style:TextButton.styleFrom(foregroundColor:colors.accent,padding:EdgeInsets.zero,minimumSize:Size.zero,tapTargetSize:MaterialTapTargetSize.shrinkWrap,textStyle:context.text.bodySmall?.copyWith(fontSize:12.5)),
          child:Text('去 ${_platform!.name} 拿密钥 ↗'),
        ),
      ]),
      const SizedBox(height:5),
      Semantics(label:'密钥',child:TextField(
        key:const ValueKey('setup-model-key'),controller:_key,focusNode:_keyFocus,obscureText:true,enableSuggestions:false,autocorrect:false,
        decoration:InputDecoration(hintText:_channel!=null?'留空沿用已保存的密钥':'粘贴后自动测试',isDense:true,filled:true,fillColor:colors.sunk,border:border,enabledBorder:border,
          contentPadding:const EdgeInsets.symmetric(horizontal:12,vertical:9)),
        onChanged:_keyChanged,onSubmitted:(_)=>_test(),onTapOutside:(_)=>_keyFocus.unfocus(),
      )),
      if(_platform?.endpoints.isEmpty??false)...[const SizedBox(height:16),TextField(controller:_url,decoration:const InputDecoration(labelText:'服务地址'),onChanged:(_)=>setState(()=>_testedFingerprint=null)),const SizedBox(height:16),TextField(controller:_customModel,decoration:const InputDecoration(labelText:'模型名称'),onChanged:(_)=>setState(()=>_testedFingerprint=null))],
      if(_busy||tested||_key.text.trim().isNotEmpty||_channel!=null)Padding(padding:const EdgeInsets.only(top:10),child:Row(children:[
        if(_busy)...[
          const SizedBox.square(dimension:12,child:CircularProgressIndicator(strokeWidth:1.5)),
          const SizedBox(width:8),
          Text('正在试连接…',style:context.text.bodySmall?.copyWith(fontSize:13,color:colors.muted)),
        ]else if(tested)...[
          ProtoIcon('check',size:14,color:colors.success),const SizedBox(width:6),
          Text('连接成功',style:context.text.bodySmall?.copyWith(fontSize:13,color:colors.success)),
        ]else IconButton(tooltip:'测试连接',onPressed:_test,icon:ProtoIcon('refresh',color:colors.muted)),
      ])),
      if(_testedFingerprint==_currentFingerprint)for(final role in [('对话模型','conversation'),('小任务模型','small'),('大任务模型','large')])SettingRow(role.$1,child:ModelSettingMenu(label:role.$1,selected:_models[role.$2] as String?,extra:{for(final value in _models.values.whereType<String>())value:modelDisplayName(a,value,fallback:{for(final m in _platform?.modelDetails??<Json>[]) '${m['id']}':'${m['name']??m['id']}'})},onChanged:(v)async{setState(()=>_models={..._models,role.$2:v});})),
      if(_platforms.isEmpty)TextButton(onPressed:_load,child:const Text('重试')),
    ]);}
    if(_step==4)content.add(TextField(controller:_workspace,decoration:InputDecoration(labelText:'文件夹',hintText:'还没有选',suffixIcon:IconButton(tooltip:'选择文件夹',icon:const Icon(Icons.folder_open),onPressed:()async{final v=await getDirectoryPath();if(v!=null)_workspace.text=v;}))));
    if(_step==5)content.addAll([const PersonaChoices(wizard:true),const SizedBox(height:18),_WizardChoice(title:'现在准备沙箱（推荐）',subtitle:'后台进行，不影响先用工作台',selected:_sandbox=='now',onTap:()=>setState(()=>_sandbox='now')),_WizardChoice(title:'以后再说',selected:_sandbox=='later',onTap:()=>setState(()=>_sandbox='later'))]);
    return WizardFrame(step:_step,busy:_busy,error:_error,back:_step>0?()=>setState((){_step--;_error=null;}):null,next:_step==3&&_testedFingerprint!=_currentFingerprint?null:_next,skip:_step==3?_skipModel:_step==4?()=>_next(clearWorkspace:true):null,nextLabel:_step==0?'开始':_step==5?'开始使用':'下一步',child:_step==0?const _Welcome():Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[_wizardHeading(context,title,subtitle),...content]));
  }
}
