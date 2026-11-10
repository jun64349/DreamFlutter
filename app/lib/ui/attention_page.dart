import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';
import '../state/agent_controller.dart';
import '../state/attention.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'shell_widgets.dart';

String attentionWords(Object? value) => '$value'.replaceAll('Agent', '它').replaceAll('会话', '对话').replaceAll('MCP', '服务').replaceAll('tokens', '内容长度').replaceAll('快照', '记忆记录');

String attentionActionLabel(Json item,String action){
  if(action=='continue')return '继续';if(action=='end')return '结束';if(action=='answer')return '回答';if(action=='reject'&&item['kind']=='question')return '取消';
  final data=asJsonMap(item['data']);
  if(item['kind']=='proposal')return action=='allow'?(data['proposalKind']=='mcp'?'连接':'采用'):'不要';
  if(item['kind']=='memory')return data['why']=='promote_global'?(action=='allow'?'用到所有项目':'只留在这个项目'):(action=='allow'?'记住':'不记');
  return action=='allow'?'允许':'拒绝';
}

Future<void> openAttentionTarget(AgentController agent, Json target, [Json origin = const {}]) async {
  final path = target['sessionFile'] as String? ?? origin['sessionFile'] as String?;
  final slot = target['slotId'] as String? ?? origin['slotId'] as String?;
  final butterfly = origin['role'] == 'butterfly' || target['page'] == 'butterfly';
  if (butterfly) {
    final worker = await agent.ensureButterfly();
    if (worker == null) return;
    await agent.openButterfly();
    if (slot != null && worker.runtimes.any((r) => r.slotId == slot)) { await worker.activateSlot(slot); }
    else if (path != null) { await worker.openSession(path); }
  } else if (path != null) {
    agent.showSection(AppSection.chat); await agent.openSession(path);
  } else if (slot != null && agent.runtimes.any((r) => r.slotId == slot)) {
    await agent.activateSlot(slot); agent.showSection(AppSection.chat);
  } else if (target['page'] == 'memory') {
    agent.openMemory(itemId: target['itemId'] as String?);
  } else if (target['page'] == 'library') { agent.showSection(AppSection.library); }
  else { agent.showSection(AppSection.tasks); }
}

class AttentionPage extends StatelessWidget {
  const AttentionPage({super.key});
  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context), state = agent.attention;
    return ListenableBuilder(listenable: state, builder: (context, _) => Scaffold(
      body: Column(children: [
        const Padding(padding: EdgeInsets.fromLTRB(28,24,20,14), child: Align(alignment:Alignment.centerLeft,child:PoeticPageTitle('等你处理'))),
        if (state.loading && !state.available) const LinearProgressIndicator(),
        if (state.error != null) Padding(padding:const EdgeInsets.symmetric(horizontal:28),child:Row(children:[Expanded(child:Text(attentionWords(state.error),style:TextStyle(color:context.colors.danger))),TextButton(onPressed:state.refresh,child:const Text('重试'))])),
        Expanded(child: ListView(padding:const EdgeInsets.fromLTRB(28,0,28,24),children:[
          for (final group in [('现在需要你',state.now),('有空看看',state.later)]) ...[
            Padding(padding:const EdgeInsets.only(top:22,bottom:10),child:Text(group.$1,style:context.text.titleMedium)),
            AnimatedSize(duration:AppTokens.motion(context,AppTokens.medium),alignment:Alignment.topCenter,child:Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[for(final item in group.$2.where((i)=>!state.hidden.contains(i['id']))) _AttentionRow(key:ValueKey(item['id']),item:item,state:state,agent:agent)])),
            if (group.$2.where((i)=>!state.hidden.contains(i['id'])).isEmpty) Padding(padding:const EdgeInsets.symmetric(vertical:20),child:Text(group.$1=='现在需要你'?'没有急着处理的事':'都处理完了',style:TextStyle(color:context.colors.muted))),
          ],
        ])),
        if(state.undoable.isNotEmpty)ConstrainedBox(constraints:const BoxConstraints(maxHeight:160),child:SingleChildScrollView(child:Column(children:[for(final r in state.undoable) Material(color:context.colors.accentSoft,child:Padding(padding:const EdgeInsets.symmetric(horizontal:24,vertical:6),child:Row(children:[const Expanded(child:Text('已处理')),Text('${(state.remaining(r)/1000).ceil()} 秒',style:context.text.bodySmall),TextButton(onPressed:()=>state.undo(r),child:const Text('撤销'))])))]))),
      ]),
    ));
  }
}

class _AttentionRow extends StatefulWidget {
  const _AttentionRow({super.key,required this.item,required this.state,required this.agent});
  final Json item;
  final AttentionState state;
  final AgentController agent;
  @override
  State<_AttentionRow> createState()=>_AttentionRowState();
}
class _AttentionRowState extends State<_AttentionRow> {
  final _answer=TextEditingController();
  @override
  void dispose(){_answer.dispose();super.dispose();}
  @override
  Widget build(BuildContext context){
    final i=widget.item, data=asJsonMap(i['data']), origin=asJsonMap(i['origin']);
    final options=(data['options'] as List? ?? []).whereType<String>().toList();
    final actions=(i['actions'] as List? ?? []).cast<String>().where((action)=>!((i['kind']=='approval'||i['kind']=='trust')&&action=='answer')&&!(i['kind']=='question'&&options.isNotEmpty&&action=='reject')).toList();
    final busy=widget.state.busy.contains(i['id']);
    final who=[origin['role']=='butterfly'?'蝶君':'工作台',if(origin['sessionName']!=null) '${origin['sessionName']}'].join(' · ');
    return Container(padding:const EdgeInsets.symmetric(vertical:16),decoration:BoxDecoration(border:Border(bottom:BorderSide(color:context.colors.border,width:.5))),child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
      Text(attentionWords(who),style:context.text.bodySmall?.copyWith(color:context.colors.muted)),const SizedBox(height:6),
      Text(attentionWords(i['title'] ?? ''),style:context.text.titleSmall),
      if('${i['reason'] ?? ''}'.isNotEmpty) Padding(padding:const EdgeInsets.only(top:5),child:Text(attentionWords(i['reason']),style:context.text.bodyMedium?.copyWith(color:context.colors.ink2))),
      if(actions.contains('answer') && options.isEmpty) Padding(padding:const EdgeInsets.only(top:12),child:TextField(controller:_answer,minLines:1,maxLines:data['method']=='editor'?5:2,decoration:const InputDecoration(hintText:'你的回答'),onSubmitted:busy?null:(value)=>widget.state.resolve(i,'answer',value))),
      const SizedBox(height:12),Wrap(spacing:8,runSpacing:8,crossAxisAlignment:WrapCrossAlignment.center,children:[
        for(final action in actions)
          if(action=='answer' && options.isNotEmpty) ...[for(final o in options)FilledButton(onPressed:busy?null:()=>widget.state.resolve(i,'answer',o),child:Text(attentionWords(o)))]
          else if(action=='allow'||action=='continue'||action=='answer') FilledButton(onPressed:busy?null:()=>widget.state.resolve(i,action,action=='answer'?_answer.text:null),child:Text(attentionActionLabel(i,action)))
          else TextButton(onPressed:busy?null:()=>widget.state.resolve(i,action),child:Text(attentionActionLabel(i,action))),
        TextButton(onPressed:()=>openAttentionTarget(widget.agent,asJsonMap(i['target']),origin),child:const Text('去看看')),
        if(busy)const SizedBox(width:16,height:16,child:CircularProgressIndicator(strokeWidth:2)),
      ]),
    ]));
  }
}
