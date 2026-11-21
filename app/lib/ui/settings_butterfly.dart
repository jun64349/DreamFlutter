import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';
import '../state/agent_controller.dart';
import '../state/memory_ui.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'settings_controls.dart';
import 'number_setting.dart';
import 'settings_layout.dart';
import 'common.dart';
import 'shell_widgets.dart' show ShellColors;

const personaWords = {
  'quiet': ('静','安静可靠，话少','嗯，资料都整理好了。还差一项，明天你确认就行。'),
  'warm': ('暖','亲切，关心你','辛苦啦！两份资料都整理好了，还差一项明天等你看看，不急哦～'),
  'crisp': ('利落','只说结论和下一步','两份已完成，1 项待你明天确认。'),
  'lively': ('灵动','活泼，爱用比喻','两份资料已经乖乖排好队啦，只剩一位等你明天点名～'),
};
class PersonaChoices extends StatefulWidget {
  const PersonaChoices({super.key});
  @override State<PersonaChoices> createState()=>_PersonaChoicesState();
}
class _PersonaChoicesState extends State<PersonaChoices> {
  Set<String> ids={}; String? error; bool busy=false;
  AgentController? agent;
  @override void didChangeDependencies(){super.didChangeDependencies();if(agent!=null)return;agent=AgentScope.read(context);load();}
  Future<void> load()async{try{final values=await Future.wait([agent!.backend.call('persona.presets'),agent!.backend.call('settings.get')]); if(!mounted)return;agent!.coreSettings=memoryMap(values[1]);setState(()=>ids=memoryRows(values[0]).map((r)=>'${r['id']}').toSet());}catch(e){if(mounted)setState(()=>error=SessionRuntime.describeError(e));}}
  Future<void> choose(String id)async{setState(()=>busy=true);try{await agent!.updateCoreSettings({'butterflyPersona':id});if(mounted)setState(()=>error=null);}catch(e){if(mounted)setState(()=>error=SessionRuntime.describeError(e));}finally{if(mounted)setState(()=>busy=false);}}
  @override Widget build(BuildContext context){final selected=AgentScope.of(context).coreSettings['butterflyPersona'] as String? ?? 'quiet';return Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[
    Padding(
      padding:const EdgeInsets.symmetric(vertical:12),
      child:LayoutBuilder(builder:(context,box){
        final columns=box.maxWidth<520?2:4;
        const gap=10.0;
        final colors=context.colors;
        return Wrap(spacing:gap,runSpacing:gap,children:[
          for(final entry in personaWords.entries)SizedBox(width:(box.maxWidth-gap*(columns-1))/columns,
            child:OutlinedButton(
              style:OutlinedButton.styleFrom(
                padding:const EdgeInsets.symmetric(horizontal:12,vertical:10),
                backgroundColor:colors.background,
                side:BorderSide(color:selected==entry.key?colors.accent:colors.hairline,width:selected==entry.key?2:1),
                shape:RoundedRectangleBorder(borderRadius:BorderRadius.circular(12)),
                alignment:Alignment.centerLeft,
              ),
              onPressed:busy||!ids.contains(entry.key)?null:()=>choose(entry.key),
              child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
                Text(entry.value.$1,style:context.serif(context.text.titleMedium).copyWith(fontSize:17)),
                const SizedBox(height:2),
                Text(entry.value.$2,style:context.text.bodySmall?.copyWith(fontSize:12,color:colors.muted)),
              ]),
            )),
        ]);
      }),
    ),
    Padding(padding:const EdgeInsets.only(bottom:12),child:Container(
      padding:const EdgeInsets.all(12),
      decoration:BoxDecoration(color:context.colors.sunk,borderRadius:BorderRadius.circular(12)),
      child:Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[
        Align(alignment:Alignment.centerRight,child:Container(padding:const EdgeInsets.symmetric(horizontal:12,vertical:5),decoration:BoxDecoration(color:context.colors.accent,borderRadius:const BorderRadius.only(topLeft:Radius.circular(14),topRight:Radius.circular(14),bottomLeft:Radius.circular(14),bottomRight:Radius.circular(4))),child:Text('资料整理得怎么样了？',style:context.text.bodySmall?.copyWith(fontSize:13,color:context.colors.onAccent)))),
        const SizedBox(height:6),
        Align(alignment:Alignment.centerLeft,child:Container(padding:const EdgeInsets.symmetric(horizontal:12,vertical:5),decoration:BoxDecoration(color:context.colors.card,borderRadius:const BorderRadius.only(topLeft:Radius.circular(14),topRight:Radius.circular(14),bottomLeft:Radius.circular(4),bottomRight:Radius.circular(14))),child:Text((personaWords[selected]??personaWords['quiet']!).$3,style:context.serif(context.text.bodySmall).copyWith(fontSize:13,color:context.colors.ink2)))),
      ]),
    )),
    if(error!=null)Text(error!,style:TextStyle(color:context.colors.danger)),
  ]);}
}
class ButterflyProactivity extends StatefulWidget {
  const ButterflyProactivity({super.key});
  @override State<ButterflyProactivity> createState()=>_ButterflyProactivityState();
}
class _ButterflyProactivityState extends State<ButterflyProactivity>{
  bool busy=false;String? error;
  Future<void> change(String value)async{setState(()=>busy=true);try{await AgentScope.read(context).updateCoreSettings({'butterflyProactivity':value});if(mounted)setState(()=>error=null);}catch(e){if(mounted)setState(()=>error=SessionRuntime.describeError(e));}finally{if(mounted)setState(()=>busy=false);}}
  @override Widget build(BuildContext context){final a=AgentScope.of(context),s=a.coreSettings;final mode=s['butterflyProactivity'] as String? ?? 'low';return Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[
    SettingRow('主动性',desc:switch(mode){'mid'=>'再按你给的长期目标自己往前推。','high'=>'再加空闲时自己学、写技能，有发现会来找你聊，每天最多 5 次。',_=>'只做你交代的事和规则命中的事。'},child:V1Seg<String>(value:mode,options:const [('low','低'),('mid','中'),('high','高')],onChanged:busy?null:change)),
    PresetNumberSetting(label:'自己做事每天最多花',desc:'到了就停，第二天再接着做',value:'${s['butterflyDailyBudget']??.5}',defaultValue:.5,presets:const [0,.2,.5,1,2,5],unit:'美元',validator:(v){final n=num.tryParse(v);return n==null||!n.isFinite||n<0?'请输入有效数值':null;},save:(v)=>a.updateCoreSettings({'butterflyDailyBudget':num.parse(v)})),
    if(error!=null)Text(error!,style:TextStyle(color:context.colors.danger)),
  ]);}
}
class ButterflyLongGoals extends StatefulWidget {
  const ButterflyLongGoals({super.key,this.section=false});
  final bool section;
  @override State<ButterflyLongGoals> createState()=>_ButterflyLongGoalsState();
}
class _ButterflyLongGoalsState extends State<ButterflyLongGoals>{
  AgentController? agent;List<Json> goals=[],history=[];String? open,error;
  @override void didChangeDependencies(){super.didChangeDependencies();if(agent!=null)return;agent=AgentScope.read(context);load();}
  Future<void> load()async{try{final rows=memoryRows(await agent!.backend.call('selfwork.longGoals.list'));if(mounted)setState(()=>goals=rows);}catch(e){if(mounted)setState(()=>error=SessionRuntime.describeError(e));}}
  Future<void> expand(Json row)async{if(open==row['id']){setState(()=>open=null);return;}try{final result=memoryRows(await agent!.backend.call('selfwork.history'));if(mounted)setState((){open='${row['id']}';history=result;});}catch(e){if(mounted)setState(()=>error=SessionRuntime.describeError(e));}}
  Future<void> edit(Json row)async{final values=await showFieldsDialog(context,title:'长期目标',confirm:'保存',fields:[FieldSpec('标题',initial:'${row['title']}'),FieldSpec('说明',initial:'${row['instruction']}')]);if(values==null)return;try{await agent!.backend.call('selfwork.longGoals.save',{'id':row['id'],'revision':row['revision'],'title':values[0],'instruction':values[1]});await load();}catch(e){if(mounted)setState(()=>error=SessionRuntime.describeError(e));}}
  Future<void> add()async{final values=await showFieldsDialog(context,title:'长期目标',confirm:'保存',fields:[FieldSpec('标题'),FieldSpec('说明')]);if(values==null)return;try{await agent!.backend.call('selfwork.longGoals.save',{'title':values[0],'instruction':values[1]});await load();}catch(e){if(mounted)setState(()=>error=SessionRuntime.describeError(e));}}
  Future<void> remove(Json row)async{try{await agent!.backend.call('selfwork.longGoals.delete',{'id':row['id']});await load();}catch(e){if(mounted)setState(()=>error=SessionRuntime.describeError(e));}}
  Future<void> toggle(Json row,bool enabled)async{setState((){busy='${row['id']}';error=null;});try{await agent!.backend.call('selfwork.longGoals.setEnabled',{'id':row['id'],'enabled':enabled,'revision':row['revision']});await load();}catch(e){if(mounted)setState(()=>error=SessionRuntime.describeError(e));await load();}finally{if(mounted)setState(()=>busy=null);}}
  String? busy;
  // The prototype's B7 row: title, one muted line (when it last studied, or 「暂停了」), and the switch.
  String subtitle(Json row){
    if(row['enabled']==false)return '暂停了';
    final at=row['lastStudiedAt'];
    return at is num?'空闲时自己学 · 上次 ${longGoalTime(DateTime.fromMillisecondsSinceEpoch(at.toInt()))}':'空闲时自己学';
  }
  @override Widget build(BuildContext context){
    final children=<Widget>[
    for(final row in goals)...[if(row!=goals.first)Divider(height:1,color:context.colors.hairline),Padding(padding:const EdgeInsets.symmetric(vertical:6),child:Row(children:[
      Expanded(child:InkWell(onTap:()=>expand(row),child:Padding(padding:const EdgeInsets.symmetric(vertical:6),child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
        Text('${row['title']}',style:context.text.bodyLarge),
        const SizedBox(height:2),
        Text(subtitle(row),style:context.text.bodySmall?.copyWith(fontSize:12.5,color:context.colors.muted)),
      ])))),
      const SizedBox(width:12),
      V1Toggle(value:row['enabled']!=false,onChanged:busy!=null?null:(v)=>toggle(row,v)),
    ])),if(open==row['id'])...[
      Text('${row['instruction']??''}',style:context.text.bodySmall),
      for(final run in history.where((r)=>r['long_goal_id']==row['id']))Padding(padding:const EdgeInsets.symmetric(vertical:6),child:Text('${run['topic']??run['reason']??''}',style:context.text.bodySmall)),
      Row(children:[TextButton(onPressed:()=>edit(row),child:const Text('修改')),TextButton(onPressed:()=>remove(row),child:const Text('删除'))]),
    ]],
    if(widget.section&&goals.isEmpty&&error==null)Padding(padding:const EdgeInsets.symmetric(vertical:14),child:Text('还没有长期目标',style:context.text.bodySmall?.copyWith(color:context.colors.muted))),
    if(!widget.section)Align(alignment:Alignment.centerLeft,child:SettingsHeadLink('加一个',onPressed:add)),
    if(error!=null)Text(error!,style:TextStyle(color:context.colors.danger)),
    ];
    return widget.section
      ? SettingsCard(title:'长期目标',trailing:SettingsHeadLink('加一个',onPressed:add),children:[Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:children)])
      : Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:children);
  }
}

/// 「今天 09:12」「昨天 23:10」, else 「11月10日」.
String longGoalTime(DateTime at,[DateTime? now]){
  final today=DateUtils.dateOnly(now??DateTime.now()),day=DateUtils.dateOnly(at);
  final clock='${at.hour.toString().padLeft(2,'0')}:${at.minute.toString().padLeft(2,'0')}';
  if(day==today)return '今天 $clock';
  if(day==today.subtract(const Duration(days:1)))return '昨天 $clock';
  return '${at.month}月${at.day}日';
}
