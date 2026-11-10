import 'dart:io';
import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/ui/message_widgets.dart';
import 'package:dreamflutter/ui/conversation_cards.dart';
import 'package:dreamflutter/ui/workspace_path.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 't90_fixture.dart';

void main() {
  late T90Core core; late T90Backend backend; late AgentController agent;
  Future<void> settle(WidgetTester tester) async {
    for(var i=0;i<150;i++) {await tester.runAsync(()=>Future<void>.delayed(const Duration(milliseconds:100)));await tester.pump(const Duration(milliseconds:100));if(backend.pendingGit==0)break;}
    expect(backend.pendingGit,0,reason:'real Git RPC must finish before assertions');await tester.pumpAndSettle();
  }
  Future<void> start(WidgetTester tester) async {
    final previous=HttpOverrides.current;HttpOverrides.global=null;addTearDown(()=>HttpOverrides.global=previous);
    core=(await tester.runAsync(startT90Core))!;backend=T90Backend(core.client,core.zone)..sessionRows=[];
    final cwd=core.workspace;
    backend.onLaunch=(pi){pi.messages=t90History(cwd);};
    backend.handlers['runs.list']=(_)=>[{'id':'run','status':'done','files':['$cwd/report.md','$cwd/summary.md']}];
    backend.handlers['tasks.forSession']=(_)=>{'id':'task'};
    backend.handlers['artifacts.list']=(_)=>[{'path':'$cwd/report.md'},{'path':'$cwd/summary.md'}];
    SharedPreferences.setMockInitialValues({'workspace':cwd,'onboarded':true});
    agent=AgentController(preferences:(await tester.runAsync(Preferences.load))!,backend:backend,sessionStore:SessionStore(sessionsDir:core.info['sessions'] as String));
    addTearDown(() async {await tester.pumpWidget(const SizedBox());agent.dispose();await tester.runAsync(core.close);});
    await tester.binding.setSurfaceSize(const Size(1400,900));
    await tester.pumpWidget(DreamFlutterApp(controller:agent));await tester.runAsync(agent.init);
    await tester.runAsync(()=>agent.openSession(p.join(cwd,'conversation.jsonl')));agent.setRunPanelOpen(true);await settle(tester);
  }
  testWidgets('default window bridge prepares real diff, edits draft and commits selected files without a second approval', (tester) async {
    await start(tester);
    expect(find.text('report.md'),findsOneWidget);expect(find.text('summary.md'),findsOneWidget);
    final labels=tester.widgetList<Text>(find.descendant(of:find.byType(WorkspacePathLabel),matching:find.byType(Text))).map((w)=>w.data).toList();
    expect(labels,containsAll(['report.md','summary.md']));expect(find.byTooltip(p.normalize('${core.workspace}/report.md')),findsOneWidget);
    expect(backend.callsTo('git.prepareCommit'),isEmpty);
    await tester.tap(find.text('提交这些改动'));await settle(tester);
    expect(backend.callsTo('git.commit'),isEmpty);expect(find.textContaining('diff --git'),findsNothing);
    expect(tester.widgetList<Checkbox>(find.byType(Checkbox)).map((w)=>w.value),everyElement(isTrue));expect(find.byType(DiffView),findsNothing);
    await tester.tap(find.byKey(const ValueKey('commit-expand-report.md')));await settle(tester);
    expect(find.byType(DiffView),findsOneWidget);expect(find.textContaining('结论待补充'),findsOneWidget);
    final field=find.byWidgetPredicate((w)=>w is TextField && w.decoration?.labelText=='提交说明');
    expect(tester.widget<TextField>(field).controller!.text,'整理实验结论与下一步验证');
    await tester.enterText(field,'用户核对后的实验小结');await tester.tap(find.text('确认提交'));await settle(tester);
    expect(find.textContaining('已提交 '),findsOneWidget);expect(find.byType(ConversationApprovalCard),findsNothing);
    final sent=backend.callsTo('git.commit').single;expect(sent['paths'],['report.md','summary.md']);expect(sent['expectedFingerprint'],isA<String>());expect(sent['expectedHead'],isA<String>());
    final result=await tester.runAsync(()=>core.call('test.result')) as Map;
    expect(result['subject'],'用户核对后的实验小结');expect(result['files'],['report.md','summary.md']);expect(result['staged'],'unrelated.txt');
    expect(await tester.runAsync(()=>core.call('confirm.list')),isEmpty);
  });
  testWidgets('unchecked files are excluded by the real commit and empty selection disables confirmation', (tester) async {
    await start(tester);await tester.tap(find.text('提交这些改动'));await settle(tester);
    final report=find.byKey(const ValueKey('commit-select-report.md')), summary=find.byKey(const ValueKey('commit-select-summary.md'));
    await tester.tap(report);await tester.tap(summary);await tester.pump();
    expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton,'确认提交')).onPressed,isNull);expect(backend.callsTo('git.commit'),isEmpty);
    await tester.tap(report);await tester.pump();
    final field=find.byWidgetPredicate((w)=>w is TextField && w.decoration?.labelText=='提交说明');await tester.enterText(field,'只更新实验小结');await tester.pump();
    await tester.tap(find.text('确认提交'));await settle(tester);
    expect(find.textContaining('已提交 '),findsOneWidget);expect(backend.callsTo('git.commit').single['paths'],['report.md']);expect(backend.callsTo('git.commit').single['expectedPaths'],['report.md','summary.md']);
    final result=await tester.runAsync(()=>core.call('test.result')) as Map;
    expect(result['files'],['report.md']);expect(result['staged'],'unrelated.txt');
    expect(File(p.join(core.workspace,'summary.md')).readAsStringSync(),contains('实验摘要'));
  });
  testWidgets('missing small model permits manual text and real stale-file error is shown', (tester) async {
    await start(tester);await tester.runAsync(()=>core.call('test.manual'));
    await tester.tap(find.text('提交这些改动'));await settle(tester);
    expect(find.textContaining('小任务模型暂时不可用'),findsOneWidget);
    expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton,'确认提交')).onPressed,isNull);
    final field=find.byWidgetPredicate((w)=>w is TextField && w.decoration?.labelText=='提交说明');
    await tester.enterText(field,'手写实验小结');await tester.pump();await tester.runAsync(()=>core.call('test.change'));
    await tester.tap(find.text('确认提交'));await settle(tester);
    expect(find.textContaining('所选文件或仓库已变化'),findsOneWidget);expect(find.textContaining('已提交 '),findsNothing);
    await tester.tap(find.text('取消').last);await settle(tester);
    await tester.tap(find.text('提交这些改动'));await settle(tester);
    await tester.enterText(field,'重新核对后手写提交');await tester.pump();await tester.tap(find.text('确认提交'));await settle(tester);
    expect(find.textContaining('已提交 '),findsOneWidget);expect(find.textContaining('小任务模型暂时不可用'),findsNothing,reason:'draft fallback instructions expire after success');
  });
  testWidgets('pending approval shows only current card with relative path and keeps prior process', (tester) async {
    await start(tester);agent.setRunPanelOpen(false);final pi=backend.pis.last;pi.startRun('检查小结');
    final tool={'role':'assistant','content':[{'type':'toolCall','id':'live','name':'edit','arguments':{'path':'${core.workspace}/report.md','oldText':'旧','newText':'新'}}],'timestamp':10,'stopReason':'toolUse'};
    pi.emit({'type':'message_start','message':tool});pi.emit({'type':'message_end','message':tool});pi.emit({'type':'tool_execution_start','toolCallId':'live','toolName':'edit','args':(tool['content'] as List).first['arguments']});
    pi.emit({'type':'extension_ui_request','id':'a','method':'select','title':'Agent 请求执行操作\n\n修改文件：${core.workspace}/report.md','options':['允许','拒绝','本会话内总是允许「edit」']});await settle(tester);
    expect(find.text('这一笔等你点头'),findsNothing);expect(find.text('等待你决定这次操作'),findsNothing);expect(find.text('修改文件：report.md'),findsOneWidget);
    expect(find.byType(WorkBlock),findsOneWidget,reason:'historical process remains; current duplicate process is hidden');
    expect(find.byType(ConversationApprovalCard),findsOneWidget);
    await tester.tap(find.text('拒绝').last);pi.finishRun();await settle(tester);
    expect(pi.commands.lastWhere((c)=>c['type']=='extension_ui_response')['value'],'拒绝');
    expect(relativeWorkspacePath(core.workspace,p.join(p.dirname(core.workspace),'outside.md')),p.join(p.dirname(core.workspace),'outside.md'));
  });
}
