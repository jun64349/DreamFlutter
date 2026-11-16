import 'dart:io' show pid;
import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';
import '../state/agent_controller.dart';
import '../state/memory_ui.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'settings_controls.dart';
import 'shell_widgets.dart' show ShellButtonKind, shellButtonStyle;

class UninstallSetting extends StatelessWidget {
  const UninstallSetting({super.key});
  @override Widget build(BuildContext context)=>SettingRow('卸载 DreamFlutter',desc:'会先问你要不要保留数据',
    child:TextButton(onPressed:()=>showDialog<void>(context:context,builder:(_)=>const UninstallDialog()),
      style:shellButtonStyle(context,ShellButtonKind.normal,small:true).copyWith(foregroundColor:WidgetStatePropertyAll(context.colors.seal)),
      child:const Text('卸载…')));
}
class UninstallDialog extends StatefulWidget {
  const UninstallDialog({super.key});
  @override State<UninstallDialog> createState()=>_UninstallDialogState();
}
class _UninstallDialogState extends State<UninstallDialog>{
  bool keep=false,busy=false;String? error;
  // uninstall.start writes or clears the keep-data marker, then a detached helper waits for this window
  // and the core to exit before running Velopack's Update.exe uninstall.
  Future<void> uninstall()async{
    final agent=AgentScope.read(context);
    setState((){busy=true;error=null;});
    try{
      await agent.backend.call('uninstall.start',{'keepData':keep,'windowPid':pid});
      await agent.closeWindowForUninstall?.call();
    }catch(e){if(mounted)setState((){busy=false;error=SessionRuntime.describeError(e);});}
  }
  @override Widget build(BuildContext context)=>AlertDialog(title:const Text('卸载 DreamFlutter'),content:SizedBox(width:480,child:Column(mainAxisSize:MainAxisSize.min,children:[
    ListTile(onTap:()=>setState(()=>keep=false),leading:Icon(keep?Icons.radio_button_unchecked:Icons.radio_button_checked),title:const Text('全部清干净'),subtitle:const Text('对话、记忆、设置、蝶君沙箱都删除。')),
    ListTile(onTap:()=>setState(()=>keep=true),leading:Icon(keep?Icons.radio_button_checked:Icons.radio_button_unchecked),title:const Text('保留我的数据'),subtitle:const Text('只删程序和蝶君沙箱。以后在原位置重装，可以找回。')),
    if(error!=null)Padding(padding:const EdgeInsets.only(top:8),child:Text(error!,style:TextStyle(color:context.colors.seal))),
  ])),actions:[TextButton(onPressed:busy?null:()=>Navigator.pop(context),child:const Text('取消')),
    OutlinedButton(style:OutlinedButton.styleFrom(foregroundColor:context.colors.seal,side:BorderSide(color:context.colors.seal)),onPressed:busy?null:uninstall,child:const Text('卸载')),
  ]);
}

class PreservedDataWelcome extends StatefulWidget {
  const PreservedDataWelcome({super.key,required this.candidate,required this.onContinue,this.onRestored});
  final Json candidate; final VoidCallback onContinue; final VoidCallback? onRestored;
  @override State<PreservedDataWelcome> createState()=>_PreservedDataWelcomeState();
}
class _PreservedDataWelcomeState extends State<PreservedDataWelcome>{
  bool restart=false,restoring=false,incompatible=false;String? error;
  AgentController? agent; int startedAt=0;
  @override void didChangeDependencies(){super.didChangeDependencies();if(agent!=null)return;agent=AgentScope.read(context);agent!.restoreResult.addListener(resultChanged);}
  @override void dispose(){agent?.restoreResult.removeListener(resultChanged);super.dispose();}
  void resultChanged(){final result=agent!.restoreResult.value;if(!restoring||result==null||((result['at'] as num?)??0)<startedAt)return;if(result['ok']==true){widget.onRestored?.call();}else{setState((){restoring=false;error='${result['error']??'恢复没有完成'}';});}}
  Future<void> restore()async{
    startedAt=DateTime.now().millisecondsSinceEpoch;setState(()=>restoring=true);
    try{await AgentScope.read(context).backend.call('uninstall.restorePreservedData',{'path':widget.candidate['path']});}
    catch(e){if(mounted)setState((){restoring=false;error=SessionRuntime.describeError(e);incompatible=e is CoreException&&e.code=='bad_config';});}
  }
  @override Widget build(BuildContext context){final date=DateTime.fromMillisecondsSinceEpoch((widget.candidate['savedAt'] as num?)?.toInt()??0),bytes=(widget.candidate['bytes'] as num?)??0;return Center(child:ConstrainedBox(constraints:const BoxConstraints(maxWidth:540),child:Padding(padding:const EdgeInsets.all(24),child:Column(mainAxisSize:MainAxisSize.min,crossAxisAlignment:CrossAxisAlignment.stretch,children:[
    const Center(child:ButterflyMark(size:44)),const SizedBox(height:20),Text(restoring?'正在找回':restart?'重新开始':'欢迎回来',textAlign:TextAlign.center,style:context.serif(context.text.headlineMedium)),const SizedBox(height:12),
    if(restoring)...[const Text('搬回对话、记忆和设置，完成后后台会重启一次',textAlign:TextAlign.center),const SizedBox(height:20),const LinearProgressIndicator()]
    else if(restart)...[const Text('保留的数据还放在原处，不会删除：',textAlign:TextAlign.center),SelectableText('${widget.candidate['path']}',textAlign:TextAlign.center),const SizedBox(height:16),Center(child:FilledButton(onPressed:widget.onContinue,child:const Text('继续')))]
    else ...[const Text('在原来的位置找到了上次保留的数据',textAlign:TextAlign.center),const SizedBox(height:16),SettingRow('保存时间',child:Text('${date.year}年${date.month}月${date.day}日 ${date.hour.toString().padLeft(2,'0')}:${date.minute.toString().padLeft(2,'0')}')),SettingRow('大小',child:Text('${(bytes/1024/1024).toStringAsFixed(1)} MB')),
      // Candidate metadata contains no content counts. Do not invent them.
      if(incompatible)SelectableText('${widget.candidate['path']}'),
      Wrap(alignment:WrapAlignment.center,spacing:12,children:[FilledButton(onPressed:incompatible?null:restore,child:const Text('找回来')),OutlinedButton(onPressed:()=>setState(()=>restart=true),child:const Text('重新开始'))]),
    ],if(error!=null)Text(error!,style:TextStyle(color:context.colors.seal)),
  ]))));}
}

Future<List<Json>> preservedCandidates(AgentController agent)async=>memoryRows(memoryMap(await agent.backend.call('uninstall.preservedData'))['candidates']);
