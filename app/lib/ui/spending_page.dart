import 'dart:async';
import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';
import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'ledger_table.dart';
import 'mini_charts.dart';
import 'settings_workspace.dart' show modelDisplayName;
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

/// What the charts measure: money, or requests (a month of plan use has no money to show).
enum _Measure { amount, requests }

class _SpendingPageState extends State<SpendingPage>{
  List<Json> _month=[],_today=[],_days=[],_models=[];bool _busy=false;String? _error;AgentController? _agent;StreamSubscription<Json>? _events;
  _Measure? _measure;
  @override void didChangeDependencies(){super.didChangeDependencies();final a=AgentScope.read(context);if(_agent==a)return;_agent=a;_events?.cancel();_events=a.backend.events.listen((e){if(e['event']=='run.finished'||e['event']=='ledger.changed')_load();});_load();}
  @override void dispose(){_events?.cancel();super.dispose();}
  Future<void> _load()async{
    if(_busy)return;setState((){_busy=true;_error=null;});
    try{final now=DateTime.now(),month=DateTime(now.year,now.month),day=DateTime(now.year,now.month,now.day),through=day.add(const Duration(days:1)),from=day.subtract(const Duration(days:29));
      Future<Object?> summary(DateTime since,String period,String group)=>_agent!.backend.call('ledger.summary',{'since':since.millisecondsSinceEpoch,'until':through.millisecondsSinceEpoch,'period':period,'groupBy':group});
      final rows=await Future.wait([summary(month,'month','purpose'),summary(day,'month','purpose'),summary(from,'day','all'),summary(month,'month','model')]);
      if(mounted)setState((){_month=jsonRows(asJsonMap(rows[0])['rows']);_today=jsonRows(asJsonMap(rows[1])['rows']);_days=jsonRows(asJsonMap(rows[2])['rows']);_models=jsonRows(asJsonMap(rows[3])['rows']);});
    }catch(e){if(mounted)setState(()=>_error='没能读取花费，请重试。');}finally{if(mounted)setState(()=>_busy=false);}
  }

  static double _amount(Json row){var v=0.0;for(final e in asJsonMap(row['amounts']).entries){if(e.value is num)v+=(e.value as num).toDouble();}return v;}
  static double _requests(Json row)=>((row['requests'] as num?)??0).toDouble();

  // 0.8.2 (user test: "做成可视化图表"): the last 30 days as bars, this month by purpose and by
  // model as rings with their legends; the ledger stays below for the details.
  @override Widget build(BuildContext context){
    final colors=context.colors;
    final agent=AgentScope.of(context);
    final used=_month.where((r)=>_requests(r)>0).toList();
    final money=used.fold<double>(0,(t,r)=>t+_amount(r));
    // Money when there is some to show; requests otherwise (plans, unknown prices).
    final measure=_measure??(money>0?_Measure.amount:_Measure.requests);
    double value(Json row)=>measure==_Measure.amount?_amount(row):_requests(row);
    String unit(List<Json> rows)=>spendingAmount(rows,details:false);
    String fmt(double v)=>measure==_Measure.amount?(v==0?'\$0':v<.01?'<\$0.01':'\$${v.toStringAsFixed(2)}'):'${v.round()} 次';
    Widget tile(String name,List<Json> rows)=>ShellCard(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
      Text(name,style:context.text.bodySmall?.copyWith(color:colors.muted)),
      Text(spendingAmount(rows,details:false),style:context.serif(context.text.headlineSmall).copyWith(fontSize:26,fontFeatures:const [FontFeature.tabularFigures()])),
      Text(spendingFacts(rows),style:context.text.bodySmall?.copyWith(fontSize:12,color:colors.muted)),
    ]));
    // The last 30 days, one bar a day (days without requests stay empty).
    final today=DateTime.now();
    final byDay={for(final r in _days)'${r['period']}':r};
    final days=[for(var i=29;i>=0;i--)today.subtract(Duration(days:i))];
    String key(DateTime d)=>'${d.year}-${d.month.toString().padLeft(2,'0')}-${d.day.toString().padLeft(2,'0')}';
    final dayValues=[for(final d in days)byDay[key(d)]==null?0.0:value(byDay[key(d)]!)];
    final purposes=[...used]..sort((a,b)=>value(b).compareTo(value(a)));
    final models=_models.where((r)=>_requests(r)>0).toList()..sort((a,b)=>value(b).compareTo(value(a)));
    // A ring shows at most six slices; the rest are summed as 其他.
    (List<String>,List<double>,List<String>) slices(List<Json> rows,String Function(Json) name){
      final top=rows.take(6).toList(),rest=rows.skip(6).toList();
      return ([for(final r in top)name(r),if(rest.isNotEmpty)'其他'],[for(final r in top)value(r),if(rest.isNotEmpty)rest.fold<double>(0,(t,r)=>t+value(r))],[for(final r in top)'${r['requests']} 次 · ${unit([r])}',if(rest.isNotEmpty)'${rest.fold<double>(0,(t,r)=>t+_requests(r)).round()} 次 · ${unit(rest)}']);
    }
    final purposeSlices=slices(purposes,(r)=>ledgerPurposes[r['key']]??'其他');
    final modelSlices=slices(models,(r){final k='${r['key']}';final name=modelDisplayName(agent,k);return name=='暂不可用'?k.split('/').last:name;});
    Widget chartCard(String title,Widget child)=>Padding(padding:const EdgeInsets.only(bottom:14),child:ShellCard(child:Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[
      Row(children:[ButterflyGlyph(size:12,color:colors.accent.withValues(alpha:.7)),const SizedBox(width:8),Text(title,style:context.text.titleSmall?.copyWith(color:colors.ink2))]),
      const SizedBox(height:12),child,
    ])));
    return Scaffold(backgroundColor:colors.background,body:ShellColumn(children:[
      Padding(padding:const EdgeInsets.only(bottom:18),child:Row(children:[
        Text('花费',style:context.serif(context.text.headlineSmall).copyWith(fontSize:24,fontWeight:FontWeight.w700)),
        const Spacer(),
        SegmentedButton<_Measure>(
          showSelectedIcon:false,
          style:SegmentedButton.styleFrom(visualDensity:VisualDensity.compact),
          segments:const [ButtonSegment(value:_Measure.amount,label:Text('按金额')),ButtonSegment(value:_Measure.requests,label:Text('按次数'))],
          selected:{measure},
          onSelectionChanged:(v)=>setState(()=>_measure=v.first),
        ),
      ])),
      if(_busy)const LinearProgressIndicator(),
      if(_error!=null)Row(children:[Expanded(child:Text(_error!,style:TextStyle(color:colors.danger))),ShellButton('重试',small:true,onPressed:_load)]),
      Row(crossAxisAlignment:CrossAxisAlignment.start,children:[Expanded(child:tile('本月',_month)),const SizedBox(width:12),Expanded(child:tile('今天',_today))]),
      const SizedBox(height:14),
      chartCard('近 30 天',DayBarChart(labels:[for(final d in days)'${d.month}月${d.day}日'],values:dayValues,format:fmt)),
      if(!_busy&&used.isEmpty)Padding(padding:const EdgeInsets.symmetric(vertical:20),child:Center(child:Text('还没有花费记录',style:TextStyle(color:colors.muted)))),
      if(used.isNotEmpty)LayoutBuilder(builder:(context,c){
        final purpose=chartCard('本月按用途',DonutChart(names:purposeSlices.$1,values:purposeSlices.$2,details:purposeSlices.$3,center:fmt(purposeSlices.$2.fold(0,(a,b)=>a+b))));
        final model=chartCard('本月按模型',DonutChart(names:modelSlices.$1,values:modelSlices.$2,details:modelSlices.$3,center:fmt(modelSlices.$2.fold(0,(a,b)=>a+b))));
        if(c.maxWidth<900||models.isEmpty)return Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[purpose,if(models.isNotEmpty)model]);
        return Row(crossAxisAlignment:CrossAxisAlignment.start,children:[Expanded(child:purpose),const SizedBox(width:14),Expanded(child:model)]);
      }),
      const ShellSectionLabel('明细'),
      const LedgerTable(),
    ]));
  }
}
