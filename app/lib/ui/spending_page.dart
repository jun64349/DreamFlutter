import 'dart:async';
import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';
import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'ledger_table.dart';
import 'shell_widgets.dart';

String spendingAmount(Iterable<Json> rows,{bool details=true}){
  final amounts=<String,double>{};int requests=0,missing=0;
  var estimated=0;
  for(final row in rows){requests+=(row['requests'] as num?)?.toInt()??0;final sources=asJsonMap(row['amountSources']);missing+=(sources['missing'] as num?)?.toInt()??0;estimated+=((sources['price_estimate'] as num?)?.toInt()??0)+((sources['provider_estimate'] as num?)?.toInt()??0);for(final e in asJsonMap(row['amounts']).entries){if(e.value is num)amounts.update(e.key,(v)=>v+(e.value as num).toDouble(),ifAbsent:()=> (e.value as num).toDouble());}}
  if(amounts.isEmpty)return requests==0?'—':'未知';
  final text=amounts.entries.map((e)=>'${e.key == 'USD'?'\$':e.key == 'CNY'?'¥':'${e.key} '}${e.value.toStringAsFixed(2)}').join(' / ');
  if(!details)return text;
  return '$text${estimated>0?'（含估算）':''}${missing>0?' · $missing 笔金额未知':''}';
}

String spendingNotes(Iterable<Json> rows){var missing=0,estimated=0;for(final row in rows){final sources=asJsonMap(row['amountSources']);missing+=(sources['missing'] as num?)?.toInt()??0;estimated+=((sources['price_estimate'] as num?)?.toInt()??0)+((sources['provider_estimate'] as num?)?.toInt()??0);}return [if(estimated>0)'含估算',if(missing>0)'$missing 笔金额未知'].join(' · ');}

/// "37 次 · 套餐用了 $0.05": how many requests, and how much of a plan they used (0.8.1 S.8).
String spendingFacts(Iterable<Json> rows){
  var requests=0;final plan=<String,double>{};
  for(final row in rows){
    requests+=(row['requests'] as num?)?.toInt()??0;
    for(final e in asJsonMap(row['allowance']).entries){
      if(e.value is num){final unit=e.key.split(':').first;plan.update(unit,(v)=>v+(e.value as num).toDouble(),ifAbsent:()=>(e.value as num).toDouble());}
    }
  }
  if(requests==0)return '还没有请求';
  String money(String unit,double v)=>'${unit=='USD'?'\$':unit=='CNY'?'¥':'$unit '}${v<.01?v.toStringAsFixed(4):v.toStringAsFixed(2)}';
  return ['$requests 次',if(plan.isNotEmpty)'套餐用了 ${plan.entries.map((e)=>money(e.key,e.value)).join(' / ')}',if(spendingNotes(rows).contains('未知'))'有的金额未知'].join(' · ');
}

class SpendingPage extends StatefulWidget {
  const SpendingPage({super.key});
  @override State<SpendingPage> createState()=>_SpendingPageState();
}
class _SpendingPageState extends State<SpendingPage>{
  List<Json> _month=[],_today=[];bool _busy=false;String? _error;AgentController? _agent;StreamSubscription<Json>? _events;
  @override void didChangeDependencies(){super.didChangeDependencies();final a=AgentScope.read(context);if(_agent==a)return;_agent=a;_events?.cancel();_events=a.backend.events.listen((e){if(e['event']=='run.finished'||e['event']=='ledger.changed')_load();});_load();}
  @override void dispose(){_events?.cancel();super.dispose();}
  Future<void> _load()async{
    if(_busy)return;setState((){_busy=true;_error=null;});
    try{final now=DateTime.now(),month=DateTime(now.year,now.month),day=DateTime(now.year,now.month,now.day),through=day.add(const Duration(days:1));
      final rows=await Future.wait([for(final start in [month,day])_agent!.backend.call('ledger.summary',{'since':start.millisecondsSinceEpoch,'until':through.millisecondsSinceEpoch,'period':'month','groupBy':'purpose'})]);
      if(mounted)setState((){_month=jsonRows(asJsonMap(rows[0])['rows']);_today=jsonRows(asJsonMap(rows[1])['rows']);});
    }catch(e){if(mounted)setState(()=>_error='没能读取花费，请重试。');}finally{if(mounted)setState(()=>_busy=false);}
  }
  // 0.8.1 S.8: each card says how much, how many requests, and how much of a plan they used; the purposes
  // are one table of only what was actually used; the ledger below is compact and filterable.
  @override Widget build(BuildContext context){
    final colors=context.colors;
    double value(Json row){var v=0.0;for(final e in asJsonMap(row['amounts']).entries){if(e.value is num)v+=(e.value as num).toDouble();}return v;}
    final used=_month.where((r)=>((r['requests'] as num?)??0)>0).toList()..sort((a,b)=>value(b).compareTo(value(a)));
    final total=used.fold<double>(0,(t,r)=>t+value(r));
    final tabular=const TextStyle(fontFeatures:[FontFeature.tabularFigures()]);
    Widget tile(String name,List<Json> rows)=>ShellCard(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
      Text(name,style:context.text.bodySmall?.copyWith(color:colors.muted)),
      Text(spendingAmount(rows,details:false),style:context.serif(context.text.headlineSmall).copyWith(fontSize:26,fontFeatures:const [FontFeature.tabularFigures()])),
      Text(spendingFacts(rows),style:context.text.bodySmall?.copyWith(fontSize:12,color:colors.muted)),
    ]));
    return Scaffold(backgroundColor:colors.background,body:ShellColumn(children:[
      Padding(padding:const EdgeInsets.only(bottom:18),child:Text('花费',style:context.serif(context.text.headlineSmall).copyWith(fontSize:24,fontWeight:FontWeight.w700))),
      if(_busy)const LinearProgressIndicator(),
      if(_error!=null)Row(children:[Expanded(child:Text(_error!,style:TextStyle(color:colors.danger))),ShellButton('重试',small:true,onPressed:_load)]),
      Row(crossAxisAlignment:CrossAxisAlignment.start,children:[Expanded(child:tile('本月',_month)),const SizedBox(width:12),Expanded(child:tile('今天',_today))]),
      const ShellSectionLabel('本月按用途'),
      if(!_busy&&used.isEmpty)Padding(padding:const EdgeInsets.symmetric(vertical:20),child:Center(child:Text('还没有花费记录',style:TextStyle(color:colors.muted)))),
      if(used.isNotEmpty)ShellCard(child:Column(children:[
        for(final (i,row) in used.indexed)...[
          if(i>0)Divider(height:1,color:colors.hairline),
          Padding(padding:const EdgeInsets.symmetric(vertical:9),child:Row(children:[
            SizedBox(width:96,child:Text(ledgerPurposes[row['key']]??'其他',style:context.text.bodyMedium)),
            Expanded(child:total>0?ClipRRect(borderRadius:BorderRadius.circular(2),child:LinearProgressIndicator(value:(value(row)/total).clamp(0,1),minHeight:4,color:colors.accent,backgroundColor:colors.hairline)):const SizedBox()),
            const SizedBox(width:16),
            SizedBox(width:64,child:Text('${row['requests']} 次',textAlign:TextAlign.right,style:context.text.bodySmall?.copyWith(color:colors.muted).merge(tabular))),
            SizedBox(width:110,child:Text(spendingAmount([row],details:false),textAlign:TextAlign.right,style:tabular)),
          ])),
        ],
      ])),
      const ShellSectionLabel('明细'),
      const LedgerTable(),
    ]));
  }
}
