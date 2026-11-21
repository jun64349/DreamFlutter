import 'dart:async';
import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';
import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'ledger_table.dart';
import 'mini_charts.dart';
import 'plugin_usage_card.dart';
import 'overlay_panel.dart';
import 'proto_icon.dart';
import 'settings_controls.dart' show V1Seg;
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

class SpendingOverlay extends StatelessWidget {
  const SpendingOverlay({super.key, required this.onClose});
  final VoidCallback onClose;
  @override
  Widget build(BuildContext context) => ShellOverlay(label:'锱铢',width:1000,height:760,padding:24,color:context.colors.background,onClose:onClose,child:SpendingPage(onClose:onClose));
}

class SpendingPage extends StatefulWidget {
  const SpendingPage({super.key,this.onClose});
  final VoidCallback? onClose;
  @override State<SpendingPage> createState()=>_SpendingPageState();
}

/// What the charts measure: money, or requests (a month of plan use has no money to show).
enum _Measure { amount, requests }

class _SpendingPageState extends State<SpendingPage>{
  List<Json> _month=[],_today=[],_days=[],_models=[];bool _busy=false;String? _error;AgentController? _agent;StreamSubscription<Json>? _events;
  _Measure? _measure;
  @override void didChangeDependencies(){super.didChangeDependencies();final a=AgentScope.read(context);if(_agent==a)return;_agent=a;_events?.cancel();_events=a.backend.events.listen((e){if(e['event']=='run.finished')_load();});_load();}
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

  @override Widget build(BuildContext context){
    final colors=context.colors;
    final agent=AgentScope.of(context);
    final used=_month.where((r)=>_requests(r)>0).toList();
    final money=used.fold<double>(0,(t,r)=>t+_amount(r));
    final measure=_measure??(money>0?_Measure.amount:_Measure.requests);
    double value(Json row)=>measure==_Measure.amount?_amount(row):_requests(row);
    String unit(List<Json> rows)=>spendingAmount(rows,details:false);
    String fmt(double v)=>measure==_Measure.amount?(v==0?'\$0':v<.01?'<\$0.01':'\$${v.toStringAsFixed(2)}'):'${v.round()} 次';
    Widget tile(String name, String amount, {String? facts}) {
      final card = ShellCard(padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14), child: Column(
        crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(name, style: context.text.bodySmall?.copyWith(fontSize: 12, height: 1.6, color: colors.muted)),
          FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: Text(amount,
            style: context.serif(context.text.headlineSmall).copyWith(fontSize: 24, fontWeight: FontWeight.w600, height: 1.6, fontFeatures: AppTokens.numberFeatures))),
        ],
      ));
      return facts == null ? card : Tooltip(message: facts, child: card);
    }
    String total(List<Json> rows) => measure == _Measure.amount ? unit(rows) : '${rows.fold<int>(0, (sum, row) => sum + _requests(row).round())} 次';
    final today=DateTime.now();
    final byDay={for(final r in _days)'${r['period']}':r};
    final days=[for(var i=29;i>=0;i--)today.subtract(Duration(days:i))];
    String key(DateTime d)=>'${d.year}-${d.month.toString().padLeft(2,'0')}-${d.day.toString().padLeft(2,'0')}';
    final dayValues=[for(final d in days)byDay[key(d)]==null?0.0:value(byDay[key(d)]!)];
    final purposes=[...used]..sort((a,b)=>value(b).compareTo(value(a)));
    final models=_models.where((r)=>_requests(r)>0).toList()..sort((a,b)=>value(b).compareTo(value(a)));
    (List<String>,List<double>,List<String>) slices(List<Json> rows,String Function(Json) name){
      final top=rows.take(6).toList(),rest=rows.skip(6).toList();
      return ([for(final r in top)name(r),if(rest.isNotEmpty)'其他'],[for(final r in top)value(r),if(rest.isNotEmpty)rest.fold<double>(0,(t,r)=>t+value(r))],[for(final r in top)'${r['requests']} 次 · ${unit([r])}',if(rest.isNotEmpty)'${rest.fold<double>(0,(t,r)=>t+_requests(r)).round()} 次 · ${unit(rest)}']);
    }
    final purposeSlices=slices(purposes,(r)=>ledgerPurposes[r['key']]??'其他');
    final modelSlices=slices(models,(r){final k='${r['key']}';final name=modelDisplayName(agent,k);return name=='暂不可用'?k.split('/').last:name;});
    Widget chartCard(Widget child) => Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: ShellCard(padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14), child: child),
    );
    final budget=(agent.coreSettings['monthlyBudgetUsd'] as num?)?.toDouble()??0;
    return Material(color: colors.background, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (widget.onClose != null) Padding(
        padding: const EdgeInsets.fromLTRB(20, 14, 14, 0),
        child: Row(children: [
          Container(
            decoration: BoxDecoration(color: colors.card, borderRadius: BorderRadius.circular(9), border: Border.all(color: colors.hairline)),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            child: Row(children: [ProtoIcon('coin', size: 15, color: colors.ink), const SizedBox(width: 6),
              Text('花费', style: context.text.bodySmall?.copyWith(fontSize: 13.5, height: 1.6, fontWeight: FontWeight.w500)),
            ]),
          ),
          const Spacer(),
          OverlayCloseButton(onClose: widget.onClose!),
        ]),
      ),
      Expanded(child: ShellColumn(maxWidth: 1000, horizontalPadding: 24, padding: const EdgeInsets.only(top: 16, bottom: 24), children: [
      Padding(padding: const EdgeInsets.only(bottom: 18), child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        const Expanded(child: PoeticPageTitle('花费')),
        const SizedBox(width: 12),
        V1Seg<_Measure>(
          value: measure,
          options: const [(_Measure.amount, '金额'), (_Measure.requests, '次数')],
          onChanged: (value) => setState(() => _measure = value),
        ),
      ])),
      if(_busy)const LinearProgressIndicator(),
      if(_error!=null)Row(children:[Expanded(child:Text(_error!,style:TextStyle(color:colors.danger))),ShellButton('重试',small:true,onPressed:_load)]),
      LayoutBuilder(builder:(context,c){
        final tiles=[tile('今天',total(_today),facts:spendingFacts(_today)),tile('这个月',total(_month),facts:spendingFacts(_month)),tile('每月上限',measure==_Measure.requests?'—':budget<=0?'不限':'\$${budget.toStringAsFixed(2)}')];
        if(c.maxWidth<560)return Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:tiles);
        return IntrinsicHeight(child:Row(crossAxisAlignment:CrossAxisAlignment.stretch,children:[for(final (i,child) in tiles.indexed)...[if(i>0)const SizedBox(width:12),Expanded(child:child)]]));
      }),
      const SizedBox(height:14),
      ListenableBuilder(listenable: agent.desktopPlugins, builder: (context, _) =>
          agent.desktopPlugins.active('usage-dashboard') ? const PluginUsageCard() : const SizedBox.shrink()),
      chartCard(DayBarChart(labels:[for(final d in days)'${d.month}月${d.day}日'],values:dayValues,format:fmt)),
      if(!_busy&&used.isEmpty)Padding(padding:const EdgeInsets.symmetric(vertical:20),child:Center(child:Text('还没有花费记录',style:TextStyle(color:colors.muted)))),
      if(used.isNotEmpty)LayoutBuilder(builder:(context,c){
        final purpose=chartCard(DonutChart(title:'按用途',names:purposeSlices.$1,values:purposeSlices.$2,details:purposeSlices.$3));
        final model=chartCard(DonutChart(title:'按模型',names:modelSlices.$1,values:modelSlices.$2,details:modelSlices.$3));
        if(c.maxWidth<640||models.isEmpty)return Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[purpose,if(models.isNotEmpty)model]);
        return Row(crossAxisAlignment:CrossAxisAlignment.start,children:[Expanded(child:purpose),const SizedBox(width:14),Expanded(child:model)]);
      }),
      const ShellSectionLabel('明细'),
      const LedgerTable(),
    ])),
    ]));
  }
}
