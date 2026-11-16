import 'package:flutter/material.dart';
import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'settings_controls.dart';

class VoiceSettings extends StatefulWidget {
  const VoiceSettings({super.key});
  @override State<VoiceSettings> createState()=>_VoiceSettingsState();
}
class _VoiceSettingsState extends State<VoiceSettings>{
  AgentController? agent; bool configured=false,busy=false;String? error;
  @override void didChangeDependencies(){super.didChangeDependencies();if(agent!=null)return;agent=AgentScope.read(context);load();}
  Future<void> load()async{try{final value=asJsonMap(await agent!.backend.call('voice.keyStatus'));if(mounted)setState(()=>configured=value['configured']==true);}catch(e){if(mounted)setState(()=>error=SessionRuntime.describeError(e));}}
  Future<void> keyDialog()async{
    final field=TextEditingController();String? failure;
    await showDialog<void>(context:context,builder:(context)=>StatefulBuilder(builder:(context,set)=>AlertDialog(title:const Text('Key'),content:Column(mainAxisSize:MainAxisSize.min,children:[TextField(controller:field,obscureText:true,enableSuggestions:false,autocorrect:false,decoration:const InputDecoration(hintText:'填写')),if(failure!=null)Text(failure!)]),actions:[TextButton(onPressed:()=>Navigator.pop(context),child:const Text('取消')),FilledButton(onPressed:()async{try{await agent!.backend.call('voice.setKey',{'key':field.text.trim().isEmpty?null:field.text.trim()});field.clear();await load();if(context.mounted)Navigator.pop(context);}catch(e){if(context.mounted)set(()=>failure=SessionRuntime.describeError(e));}},child:const Text('保存'))])));
    await Future<void>.delayed(const Duration(milliseconds:300));field.dispose();
  }
  Future<void> mode(String mode)async{setState(()=>busy=true);try{await agent!.updateCoreSettings({'voiceMode':mode});if(mounted)setState(()=>error=null);}catch(e){if(mounted)setState(()=>error=SessionRuntime.describeError(e));}finally{if(mounted)setState(()=>busy=false);}}
  @override Widget build(BuildContext context){final s=AgentScope.of(context).coreSettings,cloud=s['voiceMode']=='cloud';return Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[
    SettingRow('识别方式',desc:cloud?'用阿里云百炼，需要填 Key':'声音不出这台电脑，不花钱',
      child:V1Seg<String>(value:cloud?'cloud':'local',options:const [('local','本机'),('cloud','云端')],onChanged:busy?null:mode)),
    if(cloud)...[
      Divider(height:1,thickness:1,color:context.colors.ink.withValues(alpha:.07)),
      SettingChoice<String>('服务',indented:true,value:s['voiceCloudProvider'] as String? ?? 'bailian',
        choices:const {'bailian':'阿里云百炼'},save:(v)=>agent!.updateCoreSettings({'voiceCloudProvider':v})),
      Divider(height:1,thickness:1,color:context.colors.ink.withValues(alpha:.07)),
      SettingRow('Key',indented:true,child:TextButton(onPressed:keyDialog,
        style:TextButton.styleFrom(minimumSize:const Size(200,0),padding:const EdgeInsets.symmetric(horizontal:12,vertical:6),
          backgroundColor:context.colors.sunk,foregroundColor:context.colors.ink2,shape:RoundedRectangleBorder(borderRadius:BorderRadius.circular(9))),
        child:Text(configured?'已填写':'填写',style:const TextStyle(fontSize:13)))),
    ],
    if(error!=null)Text(error!,style:TextStyle(color:context.colors.seal)),
  ]);}
}
