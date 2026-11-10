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
  @override Widget build(BuildContext context){
    final colors=context.colors;
    double value(Json row){var v=0.0;for(final e in asJsonMap(row['amounts']).entries){if(e.value is num)v+=(e.value as num).toDouble();}return v;}
    final total=_month.fold<double>(0,(t,r)=>t+value(r));
    return Scaffold(backgroundColor:colors.background,body:ShellColumn(children:[
      Padding(padding:const EdgeInsets.only(bottom:18),child:Text('花费',style:context.serif(context.text.headlineSmall).copyWith(fontSize:24,fontWeight:FontWeight.w700))),
      if(_busy)const LinearProgressIndicator(),
      if(_error!=null)Row(children:[Expanded(child:Text(_error!,style:TextStyle(color:colors.danger))),ShellButton('重试',small:true,onPressed:_load)]),
      // The prototype's tiles: one card per period, the amount large.
      Row(crossAxisAlignment:CrossAxisAlignment.start,children:[for(final (i,period) in [('本月',_month),('今天',_today)].indexed)...[if(i>0)const SizedBox(width:12),Expanded(child:ShellCard(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[Text(period.$1,style:context.text.bodySmall?.copyWith(color:colors.muted)),Text(spendingAmount(period.$2,details:false),style:context.serif(context.text.headlineSmall).copyWith(fontSize:26,fontFeatures:const [FontFeature.tabularFigures()])),if(spendingNotes(period.$2).isNotEmpty)Text(spendingNotes(period.$2),style:context.text.bodySmall?.copyWith(fontSize:12,color:colors.muted))])))]]),
      const ShellSectionLabel('本月按用途'),
      if(!_busy&&_month.isEmpty)Padding(padding:const EdgeInsets.symmetric(vertical:20),child:Center(child:Text('还没有花费记录',style:TextStyle(color:colors.muted)))),
      for(final row in _month)ShellCard(child:Row(children:[Expanded(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[Text(ledgerPurposes[row['key']]??'其他',style:context.text.bodyMedium?.copyWith(fontWeight:FontWeight.w500)),if(total>0)Padding(padding:const EdgeInsets.only(top:6),child:ClipRRect(borderRadius:BorderRadius.circular(2),child:LinearProgressIndicator(value:(value(row)/total).clamp(0,1),minHeight:4,color:colors.accent,backgroundColor:colors.hairline)))])),const SizedBox(width:16),Text(spendingAmount([row]),textAlign:TextAlign.right,style:const TextStyle(fontFeatures:[FontFeature.tabularFigures()]))])),
      const ShellSectionLabel('明细'),
      const LedgerTable(),
    ]));
  }
}
