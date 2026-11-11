import 'package:dreamflutter/state/garden.dart';
import 'dart:async' show Completer;
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/garden_page.dart';
import 'package:dreamflutter/ui/motion.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 't89_fixture.dart';

Future<void> waitGarden(WidgetTester tester) async {
  for(var i=0;i<6;i++) { await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds:20))); await tester.pump(const Duration(milliseconds:100)); }
}
void main() {
  late T89Fixture fixture;
  Future<void> start(WidgetTester tester, {bool services=true}) async {
    fixture=(await tester.runAsync(T89Fixture.create))!;
    if(!services) fixture.servers.clear();
    await tester.binding.setSurfaceSize(const Size(1040,800));
    await tester.pumpWidget(AgentScope(controller:fixture.agent, child:MaterialApp(theme:buildTheme(Brightness.light), home:const Scaffold(body:GardenPage()))));
    await waitGarden(tester);
    addTearDown(() async { await tester.pumpWidget(const SizedBox()); await tester.runAsync(fixture.dispose); });
  }
  testWidgets('T89 combines reusable commands with skills and keeps only three states', (tester) async {
    await start(tester);
    expect(find.text('蝶园'),findsOneWidget); expect(find.text('实验周报'),findsOneWidget); expect(find.text('连接的服务'),findsOneWidget);
    for(final text in ['任务模板','MCP 服务','已信任','待确认']) { expect(find.text(text),findsNothing); }
    await tester.tap(find.text('检查引用')); await waitGarden(tester);
    expect(find.text('去等你处理'),findsOneWidget); expect(find.text('采用'),findsNothing);
    await tester.tap(find.text('去等你处理')); expect(fixture.agent.section.name,'tasks');
    expect(fixture.backend.callsTo('proposals.accept'),isEmpty);
  });
  testWidgets('T89 reveals services only after one has been connected', (tester) async {
    await start(tester,services:false); expect(find.text('连接的服务'),findsNothing);
    fixture.servers.add({'name':'资料库','scope':'user','trust':'trusted','source':'user','enabled':true}); fixture.backend.push({'event':'mcp.changed'}); await waitGarden(tester);
    expect(find.text('连接的服务'),findsOneWidget);
    fixture.servers.clear(); fixture.backend.push({'event':'mcp.changed'}); await waitGarden(tester); expect(find.text('连接的服务'),findsOneWidget);
  });
  testWidgets('T89 details expose real usage, test results and independent service permission', (tester) async {
    await start(tester);
    await tester.tap(find.text('实验室资料库')); await waitGarden(tester);
    expect(find.text('7 次'),findsOneWidget);
    await tester.tap(find.text('测试连接')); await waitGarden(tester); expect(find.text('连接成功'),findsOneWidget);
    await tester.tap(find.widgetWithText(MotionSwitchTile,'蝶君能用')); await waitGarden(tester);
    expect(fixture.backend.callsTo('mcp.setButterflyAllowed').single['allowed'],true);
    expect(fixture.backend.callsTo('mcp.setEnabled'),isEmpty);
  });
  testWidgets('T93 tool permissions survive stale test results, reenable and save failures', (tester) async {
    await start(tester);
    fixture.backend.handlers['mcp.test']=(_) => {'ok':true,'toolStates':[{'name':'搜索资料','enabled':true},{'name':'读取资料','enabled':false}]};
    await tester.tap(find.text('实验室资料库')); await waitGarden(tester);
    await tester.tap(find.text('测试连接')); await waitGarden(tester);
    final tile=find.widgetWithText(MotionSwitchTile,'搜索资料');
    expect(tester.widget<MotionSwitchTile>(tile).value,true);
    await tester.tap(tile); await waitGarden(tester);
    expect(tester.widget<MotionSwitchTile>(tile).value,false);
    expect(fixture.backend.callsTo('mcp.setToolEnabled').last['enabled'],false);
    expect(find.text('连接成功'),findsOneWidget);
    await tester.tap(tile); await waitGarden(tester);
    expect(tester.widget<MotionSwitchTile>(tile).value,true);
    expect(fixture.backend.callsTo('mcp.setToolEnabled').last['enabled'],true);
    fixture.backend.handlers['mcp.setToolEnabled']=(_) => throw StateError('没有保存');
    await tester.tap(tile); await waitGarden(tester);
    expect(tester.widget<MotionSwitchTile>(tile).value,true);
    expect(find.textContaining('没有保存'),findsOneWidget);
    expect(fixture.backend.callsTo('mcp.setEnabled'),isEmpty);
  });
  testWidgets('T89 snackbar undo cancels deletion before any Core mutation', (tester) async {
    await start(tester); await tester.tap(find.text('删除')); await waitGarden(tester);
    expect(find.text('已删除'),findsOneWidget); expect(fixture.backend.callsTo('skills.remove'),isEmpty);
    await tester.tap(find.text('撤销')); await waitGarden(tester); await tester.pump(const Duration(seconds:6)); await waitGarden(tester);
    expect(fixture.skills.any((s)=>s['name']=='文献整理'),true); expect(fixture.backend.callsTo('skills.remove'),isEmpty);
  });
  testWidgets('T89 failures do not hide entries or claim deletion', (tester) async {
    await start(tester); fixture.backend.handlers['skills.remove']=(_)=>throw StateError('连接中断，请重试');
    await tester.tap(find.text('删除')); await waitGarden(tester);
    await tester.pump(const Duration(seconds:6)); await waitGarden(tester);
    expect(find.textContaining('连接中断'),findsOneWidget); expect(find.text('文献整理'),findsNWidgets(2)); expect(fixture.skills,hasLength(3));
  });
  testWidgets('T89 new skill opens a fresh editable request without sending it', (tester) async {
    await start(tester); await tester.tap(find.text('新建')); await tester.pumpAndSettle();
    await tester.tap(find.text('让它帮我做')); await waitGarden(tester);
    expect(fixture.agent.section.name,'chat'); expect(fixture.agent.active!.editorText,'帮我做一个技能：'); expect(fixture.backend.pis.expand((p)=>p.sent('prompt')),isEmpty);
  });
  test('T89 missing trust and untrusted entries cannot be enabled by the UI', () {
    expect(GardenEntry({'name':'候选','trust':'untrusted','enabled':true}).editable,false);
  });
  test('T89 deletion offers undo without waiting for a slow catalog refresh', () async {
    final f=await T89Fixture.create(), refresh=Completer<Object?>();
    final garden=Garden(f.agent); await garden.load();
    addTearDown(() async { if(!refresh.isCompleted) refresh.complete([]); garden.dispose(); await f.dispose(); });
    final entry=garden.entries.first;
    f.backend.handlers['skills.list']=(_)=>refresh.future;
    final token=await garden.remove(entry).timeout(const Duration(seconds:2));
    expect(garden.entries.any((row)=>row.key==entry.key),false); expect(f.backend.callsTo('skills.remove'),isEmpty);
    refresh.complete(f.skills); await garden.undoRemove(token); expect(garden.entries.any((row)=>row.key==entry.key),true);
  });
}
