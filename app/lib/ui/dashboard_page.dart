import 'package:flutter/material.dart';
import 'spending_page.dart';
export 'spending_page.dart' show spendingAmount;

class UsageRow {
  UsageRow.fromJson(Map<String,dynamic> json):key=json['key'] as String? ?? '',label=json['label'] as String? ?? '',input=(json['input'] as num?)?.toInt()??0,output=(json['output'] as num?)?.toInt()??0,cacheRead=(json['cacheRead'] as num?)?.toInt()??0,cost=(json['cost'] as num?)?.toDouble()??0,responses=(json['responses'] as num?)?.toInt()??0;
  UsageRow.sum(this.key,this.label,Iterable<UsageRow> rows):input=rows.fold(0,(a,r)=>a+r.input),output=rows.fold(0,(a,r)=>a+r.output),cacheRead=rows.fold(0,(a,r)=>a+r.cacheRead),cost=rows.fold(0.0,(a,r)=>a+r.cost),responses=rows.fold(0,(a,r)=>a+r.responses);
  final String key,label;final int input,output,cacheRead,responses;final double cost;int get tokens=>input+output+cacheRead;
}
String formatCost(double cost)=>cost==0?'\$0':cost<.01?'<\$0.01':'\$${cost.toStringAsFixed(2)}';
String formatTokens(int tokens)=>tokens>=1000000?'${(tokens/1000000).toStringAsFixed(1)}M':tokens>=1000?'${(tokens/1000).toStringAsFixed(1)}K':'$tokens';
class DashboardPage extends StatelessWidget {
  const DashboardPage({super.key});
  @override Widget build(BuildContext context)=>const SpendingPage();
}
