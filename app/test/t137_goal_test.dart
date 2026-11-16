import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dreamflutter/state/goal_conversation.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/composer.dart';
import 'package:dreamflutter/ui/goal_widgets.dart';
import 'package:dreamflutter/ui/message_widgets.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 't87_fixture.dart';
import 'v012_fixture.dart';

void main() {
  testWidgets('persisted proactive marker and process images remain visible outside folded work', (t) async {
    final f = (await t.runAsync(T87Fixture.create))!;
    addTearDown(() async { await t.pumpWidget(const SizedBox()); await t.runAsync(f.dispose); });
    final transcript = Transcript()..loadHistory([
      AgentMessage.fromJson({'role': 'assistant', 'timestamp': DateTime.now().millisecondsSinceEpoch, 'dfProactiveRef': 'proactive-fixture', 'content': [
        {'type': 'text', 'text': '图已生成'}, {'type': 'toolCall', 'id': 'plot', 'name': 'bash', 'arguments': {'command': 'python scripts/plot.py'}},
      ]}),
      AgentMessage.fromJson({'role': 'toolResult', 'toolCallId': 'plot', 'toolName': 'bash', 'isError': false, 'details': {'path': 'price.png'}, 'content': [
        {'type': 'image', 'mimeType': 'image/png', 'data': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII='},
      ]}),
    ]);
    expect(transcript.items.whereType<AssistantItem>().single.proactiveRef, 'proactive-fixture');
    await t.pumpWidget(AgentScope(controller: f.agent, child: MaterialApp(theme: buildTheme(Brightness.light), home: Scaffold(body: SingleChildScrollView(child: ChatRowView(row: ChatRow.fromItems(transcript.items).single, transcript: transcript))))));
    await t.pump();
    expect(find.textContaining(' · 蝶君来找你'), findsOneWidget);
    expect(find.text('price.png · python scripts/plot.py'), findsOneWidget);
    expect(find.byWidgetPredicate((w) => w is Image && w.image is MemoryImage), findsOneWidget);
    await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 40)));
    await t.pump();
  });
  testWidgets('recorded plan is collapsed until clicked and keeps completed and active steps', (t) async {
    final f = (await t.runAsync(T87Fixture.create))!;
    addTearDown(() async { await t.pumpWidget(const SizedBox()); await t.runAsync(f.dispose); });
    final api = V012Fixtures(f.backend, sessionFile: f.agent.currentSessionPath!, slotId: f.agent.active!.slotId!);
    for (final event in api.events('slot.record')) {
      final record = event['record'];
      if (record is Map && record['type'] == 'df_agent_state') f.backend.pis.firstWhere((pi) => pi.slotId == f.agent.active!.slotId).emit(record.cast<String, dynamic>());
    }
    await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 40)));
    await t.pump();
    await t.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: Scaffold(body: GoalPlan(plan: f.agent.todos))));
    expect(find.text('计划 2/5 · 正在：整理成对比表'), findsOneWidget);
    expect(find.text('读三款的规格书'), findsNothing);
    await t.tap(find.text('计划 2/5 · 正在：整理成对比表')); await t.pump();
    expect(find.text('读三款的规格书'), findsOneWidget);
    expect(t.widget<Text>(find.text('读三款的规格书')).style!.decoration, TextDecoration.lineThrough);
    expect(t.widget<Text>(find.text('整理成对比表')).style!.fontWeight, FontWeight.w600); // 原型 .planlist .c
    await t.tap(find.text('计划 2/5')); await t.pump();
    expect(find.text('读三款的规格书'), findsNothing);
  });
  testWidgets('plan and composer keep the same centered edges at every window width', (t) async {
    final f = (await t.runAsync(T87Fixture.create))!;
    addTearDown(() async { await t.pumpWidget(const SizedBox()); await t.runAsync(f.dispose); });
    for (final width in [1600.0, 1000.0, 760.0]) {
      await t.binding.setSurfaceSize(Size(width, 900));
      await t.pumpWidget(AgentScope(controller: f.agent, child: MaterialApp(theme: buildTheme(Brightness.light), home: Scaffold(body: GoalPlanBox(
        plan: const [
          {'content': '读三款的规格书', 'status': 'completed'},
          {'content': '整理成对比表', 'status': 'in_progress'},
        ],
        composer: const Composer(contained: true),
      )))));
      await t.pump(const Duration(milliseconds: 160));
      final header = find.byKey(const ValueKey('plan-header'));
      final composer = find.byKey(const ValueKey('composer-body'));
      expect(t.getSize(header).width, width > AppTokens.contentMaxWidth + 48 ? AppTokens.contentMaxWidth : width - 48);
      expect(t.getRect(header).left, t.getRect(composer).left);
      expect(t.getRect(header).right, t.getRect(composer).right);
      if (find.byKey(const ValueKey('plan-list')).evaluate().isEmpty) await t.tap(find.byKey(const ValueKey('plan-header')));
      await t.pump(const Duration(milliseconds: 300));
      final list = find.byKey(const ValueKey('plan-list'));
      expect(t.getRect(list).left, t.getRect(composer).left);
      expect(t.getRect(list).right, t.getRect(composer).right);
      expect(t.takeException(), isNull);
    }
  });
  testWidgets('goal controls, job output, proposals and push refresh use wire fixtures', (t) async {
    final f = (await t.runAsync(T87Fixture.create))!;
    final api = V012Fixtures(f.backend, sessionFile: f.agent.currentSessionPath!, slotId: f.agent.active!.slotId!)..goals();
    final state = GoalConversation(f.agent);
    await state.refresh();
    addTearDown(() async { await t.pumpWidget(const SizedBox()); state.dispose(); await t.runAsync(f.dispose); });
    await t.binding.setSurfaceSize(const Size(1000, 1000));
    await t.pumpWidget(AgentScope(controller: f.agent, child: MaterialApp(theme: buildTheme(Brightness.light), home: Scaffold(body: GoalScope(model: state, child: const SingleChildScrollView(child: Column(children: [ConversationGoalSections(), GoalProposals(), GoalQuestions()])))))));
    await t.pump();
    final id = state.goal!['id'];
    await t.tap(find.text('暂停')); await t.pump(); // 原型右栏按钮「暂停 / 停止」
    expect(f.backend.callsTo('goals.control').last, {'id': id, 'action': 'pause'});
    api.use('goals.get', 'goals.control.pause');
    for (final e in api.events('goals.changed')) { f.backend.push(e); }
    await t.pump(); await t.pump();
    expect(find.text('继续'), findsOneWidget);
    await t.tap(find.text('继续')); await t.pump();
    expect(f.backend.callsTo('goals.control').last, {'id': id, 'action': 'resume'});
    await t.tap(find.text('停止')); await t.pump();
    expect(f.backend.callsTo('goals.control').last, {'id': id, 'action': 'cancel'});
    await t.tap(find.byTooltip('更多')); await t.pump();
    expect(find.text('停下所有目标（蝶君和工作台）和后台任务，正在发的请求会取消。已经写好的文件不会删。'), findsOneWidget);
    await t.tap(find.text('算了')); await t.pump();
    expect(find.text('全部停下'), findsNothing);
    await t.tap(find.byTooltip('更多')); await t.pump();
    await t.tap(find.text('全部停下')); await t.pump(); await t.pump();
    expect(f.backend.callsTo('goals.control').last, {'action': 'emergency'}, reason: 'documented global emergency stop, no id');
    expect(find.text('全部停下'), findsNothing);
    await t.tap(find.byTooltip('查看输出').first); await t.pump();
    final job = state.jobs.first['id'];
    expect(f.backend.callsTo('jobs.output').last, {'id': job, 'from': 0});
    expect(find.textContaining('已核对 12 篇文献'), findsOneWidget);
    await t.tap(find.byTooltip('停止后台任务').first); await t.pump();
    expect(f.backend.callsTo('jobs.stop').last, {'id': job});
    api.use('jobs.list', 'jobs.list.ended');
    for (final e in api.events('jobs.changed')) { f.backend.push(e); }
    await t.pump(); await t.pump();
    expect(find.byTooltip('停止后台任务'), findsNothing);
    await t.ensureVisible(find.text('不用').first); await t.tap(find.text('不用').first); await t.pump();
    expect(f.backend.callsTo('goals.proposals.resolve').last, {'id': state.proposals.first['id'], 'action': 'reject'});
    api.use('goals.proposals.resolve', 'goals.proposals.resolve.accept');
    await t.ensureVisible(find.text('设为目标').last); await t.tap(find.text('设为目标').last); await t.pump();
    expect(f.backend.callsTo('goals.proposals.resolve').last['action'], 'accept');
    await t.pumpWidget(const SizedBox()); state.dispose();
  });
  testWidgets('question choices and skip send exact values, answers collapse', (t) async {
    final f = (await t.runAsync(T87Fixture.create))!;
    final api = V012Fixtures(f.backend, sessionFile: f.agent.currentSessionPath!, slotId: f.agent.active!.slotId!)..goals();
    final state = GoalConversation(f.agent); await state.refresh();
    addTearDown(() async { await t.pumpWidget(const SizedBox()); state.dispose(); await t.runAsync(f.dispose); });
    await t.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: Scaffold(body: GoalScope(model: state, child: const GoalQuestions()))));
    final id = state.questions.first['id'];
    await t.tap(find.text('先不算')); await t.pump();
    expect(f.backend.callsTo('confirm.answer').last, {'id': id, 'response': {'value': '先不算（推荐）'}});
    await t.tap(find.text('跳过')); await t.pump();
    expect(f.backend.callsTo('confirm.answer').last, {'id': id, 'response': {'value': '跳过这个问题'}});
    api.use('confirm.list', 'confirm.list.answered');
    f.backend.push({'event': 'confirm.changed'}); await t.pump(); await t.pump();
    expect(find.text('你选了「先不算」'), findsOneWidget);
    expect(find.text('跳过'), findsNothing);
    await t.pumpWidget(const SizedBox()); state.dispose();
  });
  testWidgets('custom answer follows select with input, schedule notice exposes navigation', (t) async {
    final f = (await t.runAsync(T87Fixture.create))!;
    final api = V012Fixtures(f.backend, sessionFile: f.agent.currentSessionPath!, slotId: f.agent.active!.slotId!)..goals()..use('schedules.get');
    final state = GoalConversation(f.agent); await state.refresh();
    addTearDown(() async { await t.pumpWidget(const SizedBox()); state.dispose(); await t.runAsync(f.dispose); });
    await t.pumpWidget(AgentScope(controller: f.agent, child: MaterialApp(theme: buildTheme(Brightness.light), home: Scaffold(body: GoalScope(model: state, child: const Column(children: [GoalQuestions(), GoalScheduleNotice(id: 'schedule-fixture', created: true)]))))));
    await t.pump();
    final id = state.questions.first['id'];
    await t.enterText(find.byType(TextField), '运费按 80 元算');
    api.use('confirm.list', 'confirm.list.custom');
    await t.testTextInput.receiveAction(TextInputAction.done); await t.pump(); await t.pump();
    expect(f.backend.callsTo('confirm.answer').first, {'id': id, 'response': {'value': '自己回答…'}});
    expect(f.backend.callsTo('confirm.answer').last['response'], {'value': '运费按 80 元算'});
    expect(f.backend.callsTo('schedules.get').single, {'id': 'schedule-fixture'});
    expect(find.text('建了日程「整理组会记录」'), findsOneWidget);
    await t.tap(find.text('看日程')); expect(scheduleNavigationRequest.value, 'schedule-fixture');
    scheduleNavigationRequest.value = null;
    await t.pumpWidget(const SizedBox()); state.dispose();
  });
}
