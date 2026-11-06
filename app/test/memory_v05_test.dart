import 'package:dreamflutter/ui/memory_page.dart';
import 'package:dreamflutter/ui/memory_log.dart';
import 'package:dreamflutter/ui/memory_details.dart';
import 'package:dreamflutter/ui/memory_chat_controls.dart';
import 'package:dreamflutter/ui/context_controls.dart';
import 'package:dreamflutter/ui/context_dialog.dart';
import 'package:dreamflutter/ui/settings_page.dart';
import 'package:dreamflutter/ui/side_chat_view.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'v05_harness.dart';

void main() {
  testWidgets('3.1 accepted log refinements keep compact rows and keyboard actions', (tester) async {
    final h = await startV05(tester);
    await h.mount(tester, const SingleChildScrollView(child: MemoryLog()));
    expect(find.byType(ExpansionTile), findsOneWidget);
    expect(find.text('撤销整批'), findsOneWidget);
    expect(find.textContaining('彻底删除（1项）'), findsNothing);
    expect(find.text('你 · 彻底删除了一条全局/一级·近期记忆'), findsOneWidget);
    final tile = tester.widget<ExpansionTile>(find.byType(ExpansionTile));
    expect(tile.shape, const Border());
    await tester.tap(find.byType(ExpansionTile));
    await settleV05(tester);
    final row = find.byKey(const ValueKey('memory-log-entry-o1'));
    expect(find.descendant(of: row, matching: find.text(h.fixture.item['content'] as String)), findsOneWidget);
    expect(find.descendant(of: row, matching: find.textContaining('你 · 修改')), findsNothing);
    expect(find.textContaining('后台整理 · 更新状态'), findsOneWidget);
    final size = tester.getSize(row);
    final reason = find.descendant(of: row, matching: find.text('用户纠正项目约定'));
    expect(tester.getBottomLeft(row).dy - tester.getBottomLeft(reason).dy, lessThanOrEqualTo(12));
    final undo = find.descendant(of: row, matching: find.text('撤销'));
    Focus.of(tester.element(undo)).requestFocus();
    await tester.pumpAndSettle();
    expect(tester.getSize(row), size);
    final opacity = find.ancestor(of: undo, matching: find.byType(Opacity)).first;
    expect(tester.widget<Opacity>(opacity).opacity, 1);
    await tester.tap(undo);
    await settleV05(tester);
    expect(h.backend.callsTo('memory.undo').single['opId'], 'o1');
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
  testWidgets('3.1 log pages are scoped, purge carries no content, partial undo lists conflicts', (tester) async {
    final h = await startV05(tester);
    await h.mount(tester, const SingleChildScrollView(child: MemoryLog()));
    expect(find.text('11月6日 周五'), findsOneWidget);
    await tester.tap(find.text('加载更多'));
    await settleV05(tester);
    expect(h.backend.callsTo('memory.log').last['cursor'], 'next-page');
    expect(find.text('11月5日 周四'), findsOneWidget);
    await tester.tap(find.text('撤销整批').first);
    await settleV05(tester);
    expect(find.text('部分撤销成功'), findsOneWidget);
    expect(find.textContaining('之后又改过，没有覆盖'), findsOneWidget);
    await tester.tap(find.text('关闭'));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(DropdownButtonFormField<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('当前工作区').last);
    await settleV05(tester);
    expect(h.backend.callsTo('memory.log').last, containsPair('cwd', h.directory.path));
    expect(h.backend.callsTo('memory.log').last, containsPair('scope', 'workspace'));
  });

  testWidgets('3.1 details restore with receipt, purge warns then previews whole source deletion', (tester) async {
    final h = await startV05(tester);
    await h.mount(tester, Builder(builder: (context) => TextButton(onPressed: () => showMemoryDetails(context, 'm1'), child: const Text('打开详情'))));
    await tester.tap(find.text('打开详情'));
    await settleV05(tester);
    await tester.tap(find.text('恢复此版本').last);
    await settleV05(tester);
    expect(h.backend.callsTo('memory.restore').single['version'], 1);
    expect(find.text('已恢复 · 下次调用开始使用'), findsOneWidget);
    await tester.tap(find.text('更多 ▾'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('彻底删除').last);
    await tester.pumpAndSettle();
    expect(find.textContaining('旧备份里仍有'), findsOneWidget);
    expect(h.backend.callsTo('memory.purge'), isEmpty);
    await tester.tap(find.widgetWithText(FilledButton, '彻底删除'));
    await settleV05(tester);
    expect(h.backend.callsTo('memory.purge').single['confirm'], true);
    await tester.tap(find.text('删除这个会话').first);
    await settleV05(tester);
    expect(find.textContaining('同时删除 2 条侧边对话'), findsOneWidget);
    expect(h.backend.callsTo('sessions.delete'), isEmpty);
    await tester.tap(find.widgetWithText(FilledButton, '删除'));
    await settleV05(tester);
    expect(h.backend.callsTo('sessions.delete').single['path'], '${h.directory.path}/source.jsonl');
  });

  testWidgets('3.1 promotion clearly names global scope and handles a stale rejection', (tester) async {
    final h = await startV05(tester);
    h.backend.handlers['memory.acceptPending'] = (_) => throw CoreException('conflict', '这条记忆已经有更新');
    await h.mount(tester, const MemoryPage());
    expect(find.textContaining('所有工作区都能看到'), findsOneWidget);
    await tester.tap(find.text('同意').first);
    await settleV05(tester);
    expect(find.textContaining('这条记忆已经有更新'), findsOneWidget);
    expect(find.text('同意'), findsWidgets);
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
    expect(find.text('已保存到工作区 · 下个任务开始使用'), findsOneWidget);
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
    await tester.tap(find.text('去确认'));
    await tester.pumpAndSettle();
    expect(h.agent.memoryUi.tab, 'pending');
    expect(h.agent.section, AppSection.memory);
    expect(h.backend.callsTo('memory.save'), isEmpty);
  });

  testWidgets('3.3 guessed boundary uses the user entry and corrections are explicit', (tester) async {
    final h = await startV05(tester);
    final user = h.agent.transcript.items.whereType<UserItem>().single;
    await h.mount(tester, Column(children: [MemoryBoundaryNote(item: user), const SessionMemoryActions()]));
    h.backend.push({'event': 'memory.task', 'sessionId': 'parent-session', 'kind': 'guessed', 'taskId': 'task-guessed', 'previousTaskId': 'previous'});
    await settleV05(tester);
    expect(find.text('识别为新任务'), findsOneWidget);
    await tester.tap(find.text('改为继续上一个'));
    await settleV05(tester);
    expect(h.backend.callsTo('memory.continueTask').single['sessionId'], 'parent-session');
    expect(find.text('识别为新任务'), findsNothing);
    await tester.tap(find.text('下一条作为新任务'));
    await settleV05(tester);
    expect(find.text('下一条消息开始一个新任务'), findsOneWidget);
    await tester.tap(find.byType(DropdownButtonFormField<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('只读').last);
    await settleV05(tester);
    expect(h.backend.callsTo('memory.setSessionMode').single['mode'], 'readonly');
  });

  testWidgets('3.4 settings save actual values and zero memory budget is not unlimited', (tester) async {
    final h = await startV05(tester);
    await h.mount(tester, const SettingsPage(category: '记忆'));
    expect(find.text('关闭时自动生效，所有改动记在日志里，可撤销'), findsOneWidget);
    expect(find.textContaining('0 = 不运行后台记忆任务'), findsOneWidget);
    await tester.tap(find.text('简要'));
    await settleV05(tester);
    expect(h.backend.settings['memoryDetail'], 'brief');
    await tester.tap(find.text('换任务或关闭对话时'));
    await settleV05(tester);
    expect(h.backend.settings['memoryWriteFrequency'], 'low');
    final budget = find.byWidgetPredicate((w) => w is TextField && w.decoration?.labelText == '后台每日预算（美元）');
    await tester.enterText(budget, '0');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await settleV05(tester);
    expect(h.backend.settings['memoryDailyBudgetUsd'], 0);
  });

  testWidgets('3.5 context reports arbitrary checkpoints but regenerates only latest with source receipt', (tester) async {
    final h = await startV05(tester);
    await h.mount(tester, const SingleChildScrollView(child: ContextControls()));
    expect(find.text('快满时自动压缩（本会话）'), findsNothing);
    expect(find.text('自动压缩：开（全局设置）'), findsOneWidget);
    expect(find.text('重新生成'), findsOneWidget);
    await tester.tap(find.text('查看原文').last);
    await settleV05(tester);
    expect(find.textContaining('保留失败原因，不把未验证写成通过'), findsOneWidget);
    await tester.tap(find.text('关闭'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('报告有误').last);
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, '遗漏了失败条件');
    await tester.tap(find.text('提交'));
    await settleV05(tester);
    expect(h.backend.callsTo('context.report').single['entryId'], 'c1');
    await tester.tap(find.text('重新生成'));
    await settleV05(tester);
    expect(h.backend.callsTo('context.regenerate').single['entryId'], 'c2');
    expect(find.text('已在旧摘要上修订'), findsOneWidget);
    await tester.tap(find.text('跟随默认').first);
    await settleV05(tester);
    expect(h.backend.callsTo('context.setSession').last, containsPair('thresholdPercent', null));
  });

  testWidgets('3.6 related side opens its own messages and preserves parent-missing state', (tester) async {
    final h = await startV05(tester);
    await h.mount(tester, const SessionMemoryActions());
    await tester.tap(find.text('相关对话 (2)'));
    await settleV05(tester);
    expect(find.text('侧边'), findsOneWidget);
    expect(find.text('分叉'), findsOneWidget);
    await tester.tap(find.text('验证细节'));
    await settleV05(tester);
    final side = h.agent.sideChat!;
    expect(side.items.whereType<UserItem>().single.text, '这段验证需要包含哪些内容？');
    await h.mount(tester, SizedBox(height: 800, child: SideChatView(side: side)));
    expect(find.text('来源对话已删除'), findsOneWidget);
    await tester.enterText(find.byType(TextField), '继续解释');
    await tester.tap(find.byTooltip('在侧边对话里发送'));
    await settleV05(tester);
    expect(h.backend.pis.last.sent('prompt').last, contains('继续解释'));
    expect(h.backend.pis.last.sent('prompt').last, isNot(contains('关于主对话里的这段内容')));
  });

  testWidgets('3.7 notices route to exact item or log without waking the agent', (tester) async {
    final h = await startV05(tester);
    await h.mount(tester, const MemoryLiveNotices());
    for (final kind in ['capacity_full', 'expired_protected', 'blocked', 'summary_revived']) {
      h.backend.push({'event': kind == 'blocked' || kind == 'summary_revived' ? 'memory.warning' : 'memory.notice', 'kind': kind, 'itemIds': ['m1'], 'tokens': 40100, 'capacity': 40000});
    }
    await settleV05(tester);
    expect(find.text('查看'), findsNWidgets(4));
    await tester.tap(find.text('查看').first);
    await tester.pumpAndSettle();
    expect(h.agent.memoryUi.itemId, 'm1');
    expect(h.backend.pis.first.sent('prompt'), isEmpty);
    await tester.tap(find.text('重新生成'));
    await settleV05(tester);
    expect(h.backend.callsTo('context.regenerate').single['entryId'], 'c2');
    expect(find.text('已在旧摘要上修订'), findsOneWidget);
  });

  testWidgets('empty and failed log loads remain distinct, context controls fit a narrow scaled dialog', (tester) async {
    final h = await startV05(tester);
    h.backend.handlers['memory.log'] = (_) => throw CoreException('offline', '后台连接中断');
    await h.mount(tester, const SingleChildScrollView(child: MemoryLog()));
    expect(find.textContaining('后台连接中断'), findsOneWidget);
    expect(find.text('还没有记忆日志'), findsNothing);
    h.backend.handlers['memory.log'] = (_) => {'days': [], 'hasMore': false, 'cursor': null};
    await tester.tap(find.text('重试'));
    await settleV05(tester);
    expect(find.text('还没有记忆日志'), findsOneWidget);
    await tester.binding.setSurfaceSize(const Size(800, 900));
    await h.mount(tester, Builder(builder: (context) => TextButton(onPressed: () => showContextDialog(context), child: const Text('上下文'))), textScale: 1.5);
    await tester.tap(find.text('上下文'));
    await settleV05(tester);
    expect(tester.takeException(), isNull);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.text('压缩记录'), findsNothing);
  });
}
