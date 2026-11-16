import 'dart:async';
import 'package:flutter/material.dart';
import 'garden_page.dart';
import 'agent_scope.dart';
import 'overlay_panel.dart';
import '../state/agent_controller.dart';
import '../state/memory_ui.dart';
import '../theme.dart';
import 'package:pi_rpc/pi_rpc.dart';

class LibraryOverlay extends StatelessWidget {
  const LibraryOverlay({super.key, required this.onClose});
  final VoidCallback onClose;
  @override
  Widget build(BuildContext context) => ShellOverlay(label:'百工',width:1000,height:760,padding:24,color:context.colors.background,onClose:onClose,child:LibraryPage(onClose:onClose));
}

/// Skills, reusable commands and connected services share one garden.
class LibraryPage extends StatelessWidget {
  const LibraryPage({super.key,this.onClose});
  final VoidCallback? onClose;
  @override
  Widget build(BuildContext context) => GardenPage(additionalSkills:const ButterflySkills(),onClose:onClose);
}

class ButterflySkills extends StatefulWidget {
  const ButterflySkills({super.key});
  @override State<ButterflySkills> createState()=>_ButterflySkillsState();
}
class _ButterflySkillsState extends State<ButterflySkills>{
  AgentController? agent;List<Json> rows=[];String? error,busy;
  StreamSubscription<Json>? events;int request=0;
  @override void didChangeDependencies(){super.didChangeDependencies();if(agent!=null)return;agent=AgentScope.read(context);events=agent!.backend.events.listen((e){if(e['event']=='skills.changed')unawaited(load());});load();}
  @override void dispose(){events?.cancel();super.dispose();}
  Future<void> load()async{final ticket=++request;try{final result=memoryRows(await agent!.backend.call('selfwork.skills.list'));if(mounted&&ticket==request)setState((){rows=result;error=null;});}catch(e){if(mounted&&ticket==request)setState(()=>error=SessionRuntime.describeError(e));}}
  Future<void> adopt(Json row)async{setState(()=>busy='${row['id']}');try{await agent!.backend.call('selfwork.skills.adopt',{'id':row['id'],'cwd':agent!.workspace});await load();}catch(e){if(mounted)setState(()=>error=SessionRuntime.describeError(e));}finally{if(mounted)setState(()=>busy=null);}}
  @override Widget build(BuildContext context){
    final c=context.colors,small=context.text.bodySmall;
    return Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[
      for(final row in rows) Padding(
        padding:const EdgeInsets.symmetric(horizontal:10,vertical:8),
        child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
          Row(children:[
            Expanded(child:Text('${row['name']}',maxLines:1,overflow:TextOverflow.ellipsis,style:context.text.bodyMedium?.copyWith(fontSize:13.5,height:1.6))),
            const SizedBox(width:10),
            Container(
              padding:const EdgeInsets.symmetric(horizontal:8,vertical:1),
              decoration:BoxDecoration(color:c.accentSoft,borderRadius:BorderRadius.circular(999)),
              child:Text('蝶君写的',style:small?.copyWith(fontSize:11,height:1.6,color:c.accent)),
            ),
          ]),
          Row(children:[
            Expanded(child:Text(
              '${memoryRows(row['versions']).where((v)=>v['version']==row['active_version']).firstOrNull?['description']??''}',
              maxLines:1,overflow:TextOverflow.ellipsis,style:small?.copyWith(fontSize:12,height:1.6,color:c.muted),
            )),
            const SizedBox(width:8),
            if(row['adopted_version']!=null) Text('工作台也在用',style:small?.copyWith(fontSize:11,color:c.muted))
            else TextButton(
              onPressed:busy==row['id']?null:()=>adopt(row),
              style:TextButton.styleFrom(foregroundColor:c.accent,minimumSize:Size.zero,padding:EdgeInsets.zero,tapTargetSize:MaterialTapTargetSize.shrinkWrap,textStyle:small?.copyWith(fontSize:12,height:1.6)),
              child:const Text('也给工作台用'),
            ),
          ]),
        ]),
      ),
      if(error!=null)Text(error!,style:TextStyle(color:c.danger)),
    ]);
  }
}
