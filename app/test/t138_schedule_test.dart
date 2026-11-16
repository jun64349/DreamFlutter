import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/state/goal_conversation.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/schedule_page.dart';
import 'package:dreamflutter/ui/schedule_settings.dart';
import 'package:dreamflutter/ui/settings_controls.dart';
import 'package:dreamflutter/ui/attention_page.dart';
import 'package:dreamflutter/ui/sidebar.dart';
import 't87_fixture.dart';
import 'v012_fixture.dart';

void main() {
  Future<void> settle(WidgetTester t) async { await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds:40))); await t.pump(); }
  testWidgets('sidebar goal dots update without moving conversations and calendar is butterfly only', (t) async {
    final f=(await t.runAsync(T87Fixture.create))!;
    final api=V012Fixtures(f.backend,sessionFile:f.agent.currentSessionPath!,slotId:f.agent.active!.slotId!)..goals();
    addTearDown(() async { await t.pumpWidget(const SizedBox()); await t.runAsync(f.dispose); });
    await t.binding.setSurfaceSize(const Size(1200,900));
    await t.pumpWidget(AgentScope(controller:f.agent,child:MaterialApp(theme:buildTheme(Brightness.light),home:const Scaffold(body:Sidebar())))); await settle(t);
    expect(find.text('日程'),findsNothing);
    expect(t.widgetList<ScheduleGoalDot>(find.byType(ScheduleGoalDot)).any((w)=>w.status=='queued'),isTrue);
    final before=f.agent.sidebar.map((e)=>e.path).toList();
    api.use('goals.list','goals.list.paused'); for(final e in api.events('goals.changed')) { f.backend.push(e); } await settle(t);
    expect(t.widgetList<ScheduleGoalDot>(find.byType(ScheduleGoalDot)).any((w)=>w.status=='paused'),isTrue);
    expect(f.agent.sidebar.map((e)=>e.path).toList(),before);
    await t.runAsync(()=>f.agent.openButterfly()); await settle(t);
    expect(find.text('日程'),findsOneWidget);
    await t.tap(find.text('日程')); await settle(t);
    expect(f.agent.section.name,'schedules');
    await t.pumpWidget(const SizedBox());
  });
  testWidgets('calendar navigation, versioned edits, history, run/remove and patrol use wire records', (t) async {
    final f=(await t.runAsync(T87Fixture.create))!;
    final api=V012Fixtures(f.backend,sessionFile:f.agent.currentSessionPath!,slotId:f.agent.active!.slotId!)..schedules();
    final row=api.bind(V012Fixtures.read('schedules.get')) as Map;
    scheduleNavigationRequest.value=row['id'];
    addTearDown(() async { await t.pumpWidget(const SizedBox()); await t.runAsync(f.dispose); scheduleNavigationRequest.value=null; });
    await t.binding.setSurfaceSize(const Size(1400,1100));
    await t.pumpWidget(AgentScope(controller:f.agent,child:MaterialApp(theme:buildTheme(Brightness.light),home:const SchedulePage()))); await settle(t);
    expect(find.text('时令'),findsOneWidget);
    expect(f.backend.callsTo('schedules.get').last,{'id':row['id']});
    final editor=t.widget<ScheduleEditor>(find.byType(ScheduleEditor));
    expect(editor.state.day.day,DateTime.fromMillisecondsSinceEpoch(row['nextRunAt'] as int).day);
    await t.ensureVisible(find.text('保存')); await t.tap(find.text('保存')); await settle(t);
    expect(f.backend.callsTo('schedules.save').last,{'id':row['id'],'expectedVersion':1,'name':row['name'],'kind':'reminder','trigger':row['trigger']});
    final conflict=api.bind(V012Fixtures.read('schedules.save.conflict')) as Map;
    f.backend.handlers['schedules.save']=(_) => throw CoreException('${conflict['code']}','${conflict['message']}',data:conflict['data']);
    await t.tap(find.text('保存')); await settle(t);
    expect(find.text('刚被改过，已刷新'),findsOneWidget);
    expect(t.widget<ScheduleEditor>(find.byType(ScheduleEditor)).value['version'],2);
    await t.ensureVisible(find.text('现在做一次')); await t.tap(find.text('现在做一次')); await settle(t);
    expect(f.backend.callsTo('schedules.runNow').last,{'id':row['id']});
    await t.ensureVisible(find.text('撤销这次修改').first); await t.tap(find.text('撤销这次修改').first); await settle(t);
    expect(f.backend.callsTo('schedules.undo').last,{'changeId':(V012Fixtures.read('schedules.history') as List).first['id']});
    await t.ensureVisible(find.byTooltip('巡检记录')); await t.tap(find.byTooltip('巡检记录')); await settle(t);
    expect(find.textContaining('蝶君的沙箱还没准备好'),findsWidgets);
    await t.tap(find.text('现在巡检')); await settle(t);
    expect(f.backend.callsTo('patrol.runNow').last,isEmpty);
    api.use('patrol.status','patrol.status.cooldown');
    for(final e in api.events('patrol.changed')) { f.backend.push(e); } await settle(t);
    expect(t.widget<TextButton>(find.widgetWithText(TextButton,'现在巡检')).onPressed,isNull);
    await t.ensureVisible(find.text('删除')); await t.tap(find.text('删除')); await settle(t);
    expect(f.backend.callsTo('schedules.remove').last,{'id':row['id'],'expectedVersion':1});
    expect(find.byType(ScheduleEditor),findsNothing);
    await t.ensureVisible(find.text('新建')); await t.tap(find.text('新建')); await settle(t);
    expect(find.byType(ScheduleEditor),findsOneWidget);
    await t.pumpWidget(const SizedBox());
  });
  testWidgets('rules modes and patrol settings send documented settings keys', (t) async {
    final f=(await t.runAsync(T87Fixture.create))!;
    final api=V012Fixtures(f.backend,sessionFile:f.agent.currentSessionPath!,slotId:f.agent.active!.slotId!)..schedules()..use('settings.update','settings.update.patrol');
    addTearDown(() async { await t.pumpWidget(const SizedBox()); await t.runAsync(f.dispose); });
    await t.binding.setSurfaceSize(const Size(1100,1300));
    await t.pumpWidget(AgentScope(controller:f.agent,child:MaterialApp(theme:buildTheme(Brightness.light),home:const Scaffold(body:SingleChildScrollView(child:Column(children:[ScheduleRules(),ScheduleSettings()])))))); await settle(t);
    for(final entry in {'off':'关','observe':'观察','auto':'自动'}.entries) { api.use('autonomy.rules.list','autonomy.rules.list.${entry.key}'); await t.tap(find.text(entry.value).last); await settle(t); expect(f.backend.callsTo('autonomy.rules.mode').last,{'id':(V012Fixtures.read('autonomy.rules.save') as Map)['id'],'mode':entry.key}); }
    final toggle=t.widget<SettingsSwitch>(find.byType(SettingsSwitch)); await toggle.save(true); expect(f.backend.callsTo('settings.update').last,{'patrolEnabled':true});
    final interval=t.widget<SettingChoice<int>>(find.byType(SettingChoice<int>)); await interval.save(15); expect(f.backend.callsTo('settings.update').last,{'patrolIntervalMin':15});
    await t.tap(find.text('高级')); await settle(t);
    for(final field in t.widgetList<AutoSaveField>(find.byType(AutoSaveField))) { await field.save(field.value); }
    expect(f.backend.callsTo('settings.update').any((p)=>p.containsKey('patrolDailyBudget')),isTrue);
    expect(f.backend.callsTo('settings.update').any((p)=>p.containsKey('patrolStaleHours')),isTrue);
    expect(f.backend.callsTo('settings.update').any((p)=>p.containsKey('patrolKeepDays')),isTrue);
    await t.widget<SettingChoice<String>>(find.byType(SettingChoice<String>)).save('latest'); expect(f.backend.callsTo('settings.update').last,{'scheduleMissedDefault':'latest'});
    api.use('autonomy.rules.list','autonomy.rules.list.auto');
    await t.pumpWidget(const SizedBox());
  });
  testWidgets('inbox uses fixed priority order and preserves rule confirmation actions', (t) async {
    final f=(await t.runAsync(T87Fixture.create))!;
    final api=V012Fixtures(f.backend,sessionFile:f.agent.currentSessionPath!,slotId:f.agent.active!.slotId!)..use('attention.list')..use('attention.prioritized')..use('attention.resolve','attention.resolve.observe');
    await f.agent.attention.refresh();
    addTearDown(() async { await t.pumpWidget(const SizedBox()); await t.runAsync(f.dispose); });
    await t.binding.setSurfaceSize(const Size(1100,1500));
    await t.pumpWidget(AgentScope(controller:f.agent,child:MaterialApp(theme:buildTheme(Brightness.light),home:const AttentionPage()))); await settle(t);
    await t.ensureVisible(find.text('先观察').first); await t.tap(find.text('先观察').first); await settle(t);
    expect(f.backend.callsTo('attention.resolve').last['action'],'allow');
    api.use('attention.resolve','attention.resolve.reject');
    await t.ensureVisible(find.text('不要').first); await t.tap(find.text('不要').first); await settle(t);
    expect(f.backend.callsTo('attention.resolve').last['action'],'reject');
    api.use('attention.list','attention.list.groups'); api.use('attention.prioritized','attention.prioritized.groups');
    f.backend.push({'event':'attention.changed'}); await settle(t); await settle(t);
    final decision=find.textContaining('待你决定 ·'), blocked=find.textContaining('卡住了 ·'), review=find.textContaining('等你验收 ·');
    expect(decision,findsOneWidget); expect(blocked,findsOneWidget); expect(review,findsOneWidget);
    expect(t.getTopLeft(decision).dy,lessThan(t.getTopLeft(blocked).dy)); expect(t.getTopLeft(blocked).dy,lessThan(t.getTopLeft(review).dy));
    await t.pumpWidget(const SizedBox());
  });
}
