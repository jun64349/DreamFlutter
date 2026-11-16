import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';
import '../craft_style.dart';
import '../state/agent_controller.dart';
import '../state/attention.dart';
import '../theme.dart';
import 'craft_surface.dart';
import 'agent_scope.dart';
import 'motion.dart';
import 'shell_widgets.dart';
import 'proto_icon.dart';
import '../state/goal_conversation.dart';

String attentionWords(Object? value) => '$value'.replaceAll('Agent', '它').replaceAll('会话', '对话').replaceAll('MCP', '服务').replaceAll('tokens', '内容长度').replaceAll('快照', '记忆记录');

String attentionActionLabel(Json item,String action){
  if (item['title'] == '确认蝶君起草的主动规则' || asJsonMap(item['data'])['kind'] == 'rule_draft') return action == 'allow' ? '先观察' : '不要';
  if (action == 'open') return '打开看看';
  if (item['kind'] == 'goal_acceptance') return action == 'accept' ? '收下' : '还要改';
  if (item['kind'] == 'goal_proposal') return action == 'accept' ? '设为目标' : action == 'edit' ? '改一改' : '不用';
  if (action == 'approve') return '允许';
  if(action=='continue')return '继续';if(action=='end')return '结束';if(action=='answer')return '回答';if(action=='reject'&&item['kind']=='question')return '取消';
  final data=asJsonMap(item['data']);
  if(item['kind']=='proposal')return action=='allow'?(data['proposalKind']=='mcp'?'连接':'采用'):'不要';
  if(item['kind']=='memory')return data['why']=='promote_global'?(action=='allow'?'用到所有项目':'只留在这个项目'):(action=='allow'?'记住':'不记');
  return action=='allow'?'允许':'拒绝';
}

Future<void> openAttentionTarget(AgentController agent, Json target, [Json origin = const {}]) async {
  if (target['page'] == 'schedule') { scheduleNavigationRequest.value = target['itemId'] as String?; agent.showSection(AppSection.schedules); return; }
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
    final colors = context.colors;
    return ListenableBuilder(
      listenable: state,
      builder: (context, _) {
        final hidden = state.hidden;
        final prioritized = state.prioritized
            .where((item) => !hidden.contains(item['id']))
            .toList();
        final priorityIds = state.prioritized.map((item) => item['id']).toSet();
        final groups = [('现在需要你', state.now, 0.0), ('有空看看', state.later, 22.0)]
            .map(
              (group) => (
                group.$1,
                group.$2
                    .where(
                      (item) =>
                          !hidden.contains(item['id']) &&
                          !priorityIds.contains(item['id']),
                    )
                    .toList(),
                group.$3,
              ),
            )
            .where((group) => group.$2.isNotEmpty)
            .toList();
        final showEmpty =
            state.available &&
            state.error == null &&
            prioritized.isEmpty &&
            groups.isEmpty;
        final header = Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '案头',
                style: context
                    .handwriting(context.text.headlineSmall)
                    .copyWith(
                      fontSize: 32,
                      height: 1.15,
                      letterSpacing: 32 * .06,
                    ),
              ),
              Text(
                '等你处理',
                style: context.text.bodySmall?.copyWith(
                  fontSize: 12,
                  height: 1.6,
                  color: colors.muted,
                ),
              ),
            ],
          ),
        );
        return Scaffold(
          backgroundColor: colors.background,
          body: Column(
            children: [
              if (state.loading && !state.available)
                const LinearProgressIndicator(),
              Expanded(
                child: Stack(
                  children: [
                    // 虚化高光（原型 .wash）：页头后一层很淡的主题色径向渐变，只作氛围，不挡内容
                    Positioned(
                      top: 0,
                      left: 0,
                      right: 0,
                      height: 280,
                      child: IgnorePointer(
                        child: DecoratedBox(
                          decoration: BoxDecoration(
                            gradient: RadialGradient(
                              center: const Alignment(0, -1.1),
                              radius: 1.2,
                              stops: const [0, .7],
                              colors: [
                                colors.accentSoft.withValues(
                                  alpha: colors.accentSoft.a * .7,
                                ),
                                colors.accentSoft.withValues(alpha: 0),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                    if (showEmpty)
                      CustomScrollView(
                        slivers: [
                          SliverToBoxAdapter(
                            child: Center(
                              child: ConstrainedBox(
                                constraints: const BoxConstraints(
                                  maxWidth: 820,
                                ),
                                child: Padding(
                                  padding: const EdgeInsets.fromLTRB(
                                    28,
                                    10,
                                    28,
                                    0,
                                  ),
                                  child: SizedBox(
                                    width: double.infinity,
                                    child: header,
                                  ),
                                ),
                              ),
                            ),
                          ),
                          const SliverFillRemaining(
                            hasScrollBody: false,
                            child: _AttentionEmptyStatus(),
                          ),
                        ],
                      )
                    else
                      ShellColumn(
                        maxWidth: 820,
                        padding: const EdgeInsets.only(top: 10, bottom: 40),
                        horizontalPadding: 28,
                        children: [
                          header,
                          if (state.error != null)
                            Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    attentionWords(state.error),
                                    style: TextStyle(color: colors.danger),
                                  ),
                                ),
                                ShellButton(
                                  '重试',
                                  onPressed: state.refresh,
                                  small: true,
                                ),
                              ],
                            ),
                          for (final category in [
                            ('decision', '待你决定', colors.accent, 'flag'),
                            ('blocked', '卡住了', colors.seal, 'x'),
                            ('review', '等你验收', colors.success, 'check'),
                          ])
                            if (prioritized.any(
                              (i) => i['category'] == category.$1,
                            )) ...[
                              // 分组小标题照原型 .ihead：13px muted、带图标，上下 18 / 8
                              Padding(
                                padding: EdgeInsets.only(
                                  top:
                                      category.$1 ==
                                          prioritized.first['category']
                                      ? 18
                                      : 8,
                                  bottom: 8,
                                ),
                                child: Row(
                                  children: [
                                    ProtoIcon(
                                      category.$4,
                                      size: 16,
                                      color: category.$3,
                                    ),
                                    const SizedBox(width: 8),
                                    Text(
                                      '${category.$2} · ${prioritized.where((i) => i['category'] == category.$1).length}',
                                      style: context.text.bodySmall?.copyWith(
                                        fontSize: 13,
                                        height: 1.6,
                                        color: colors.muted,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                              for (final priority in prioritized.where(
                                (i) => i['category'] == category.$1,
                              ))
                                _AttentionRow(
                                  band: category.$3,
                                  key: ValueKey(priority['id']),
                                  item:
                                      [...state.now, ...state.later]
                                          .where(
                                            (i) => i['id'] == priority['id'],
                                          )
                                          .firstOrNull ??
                                      {
                                        'id': priority['id'],
                                        'title': priority['object'],
                                        'reason': priority['situation'],
                                        'actions': priority['actions'],
                                        'target': priority['target'],
                                      },
                                  state: state,
                                  agent: agent,
                                ),
                            ],
                          for (final group in groups) ...[
                            ShellSectionLabel(group.$1, top: group.$3),
                            AnimatedSize(
                              duration: AppTokens.motion(
                                context,
                                AppTokens.medium,
                              ),
                              alignment: Alignment.topCenter,
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.stretch,
                                children: [
                                  for (final item in group.$2)
                                    _AttentionRow(
                                      key: ValueKey(item['id']),
                                      item: item,
                                      state: state,
                                      agent: agent,
                                    ),
                                ],
                              ),
                            ),
                          ],
                        ],
                      ),
                  ],
                ),
              ),
              if (state.undoable.isNotEmpty)
                ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 160),
                  child: SingleChildScrollView(
                    child: Column(
                      children: [
                        for (final r in state.undoable)
                          Material(
                            color: colors.accentSoft,
                            child: Padding(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 24,
                                vertical: 6,
                              ),
                              child: Row(
                                children: [
                                  const Expanded(child: Text('已处理')),
                                  Text(
                                    '${(state.remaining(r) / 1000).ceil()} 秒',
                                    style: context.text.bodySmall,
                                  ),
                                  TextButton(
                                    onPressed: () => state.undo(r),
                                    child: const Text('撤销'),
                                  ),
                                ],
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}

class _AttentionEmptyStatus extends StatelessWidget {
  const _AttentionEmptyStatus();

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(28, 0, 28, 40),
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 52,
              height: 52,
              alignment: Alignment.center,
              decoration: ShapeDecoration(
                color: colors.accent.withValues(alpha: .08),
                shape: craftButtonShape(
                  context.painting.craftGeometry,
                  radius: 14,
                ),
              ),
              child: ProtoIcon('inbox', size: 25, color: colors.accent),
            ),
            const SizedBox(height: 12),
            Semantics(
              liveRegion: true,
              child: Text(
                '没有待处理的事项',
                textAlign: TextAlign.center,
                style: context
                    .serif(context.text.bodyMedium)
                    .copyWith(fontSize: 15, color: colors.ink2),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _AttentionRow extends StatefulWidget {
  const _AttentionRow({super.key,required this.item,required this.state,required this.agent,this.band});
  final Color? band;
  final Json item;
  final AttentionState state;
  final AgentController agent;
  @override
  State<_AttentionRow> createState()=>_AttentionRowState();
}
class _AttentionRowState extends State<_AttentionRow> {
  final _answer=TextEditingController();
  // 「改一改」 on a rule draft edits its name and task in place (autonomy.drafts.update), then the card comes back.
  TextEditingController? _ruleName,_ruleTask;
  bool _ruleBusy=false;String? _ruleError;
  void _editRule(Json draft){setState((){_ruleName=TextEditingController(text:'${draft['name']??''}');_ruleTask=TextEditingController(text:'${draft['task']??''}');_ruleError=null;});}
  void _closeRule(){final a=_ruleName,b=_ruleTask;setState((){_ruleName=null;_ruleTask=null;_ruleError=null;});Future<void>.delayed(const Duration(milliseconds:300),(){a?.dispose();b?.dispose();});}
  Future<void> _saveRule(Json data)async{
    final name=_ruleName!.text.trim(),task=_ruleTask!.text.trim();
    if(name.isEmpty||task.isEmpty){setState(()=>_ruleError='名称和要做的事都要写');return;}
    setState((){_ruleBusy=true;_ruleError=null;});
    try{
      await widget.agent.backend.call('autonomy.drafts.update',{'id':widget.item['id'],'version':data['version'],'draft':{...asJsonMap(data['draft']),'name':name,'task':task}});
      await widget.state.refresh();
      if(mounted)_closeRule();
    }catch(e){if(mounted)setState(()=>_ruleError=attentionWords(SessionRuntime.describeError(e)));}
    finally{if(mounted)setState(()=>_ruleBusy=false);}
  }
  Future<void> act(String action) async {
    final item = widget.item;
    if (action == 'open') { await openAttentionTarget(widget.agent,asJsonMap(item['target']),asJsonMap(item['origin'])); return; }
    if (item['kind'] == 'goal_acceptance' && action == 'reject' || item['kind'] == 'goal_proposal' && action == 'edit') {
      final editing = action == 'edit', draft = asJsonMap(asJsonMap(item['data'])['draft']);
      final field = TextEditingController(text: editing ? '${asJsonMap(draft['spec'])['objective'] ?? ''}' : '');
      final text = await showDialog<String>(context: context, builder: (context) => AlertDialog(title: Text(editing ? '改一改' : '还要改'), content: TextField(controller:field,minLines:2,maxLines:5),actions:[TextButton(onPressed:()=>Navigator.pop(context),child:const Text('取消')),FilledButton(onPressed:(){if(field.text.trim().isNotEmpty)Navigator.pop(context,field.text.trim());},child:const Text('保存'))]));
      await Future<void>.delayed(const Duration(milliseconds:300)); field.dispose();
      if(text != null) await widget.state.resolve(item,action,null,editing ? {'draft':{'spec':{...asJsonMap(draft['spec']),'objective':text}}} : {'reason':text});
      return;
    }
    await widget.state.resolve(item,action,action=='answer'?_answer.text:null);
  }
  @override
  void dispose(){_answer.dispose();_ruleName?.dispose();_ruleTask?.dispose();super.dispose();}
  @override
  Widget build(BuildContext context){
    final i=widget.item, data=asJsonMap(i['data']), origin=asJsonMap(i['origin']);
    final options=(data['options'] as List? ?? []).whereType<String>().toList();
    final actions=(i['actions'] as List? ?? []).cast<String>().where((action)=>!((i['kind']=='approval'||i['kind']=='trust')&&action=='answer')&&!(i['kind']=='question'&&options.isNotEmpty&&action=='reject')).toList();
    final busy=widget.state.busy.contains(i['id']);
    final rule=i['title']=='确认蝶君起草的主动规则'||data['kind']=='rule_draft';
    final draft=data['kind']=='rule_draft'?asJsonMap(data['draft']):const <String,dynamic>{};
    final editing=rule&&_ruleName!=null;
    final who=[origin['role']=='butterfly'||rule?'蝶君':'工作台',if(rule)'起草了一条规则' else if(origin['sessionName']!=null) '${origin['sessionName']}'].join(' · ');
    String clean(String o)=>o.replaceAll(RegExp(r'\s*(\(Recommended\)|（推荐）|\(推荐\))',caseSensitive:false),'');
    final recommended=options.where((o)=>clean(o)!=o).firstOrNull;
    final muted=context.text.bodySmall?.copyWith(fontSize:12,height:1.6,color:context.colors.muted);
    var first=recommended==null;
    ShellButtonKind kind(){final k=first?ShellButtonKind.primary:ShellButtonKind.normal;first=false;return k;}
    final body=Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
      // from：谁来的，12px muted；what：哪件事，600 加粗（原型 .icard .from / .what）
      Text(attentionWords(who),style:muted),
      // A question's own words live in data.title (the list title is its first line only).
      Padding(padding:const EdgeInsets.symmetric(vertical:2),child:Text(rule?'要不要让蝶君以后自动做这件事？':attentionWords(i['kind']=='question'&&data['title'] is String&&'${data['title']}'.trim().isNotEmpty?'${data['title']}'.trim().split('\n\n').last:i['title'] ?? ''),style:context.text.bodyMedium?.copyWith(fontSize:14,fontWeight:FontWeight.w600,color:context.colors.ink,height:1.6))),
      if(editing) FadeIn(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
        for(final (label,field,lines) in [('名称',_ruleName!,1),('要做的事',_ruleTask!,3)]) Padding(padding:const EdgeInsets.symmetric(vertical:3),child:Row(crossAxisAlignment:CrossAxisAlignment.start,children:[
          SizedBox(width:64,child:Padding(padding:const EdgeInsets.only(top:7),child:Text(label,style:muted))),
          Expanded(child:TextField(controller:field,minLines:lines,maxLines:lines==1?1:6,style:context.text.bodyMedium?.copyWith(fontSize:13.5),decoration:InputDecoration(isDense:true,filled:true,fillColor:context.colors.background,contentPadding:const EdgeInsets.symmetric(horizontal:8,vertical:8),border:OutlineInputBorder(borderRadius:BorderRadius.circular(7),borderSide:BorderSide(color:context.colors.border)),enabledBorder:OutlineInputBorder(borderRadius:BorderRadius.circular(7),borderSide:BorderSide(color:context.colors.border))))),
        ])),
        if(_ruleError!=null)Padding(padding:const EdgeInsets.only(top:4),child:Text(_ruleError!,style:context.text.bodySmall?.copyWith(color:context.colors.danger))),
      ])) else if('${draft['task'] ?? i['reason'] ?? ''}'.isNotEmpty) rule
        // why：规则草稿用衬线写在 sunk 底的小块里（原型 v1-pages.js 的 .why 内联样式）
        ? Container(width:double.infinity,padding:const EdgeInsets.symmetric(horizontal:10,vertical:8),decoration:BoxDecoration(color:context.colors.sunk,borderRadius:BorderRadius.circular(8)),child:Text(attentionWords(draft['task'] ?? i['reason']),style:context.serif(context.text.bodyMedium).copyWith(fontSize:13,color:context.colors.ink2,height:1.6)))
        : Text(attentionWords(i['reason']),style:context.text.bodySmall?.copyWith(fontSize:13,height:1.6,color:context.colors.ink2)),
      if(actions.contains('answer') && options.isEmpty) Padding(padding:const EdgeInsets.only(top:10),child:TextField(controller:_answer,minLines:1,maxLines:data['method']=='editor'?5:2,decoration:const InputDecoration(hintText:'你的回答'),onSubmitted:busy?null:(value)=>widget.state.resolve(i,'answer',value))),
      const SizedBox(height:8),if(editing)Wrap(spacing:8,children:[
        _AttentionButton('保存',kind:ShellButtonKind.primary,onPressed:_ruleBusy?null:()=>_saveRule(data)),
        _AttentionButton('取消',onPressed:_ruleBusy?null:_closeRule),
      ]) else Wrap(spacing:8,runSpacing:8,crossAxisAlignment:WrapCrossAlignment.center,children:[
        for(final action in actions) ...[
          if (rule && action == 'reject') _AttentionButton('改一改',onPressed:busy||draft.isEmpty?null:()=>_editRule(draft)),
          if(action=='answer' && options.isNotEmpty) ...[for(final o in options)_AttentionButton(attentionWords(clean(o)),kind:o==recommended?ShellButtonKind.primary:kind(),onPressed:busy?null:()=>widget.state.resolve(i,'answer',o))]
          else _AttentionButton(attentionActionLabel(i,action),kind:kind(),onPressed:busy?null:()=>act(action)),
        ],
        if (!rule && !actions.contains('open')) _AttentionButton(i['kind']=='question'?'去对话里说':'去看看',line:i['kind']=='question',kind:ShellButtonKind.ghost,onPressed:()=>openAttentionTarget(widget.agent,asJsonMap(i['target']),origin)),
        if(busy)const SizedBox(width:16,height:16,child:CircularProgressIndicator(strokeWidth:2)),
      ]),
    ]);
    final band=widget.band;
    // 卡片照原型 .icard：card 底、圆角 14、细分隔线描边、下间距 10。
    // A rounded card cannot take a one-coloured left border in Flutter: the band is a strip inside the clipped card.
    final decoration=craftSurfaceDecoration(context,radius:14,borderColor:context.colors.hairline);
    if(band==null)return Container(margin:const EdgeInsets.only(bottom:10),padding:const EdgeInsets.fromLTRB(16,12,16,12),decoration:decoration,child:body);
    // 分组卡左边再压一条 3px 类型色条（decide=主题色、block=朱砂、accept=青绿）
    return Container(margin:const EdgeInsets.only(bottom:10),clipBehavior:Clip.antiAlias,decoration:decoration,child:IntrinsicHeight(child:Row(crossAxisAlignment:CrossAxisAlignment.stretch,children:[Container(width:3,color:band),Expanded(child:Padding(padding:const EdgeInsets.fromLTRB(13,12,16,12),child:body))])));
  }
}

// 原型 .btn：次按钮 sunk、无描边；只有 .btn.line 导航按钮带细边。
class _AttentionButton extends StatelessWidget {
  const _AttentionButton(this.label,{required this.onPressed,this.kind=ShellButtonKind.normal,this.line=false});
  final String label;
  final VoidCallback? onPressed;
  final ShellButtonKind kind;
  final bool line;
  @override Widget build(BuildContext context) => TextButton(
    onPressed:onPressed,
    style:shellButtonStyle(context,kind,small:true).copyWith(
      backgroundColor:WidgetStatePropertyAll(kind==ShellButtonKind.primary?context.colors.accent:kind==ShellButtonKind.normal?context.colors.sunk:Colors.transparent),
      foregroundColor:WidgetStatePropertyAll(kind==ShellButtonKind.primary?context.colors.onAccent:context.colors.ink),
      padding:const WidgetStatePropertyAll(EdgeInsets.symmetric(horizontal:13,vertical:5)),
      minimumSize:const WidgetStatePropertyAll(Size.zero),
      textStyle:const WidgetStatePropertyAll(TextStyle(fontSize:13,height:1.6)),
      shape:WidgetStatePropertyAll(craftButtonShape(context.painting.craftGeometry,radius:9).copyWith(side:line?BorderSide(color:context.colors.border):BorderSide.none))),
    child:Text(label));
}
