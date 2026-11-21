import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import '../state/agent_controller.dart';
import '../state/beta_edition.dart';
import 'beta_activation.dart';
import '../state/installation.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'home_page.dart';
import 'motion.dart';
import 'settings_restore.dart';
import 'shell_widgets.dart';

const _setupStepCount = 3;

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
          for(var i=1;i<=_setupStepCount;i++)...[
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
            textStyle:const WidgetStatePropertyAll(TextStyle(fontFamily:AppTokens.fontFamily,fontFamilyFallback:AppTokens.fontFallback,fontSize:13,height:1.6)),
          ),
          onPressed:busy?null:next,child:Text(nextLabel),
        ))
        else Wrap(alignment:WrapAlignment.spaceBetween,runSpacing:8,children:[
          if(back!=null)ShellButton('上一步',kind:ShellButtonKind.ghost,onPressed:busy?null:back),
          if(back==null)const SizedBox.shrink(),
          Wrap(spacing:8,crossAxisAlignment:WrapCrossAlignment.center,children:[
            if(busy)const SizedBox(width:18,height:18,child:CircularProgressIndicator(strokeWidth:2)),
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
  @override Widget build(BuildContext context){final a=AgentScope.of(context);if(_status==null&&a.coreInfo.isNotEmpty&&!_loading&&_error==null)unawaited(_load(a));if(_status?['completed']==true)return const HomePage();if(_preserved!=null)return Scaffold(body:PreservedDataWelcome(candidate:_preserved!,onContinue:()=>setState(()=>_preserved=null),onRestored:()=>_load(a)));if(_status!=null){void done(){setState(()=>_status={..._status!,'completed':true});widget.onSetupVisible?.call(false);}return kBetaEdition?BetaActivation(status:_status!,onComplete:done):SetupWizard(status:_status!,initialStep:widget.initialStep,onComplete:done);}return Scaffold(body:Center(child:Padding(padding:const EdgeInsets.all(28),child:Column(mainAxisSize:MainAxisSize.min,children:[const ButterflyMark(size:84),const SizedBox(height:22),Text(_error??a.backendProblem??_progress),if(_error!=null||a.backendProblem!=null)TextButton(onPressed:()async{await a.restart();if(a.coreInfo.isNotEmpty)await _load(a);},child:const Text('重试'))]))));}
}

class SetupWizard extends StatefulWidget{
  const SetupWizard({super.key,required this.status,required this.onComplete,this.initialStep=0});
  final Json status;
  final VoidCallback onComplete;
  final int initialStep;
  @override State<SetupWizard> createState()=>_SetupWizardState();
}
class _SetupWizardState extends State<SetupWizard> {
  late int _step = widget.initialStep;
  late final _name = TextEditingController(text: widget.status['userName'] as String? ?? '');
  late final _workspace = TextEditingController(text: widget.status['defaultWorkspace'] as String? ?? '');
  bool _busy = false;
  String? _error;

  Future<void> _next({bool clearWorkspace = false}) async {
    FocusManager.instance.primaryFocus?.unfocus();
    if (_step < _setupStepCount) {
      setState(() { _step++; _error = null; });
      return;
    }
    if (_busy) return;
    if (clearWorkspace) _workspace.clear();
    final workspace = _workspace.text.trim();
    final agent = AgentScope.read(context);
    setState(() { _busy = true; _error = null; });
    try {
      await agent.backend.call('setup.complete', {
        'dataRoot': widget.status['dataRoot'],
        'userName': _name.text.trim(),
        'defaultWorkspace': workspace.isEmpty ? null : workspace,
      });
      await agent.updateCoreSettings({});
      if (workspace.isNotEmpty) await agent.setWorkspace(workspace);
      await agent.finishOnboarding();
      if (mounted) widget.onComplete();
    } catch (e) {
      if (mounted) setState(() => _error = '还没完成：${SessionRuntime.describeError(e)}');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _name.dispose();
    _workspace.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final child = switch (_step) {
      1 => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        _wizardHeading(context, '数据放在哪', '对话、记忆、设置都存在这里'),
        Container(padding: const EdgeInsets.all(12), decoration: BoxDecoration(color: context.colors.sunk, borderRadius: BorderRadius.circular(8)),
          child: Text('${widget.status['dataRoot']}', style: context.text.bodySmall?.copyWith(fontFamily: AppTokens.monoFamily))),
        const SizedBox(height: 12),
        Text('已有数据可在设置里按类别搬迁。', style: context.text.bodySmall?.copyWith(color: context.colors.muted)),
      ]),
      2 => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        _wizardHeading(context, '怎么称呼你', '随时能改'),
        TextField(controller: _name, maxLength: 100, autofocus: true,
          decoration: const InputDecoration(labelText: '称呼', hintText: '比如：小周')),
      ]),
      _setupStepCount => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        _wizardHeading(context, '常用的项目文件夹', '工作台默认在这里干活'),
        TextField(controller: _workspace, decoration: InputDecoration(
          labelText: '文件夹', hintText: '还没有选',
          suffixIcon: IconButton(tooltip: '选择文件夹', icon: const Icon(Icons.folder_open), onPressed: () async {
            final path = await getDirectoryPath();
            if (mounted && path != null) _workspace.text = path;
          }),
        )),
      ]),
      _ => const _Welcome(),
    };
    final last = _step == _setupStepCount;
    return WizardFrame(
      step: _step, busy: _busy, error: _error,
      back: _step > 0 ? () => setState(() { _step--; _error = null; }) : null,
      next: _next,
      skip: last ? () => _next(clearWorkspace: true) : null,
      nextLabel: _step == 0 ? '开始' : last ? '开始使用' : '下一步',
      child: child,
    );
  }
}
