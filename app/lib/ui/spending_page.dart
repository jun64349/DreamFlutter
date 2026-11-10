import 'dart:async';
import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';
import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'ledger_table.dart';

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
  @override Widget build(BuildContext context)=>Scaffold(body:ListView(padding:const EdgeInsets.all(28),children:[
    Text('花费',style:context.text.headlineSmall),
    if(_busy)const LinearProgressIndicator(),
    if(_error!=null)Row(children:[Expanded(child:Text(_error!,style:TextStyle(color:context.colors.danger))),TextButton(onPressed:_load,child:const Text('重试'))]),
    const SizedBox(height:24),Wrap(spacing:56,runSpacing:20,children:[for(final period in [('本月',_month),('今天',_today)])SizedBox(width:240,child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[Text(period.$1,style:context.text.bodyMedium),const SizedBox(height:8),Text(spendingAmount(period.$2,details:false),style:context.serif(context.text.headlineMedium)),if(spendingNotes(period.$2).isNotEmpty)Padding(padding:const EdgeInsets.only(top:6),child:Text(spendingNotes(period.$2),style:context.text.bodySmall?.copyWith(color:context.colors.muted)))]))]),
    const SizedBox(height:36),Text('本月按用途',style:context.text.titleMedium),const SizedBox(height:8),
    if(!_busy&&_month.isEmpty)const Padding(padding:EdgeInsets.symmetric(vertical:20),child:Text('还没有花费记录')),
    for(final row in _month)Container(padding:const EdgeInsets.symmetric(vertical:15),decoration:BoxDecoration(border:Border(bottom:BorderSide(color:context.colors.border,width:.5))),child:Row(children:[Expanded(child:Text(ledgerPurposes[row['key']]??'其他')),const SizedBox(width:16),Flexible(child:Text(spendingAmount([row]),textAlign:TextAlign.right))])),
    const SizedBox(height:36),const LedgerTable(),
  ]));
}
