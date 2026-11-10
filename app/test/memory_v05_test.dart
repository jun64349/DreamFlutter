import 'package:dreamflutter/ui/memory_page.dart';
import 'package:dreamflutter/ui/memory_log.dart';
import 'package:dreamflutter/ui/memory_details.dart';
import 'package:dreamflutter/ui/memory_chat_controls.dart';
import 'package:dreamflutter/ui/settings_page.dart';
import 'package:dreamflutter/ui/side_chat_view.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'v05_harness.dart';

void main() {
  testWidgets('v0.8 recent records keep compact rows and keyboard undo', (tester) async {
    final h = await startV05(tester);
    await h.mount(tester, const SingleChildScrollView(child: MemoryLog()));
    expect(find.byType(ExpansionTile), findsNothing);
    final row = find.byKey(const ValueKey('memory-log-entry-o1'));
    expect(find.descendant(of: row, matching: find.text(h.fixture.item['content'] as String)), findsOneWidget);
    final undo = find.descendant(of: row, matching: find.text('撤销'));
    expect(undo, findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await settleV05(tester);
    expect(h.backend.callsTo('memory.undo').single['opId'], 'o1');
    expect(find.text('删掉了'), findsOneWidget);
    expect(find.textContaining('一级'), findsNothing);
  });

  testWidgets('step 8 pages and forms fit a small window at 150 percent app zoom', (tester) async {
    final h = await startV05(tester);
    await tester.binding.setSurfaceSize(const Size(1000, 800));
    for (final page in [const MemoryPage(), const SettingsPage(category: '记忆'), const SettingsPage(category: '对话')]) {
      await tester.pumpWidget(const SizedBox());
      await h.mount(tester, page, zoom: 1.5);
      expect(tester.takeException(), isNull, reason: '${page.runtimeType} ${page is SettingsPage ? page.category : ""}');
    }
    await h.mount(tester, Builder(builder: (context) => TextButton(onPressed: () => showMemoryDetails(context, 'm1'), child: const Text('详情'))), zoom: 1.5);
    await tester.tap(find.text('详情')); await settleV05(tester);
    expect(tester.takeException(), isNull);
  });
  testWidgets('v0.8 recent records paginate without mechanism filters', (tester) async {
    final h = await startV05(tester);
    await h.mount(tester, const SingleChildScrollView(child: MemoryLog()));
    expect(find.text('2026-11-06'), findsOneWidget);
    await tester.tap(find.text('更早的记录')); await settleV05(tester);
    expect(h.backend.callsTo('memory.log').last['cursor'], 'next-page');
    expect(find.text('2026-11-05'), findsOneWidget);
    expect(find.byType(DropdownButtonFormField<String>), findsNothing);
    expect(find.text('撤销整批'), findsNothing);
    expect(find.byKey(const ValueKey('memory-log-entry-purge-op')), findsOneWidget);
  });

  testWidgets('v0.8 memory details edit the sentence without advanced status controls', (tester) async {
    final h = await startV05(tester);
    await h.mount(tester, Builder(builder: (context) => TextButton(onPressed: () => showMemoryDetails(context, 'm1'), child: const Text('打开详情'))));
    await tester.tap(find.text('打开详情')); await settleV05(tester);
    await tester.enterText(find.byType(TextField), '项目交流使用中文，附上验证结果。');
    await tester.testTextInput.receiveAction(TextInputAction.done); await settleV05(tester);
    expect(h.backend.callsTo('memory.update').single['version'], 2);
    expect(h.fixture.item['content'], '项目交流使用中文，附上验证结果。');
    expect(find.text('更多 ▾'), findsNothing);
    expect(find.text('恢复此版本'), findsNothing);
    await tester.tap(find.text('关闭')); await settleV05(tester);
  });

  testWidgets('v0.8 memory page does not contain the confirmation queue', (tester) async {
    final h = await startV05(tester);
    await h.mount(tester, const MemoryPage());
    expect(find.text('同意'), findsNothing);
    expect(find.text('待确认'), findsNothing);
    expect(find.text('常驻记忆块'), findsNothing);
    expect(h.backend.callsTo('memory.pending'), isEmpty);
  });

  testWidgets('3.2 unsaved claims attach by reply id, preserve editor after error, then clear on save', (tester) async {
    final h = await startV05(tester);
    final replies = h.agent.transcript.items.whereType<AssistantItem>().toList();
    await h.mount(tester, UnsavedMemoryNote(replies: replies));
    h.backend.push({...h.fixture.claim(), 'replyEntryId': 'another-reply'});
    await settleV05(tester);
    expect(find.textContaining('其实没有保存'), findsNothing);
    h.backend.push(h.fixture.claim());
    await settleV05(tester);
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    h.backend.handlers['memory.save'] = (_) => throw CoreException('bad_request', '写入被安全扫描拒绝');
    await tester.tap(find.widgetWithText(FilledButton, '保存'));
    await settleV05(tester);
    expect(find.textContaining('写入被安全扫描拒绝'), findsOneWidget);
    expect(find.widgetWithText(TextField, h.fixture.claim()['suggestion'] as String), findsOneWidget);
    h.backend.handlers['memory.save'] = (p) => h.fixture.receipt({...h.fixture.item, ...p}, 'next_task');
    await tester.tap(find.widgetWithText(FilledButton, '保存'));
    await settleV05(tester);
    final p = h.backend.callsTo('memory.save').last;
    expect(p['scope'], 'workspace');
    expect(p['cwd'], h.directory.path);
    expect(p['unsavedRef'], {'sessionId': 'parent-session', 'runId': 'run-1'});
    expect(find.text('这件事还没记下'), findsNothing);
    expect(h.agent.memoryUi.unsaved, isEmpty);
  });

  testWidgets('3.2 an old cleared event cannot dismiss a newer run', (tester) async {
    final h = await startV05(tester);
    h.backend.push({...h.fixture.claim(), 'runId': 'new-run'});
    await settleV05(tester);
    h.backend.push({...h.fixture.claim(), 'cleared': true});
    await settleV05(tester);
    expect(h.agent.memoryUi.unsaved['parent-session']?['runId'], 'new-run');
    h.backend.push({...h.fixture.claim(), 'runId': 'new-run', 'cleared': true});
    await settleV05(tester);
    expect(h.agent.memoryUi.unsaved, isEmpty);
  });

  testWidgets('3.2 pending claim routes to confirmation without creating a duplicate', (tester) async {
    final h = await startV05(tester);
    await h.mount(tester, UnsavedMemoryNote(replies: h.agent.transcript.items.whereType<AssistantItem>().toList()));
    h.backend.push({...h.fixture.claim(), 'pending': true, 'pendingIds': ['pending-1']});
    await settleV05(tester);
    await tester.tap(find.text('等你处理'));
    await tester.pumpAndSettle();
    expect(h.agent.section, AppSection.tasks);
    expect(h.backend.callsTo('memory.save'), isEmpty);
  });


  testWidgets('3.4 settings save actual values and zero memory budget is not unlimited', (tester) async {
    final h = await startV05(tester);
    await h.mount(tester, const SettingsPage(category: '记忆'));
    await tester.enterText(find.widgetWithText(TextField,'搜索设置'),'记忆详细程度');await settleV05(tester);
    await tester.tap(find.descendant(of:find.byKey(const ValueKey('settings-search')),matching:find.byType(DropdownButton<String>)).first);await settleV05(tester);
    await tester.tap(find.text('简要').last);
    await settleV05(tester);
    expect(h.backend.settings['memoryDetail'], 'brief');
    await tester.enterText(find.widgetWithText(TextField,'搜索设置'),'记忆频率');await settleV05(tester);
    await tester.tap(find.descendant(of:find.byKey(const ValueKey('settings-search')),matching:find.byType(DropdownButton<String>)).last);await settleV05(tester);
    await tester.tap(find.text('换任务或关闭时').last);
    await settleV05(tester);
    expect(h.backend.settings['memoryWriteFrequency'], 'low');
    await tester.enterText(find.widgetWithText(TextField,'搜索设置'),'每天整理预算');await settleV05(tester);
    final budget = find.byWidgetPredicate((w) => w is TextField && w.decoration?.labelText == '每天整理预算（美元）');
    await tester.enterText(budget, '0');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await settleV05(tester);
    expect(h.backend.settings['memoryDailyBudgetUsd'], 0);
  });


  testWidgets('3.6 related side opens its own messages and preserves parent-missing state', (tester) async {
    final h = await startV05(tester);
    final children = await h.backend.call('sessions.children', {'parentSession': h.agent.currentSessionPath}) as List;
    await tester.runAsync(() => h.agent.openSavedSideChat((children.first as Map).cast<String, dynamic>()));
    await settleV05(tester);
    final side = h.agent.sideChat!;
    expect(side.items.whereType<UserItem>().single.text, '这段验证需要包含哪些内容？');
    await h.mount(tester, SizedBox(height: 800, child: SideChatView(side: side)));
    expect(find.text('来源对话已删除'), findsOneWidget);
    await tester.enterText(find.byType(TextField), '继续解释');
    await tester.tap(find.byTooltip('在问一下里发送'));
    await settleV05(tester);
    expect(h.backend.pis.last.sent('prompt').last, contains('继续解释'));
    expect(h.backend.pis.last.sent('prompt').last, isNot(contains('关于主对话里的这段内容')));
  });


  testWidgets('empty and failed log loads remain distinct', (tester) async {
    final h = await startV05(tester);
    h.backend.handlers['memory.log'] = (_) => throw CoreException('offline', '后台连接中断');
    await h.mount(tester, const SingleChildScrollView(child: MemoryLog()));
    expect(find.textContaining('后台连接中断'), findsOneWidget);
    expect(find.text('最近还没有新的记录'), findsNothing);
    h.backend.handlers['memory.log'] = (_) => {'days': [], 'hasMore': false, 'cursor': null};
    await tester.tap(find.text('重试'));
    await settleV05(tester);
    expect(find.text('最近还没有新的记录'), findsOneWidget);

  });
}
