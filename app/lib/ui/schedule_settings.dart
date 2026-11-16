import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';
import '../state/agent_controller.dart';
import '../state/memory_ui.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'settings_controls.dart';
import 'settings_workspace.dart' show ModelSettingMenu;

class ScheduleSettings extends StatefulWidget {
  const ScheduleSettings({super.key});
  @override State<ScheduleSettings> createState() => _ScheduleSettingsState();
}
class _ScheduleSettingsState extends State<ScheduleSettings> {
  bool advanced = false;
  @override Widget build(BuildContext context) {
    final a = AgentScope.of(context), s = a.coreSettings;
    Future<void> save(String key, Object? value) => a.updateCoreSettings({key: value});
    Widget number(String label, String key, num fallback, String unit) => AutoSaveField(label: label, value: '${s[key] ?? fallback}', compact: true, number: true, unit: unit, validator: (v) => num.tryParse(v) == null || num.parse(v) < 0 ? '请输入有效数值' : null, save: (v) => save(key, num.parse(v)));
    return Column(children: [
      SettingsSwitch('巡检', desc: '定时看一眼有没有要做的事，没事只记一句「无需行动」', value: s['patrolEnabled'] == true, save: (v) => save('patrolEnabled',v)),
      SettingChoice<int>('多久一次', indented:true, segmented:true, value: (s['patrolIntervalMin'] as num?)?.toInt() ?? 30, choices: const {10:'10 分钟',15:'15 分钟',30:'30 分钟',60:'60 分钟'}, save: (v) => save('patrolIntervalMin',v)),
      // There is no reminder-only delivery setting in CoreSettings.
      const SettingRow('提醒到点时', child: Text('系统通知')),
      SettingChoice<String>('错过的日程', segmented:true, value: s['scheduleMissedDefault'] as String? ?? 'latest', choices: const {'latest':'补做一次','skip':'跳过'}, save: (v) => save('scheduleMissedDefault',v)),
      Align(alignment: Alignment.centerLeft, child: TextButton.icon(style: TextButton.styleFrom(padding: EdgeInsets.zero, minimumSize: const Size(0, 40)), onPressed: () => setState(() => advanced = !advanced), icon: Icon(advanced ? Icons.expand_more : Icons.chevron_right, size: 16), label: const Text('高级'))),
      if (advanced) ...[
        SettingRow('巡检用的模型', child: ModelSettingMenu(label: '巡检用的模型', selected: s['patrolModel'] as String?, inheritLabel: '小任务模型', onChanged: (v) => save('patrolModel',v))),
        number('巡检每天最多花','patrolDailyBudget',.2,'美元'), number('等你处理放多久算久','patrolStaleHours',24,'小时'),
        number('记录保留','patrolKeepDays',30,'天'),
      ],
    ]);
  }
}

class ScheduleRules extends StatefulWidget {
  const ScheduleRules({super.key});
  @override State<ScheduleRules> createState() => _ScheduleRulesState();
}
class _ScheduleRulesState extends State<ScheduleRules> {
  AgentController? agent;
  List<Json> rules = [];
  String? error, busy;
  @override void didChangeDependencies() { super.didChangeDependencies(); if (agent != null) return; agent = AgentScope.read(context); load(); }
  Future<void> load() async { try { final result = memoryRows(await agent!.backend.call('autonomy.rules.list')); if (mounted) setState(() => rules = result); } catch (e) { if (mounted) setState(() => error = SessionRuntime.describeError(e)); } }
  Future<void> mode(Json row, String mode) async { setState(() { busy = '${row['id']}'; error = null; }); try { await agent!.backend.call('autonomy.rules.mode', {'id':row['id'],'mode':mode}); await load(); } catch(e) { if(mounted)setState(() => error = SessionRuntime.describeError(e)); } finally { if(mounted)setState(() => busy = null); } }
  @override Widget build(BuildContext context) => Column(children: [if(error != null)Text(error!,style:TextStyle(color:context.colors.danger)), if(rules.isEmpty&&error==null)Align(alignment:Alignment.centerLeft,child:Padding(padding:const EdgeInsets.symmetric(vertical:14),child:Text('还没有规则',style:context.text.bodyMedium?.copyWith(color:context.colors.muted)))), for(final row in rules) SettingRow('${row['name']}', child: V1Seg<String>(value:'${row['mode']}',options:const [('off','关'),('observe','观察'),('auto','自动')],onChanged:busy == row['id'] ? null : (v) => mode(row,v)))]);
}
