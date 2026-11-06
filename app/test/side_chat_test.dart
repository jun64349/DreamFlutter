import 'dart:io';

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/state/side_chat.dart';
import 'package:dreamflutter/ui/side_chat_view.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/zoom.dart';
import 'package:dreamflutter/ui/extension_dialogs.dart';
import 'package:dreamflutter/theme.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';
import 'fake_pi.dart';

/// 0.4 (roadmap 4.7): selected text in a reply can be quoted in the reply, or
/// asked about in a side conversation that neither interrupts nor adds to the main one.
void main() {
  late FakeBackend backend;
  late AgentController agent;
  late Directory sessions;

  Future<void> startApp(WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(1400, 900));
    SharedPreferences.setMockInitialValues({'workspace': Directory.systemTemp.path, 'onboarded': true});
    sessions = Directory.systemTemp.createTempSync('df_side_');
    backend = FakeBackend();
    agent = AgentController(
      preferences: await tester.runAsync(Preferences.load) as Preferences,
      sessionStore: SessionStore(sessionsDir: sessions.path),
      backend: backend,
    );
    await tester.pumpWidget(DreamFlutterApp(controller: agent));
    await tester.runAsync(agent.init);
    await tester.pumpAndSettle();
  }

  Future<void> settle(WidgetTester tester) async {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pumpAndSettle();
  }

  tearDown(() {
    agent.dispose();
    sessions.deleteSync(recursive: true);
  });

  void reply(FakePi pi, String question, String answer) {
    pi.startRun(question);
    final message = {
      'role': 'assistant',
      'content': [
        {'type': 'text', 'text': answer},
      ],
      'stopReason': 'stop',
      'timestamp': 2,
    };
    pi
      ..emit({'type': 'message_start', 'message': message})
      ..emit({'type': 'message_end', 'message': message})
      ..finishRun();
  }

  Finder input() => find.byWidgetPredicate((w) => w is TextField && (w.decoration?.hintText ?? '').contains('Enter 发送，'));

  Finder sideInput() => find.byWidgetPredicate((w) => w is TextField && (w.decoration?.hintText ?? '').startsWith('问问这段内容'));
  Json approval(String id, String tool) => {
    'type': 'extension_ui_request', 'id': id, 'method': 'select',
    'title': 'Agent 请求执行操作\n\n执行工具：\n$tool',
    'options': ['允许', '本会话内总是允许「$tool」', '在此工作区总是允许「$tool」', '拒绝'],
  };
  List<Json> answers(FakePi pi) => pi.commands.where((c) => c['type'] == 'extension_ui_response').toList();

  testWidgets('side approval on first send stays in panel across persistence and routes to its slot', (tester) async {
    await startApp(tester);
    final main = backend.pis.single;
    backend.onLaunch = (pi) {
      pi.extraResponses['get_state'] = {'sessionFile': null};
      pi.onCommand = (command) {
        if (command['type'] != 'prompt') return;
        // The core swaps its in-memory runtime before acknowledging first send;
        // the owning slot/connection remains the same.
        pi.emit(approval('same-id', 'tool_search'));
        pi.extraResponses.remove('get_state');
        pi.emit({'type': 'session_info_changed'});
      };
    };
    await tester.runAsync(() => agent.openSideChat('结论是 A'));
    await settle(tester);
    final side = backend.pis.last;
    final runtime = agent.sideChat!.runtime;
    expect(runtime.sessionPath, isNull);
    await tester.enterText(sideInput(), '请查工具');
    await tester.tap(find.byTooltip('在侧边对话里发送'));
    await settle(tester);
    expect(runtime.sessionPath, side.sessionFile);
    expect(runtime.slotId, side.slotId);
    expect(runtime.pendingDialogs.single.id, 'same-id');
    final card = find.descendant(of: find.byType(SideChatView), matching: find.byType(AlertDialog));
    expect(card, findsOneWidget);
    expect(find.byType(AlertDialog), findsOneWidget, reason: 'no main modal for a side request');
    expect(tester.getBottomLeft(find.byType(SideExtensionDialog)).dy, lessThanOrEqualTo(tester.getTopLeft(sideInput()).dy));

    // A same-id close event from another slot must not dismiss this card.
    backend.push({'event': 'confirm.changed', 'confirmation': {'id': 'same-id', 'slotId': main.slotId, 'status': 'answered'}});
    await settle(tester);
    expect(runtime.pendingDialogs, hasLength(1));
    main.emit(approval('same-id', 'main-tool'));
    await settle(tester);
    expect(find.descendant(of: find.byType(SideChatView), matching: find.text('main-tool')), findsNothing);
    final mainCard = find.byWidgetPredicate((w) => w is AlertDialog).last;
    await tester.tap(find.descendant(of: mainCard, matching: find.widgetWithText(OutlinedButton, '拒绝')));
    await settle(tester);
    expect(answers(main).single['value'], '拒绝');
    expect(answers(side), isEmpty);
    expect(runtime.pendingDialogs, hasLength(1));
    final allow = find.descendant(of: card, matching: find.widgetWithText(FilledButton, '允许'));
    await tester.ensureVisible(allow);
    await tester.pumpAndSettle();
    await tester.tap(allow);
    await settle(tester);
    expect(answers(side), [{'type': 'extension_ui_response', 'id': 'same-id', 'value': '允许'}]);
    expect(runtime.pendingDialogs, isEmpty);
    expect(find.byType(SideChatView), findsOneWidget, reason: 'answer must not pop a route');
  });

  testWidgets('reopened side has only fresh approvals and clears the owning slot request', (tester) async {
    await startApp(tester);
    await tester.runAsync(() => agent.openSideChat('旧引用'));
    final old = backend.pis.last;
    old.emit(approval('old-request', 'old-tool'));
    await settle(tester);
    agent.closeSideChat();
    await settle(tester);
    expect(answers(old).single['value'], '拒绝');
    backend.onLaunch = (pi) {
      pi.sessionId = 'saved-side';
      pi.extraResponses['get_tree'] = {'leafId': 'boundary', 'tree': [
        {'entry': {'id': 'boundary', 'parentId': null, 'type': 'custom', 'customType': 'df.inheritedHistory', 'data': {'sessionId': 'saved-side'}}, 'children': <Json>[]},
      ]};
    };
    await tester.runAsync(() => agent.openSavedSideChat({'path': old.sessionFile, 'quote': '旧引用'}));
    await settle(tester);
    final reopened = backend.pis.last;
    expect(reopened.slotId, isNot(old.slotId));
    expect(agent.sideChat!.runtime.pendingDialogs, isEmpty);
    expect(find.text('old-tool'), findsNothing);
    reopened.emit(approval('fresh-request', 'fresh-tool'));
    await settle(tester);
    final card = find.descendant(of: find.byType(SideChatView), matching: find.byType(AlertDialog));
    expect(card, findsOneWidget);
    final allow = find.descendant(of: card, matching: find.widgetWithText(FilledButton, '允许'));
    await tester.ensureVisible(allow);
    await tester.pumpAndSettle();
    await tester.tap(allow);
    await settle(tester);
    expect(answers(reopened).single['id'], 'fresh-request');
    expect(answers(old), hasLength(1));
    reopened.emit(approval('timeout-request', 'timed-tool'));
    await settle(tester);
    backend.push({'event': 'confirm.changed', 'confirmation': {'id': 'timeout-request', 'slotId': reopened.slotId, 'status': 'expired'}});
    await settle(tester);
    expect(find.text('timed-tool'), findsNothing);
    expect(agent.sideChat!.runtime.pendingDialogs, isEmpty);
    expect(answers(reopened), hasLength(1), reason: 'do not answer a request the core already closed');
  });

  for (final closePanel in [false, true]) {
  testWidgets('closing ${closePanel ? 'details panel' : 'side chat'} rejects every unanswered request before closing its slot', (tester) async {
    await startApp(tester);
    await tester.runAsync(() => agent.openSideChat('关闭测试'));
    final side = backend.pis.last;
    final runtime = agent.sideChat!.runtime;
    side.emit(approval('close-1', 'tool-one'));
    side.emit(approval('close-2', 'tool-two'));
    await settle(tester);
    expect(runtime.pendingDialogs, hasLength(2));
    final responsesAtClose = <Json>[];
    side.onCommand = (command) {
      if (command['type'] == 'extension_ui_response') {
        expect(backend.callsTo('slot.close'), isEmpty, reason: 'deny before closing the slot');
        responsesAtClose.add(command);
      }
    };
    if (closePanel) {
      await tester.runAsync(() => agent.setRunPanelOpen(false));
    } else {
      await tester.tap(find.widgetWithText(TextButton, '结束'));
    }
    await settle(tester);
    expect(responsesAtClose.map((r) => r['id']), ['close-1', 'close-2']);
    expect(responsesAtClose.every((r) => r['value'] == '拒绝'), isTrue);
    expect(runtime.pendingDialogs, isEmpty);
    expect(runtime.isDisposed, isTrue);
    expect(backend.callsTo('slot.close').single['slotId'], side.slotId);
    expect(answers(backend.pis.first), isEmpty);
    agent.closeSideChat();
    expect(answers(side), hasLength(2), reason: 'closing twice cannot answer twice');
  });
  }

  testWidgets('side approval card fits the minimum panel width at 150% in both themes', (tester) async {
    await startApp(tester);
    await tester.runAsync(() => agent.openSideChat('窄面板'));
    backend.pis.last.emit(approval('narrow', 'tool_search'));
    await settle(tester);
    await tester.binding.setSurfaceSize(const Size(420, 750));
    for (final brightness in [Brightness.light, Brightness.dark]) {
      await tester.pumpWidget(AgentScope(controller: agent, child: MaterialApp(
        theme: buildTheme(brightness),
        home: AppZoom(controller: agent, zoom: 1.5, textScale: 1, child: Scaffold(body: SideChatView(side: agent.sideChat!))),
      )));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      final allow = find.widgetWithText(FilledButton, '允许');
      await tester.ensureVisible(allow);
      await tester.pumpAndSettle();
      expect(allow.hitTestable(), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, '拒绝').hitTestable(), findsOneWidget);
      expect(tester.getBottomLeft(find.byType(SideExtensionDialog)).dy, lessThanOrEqualTo(tester.getTopLeft(sideInput()).dy));
    }
    await tester.tap(find.widgetWithText(FilledButton, '允许'));
    await tester.pumpAndSettle();
    expect(answers(backend.pis.last).single['value'], '允许');
  });

  testWidgets('side run settlement rejects pending approval without restoring it in the next run', (tester) async {
    await startApp(tester);
    await tester.runAsync(() => agent.openSideChat('结束测试'));
    final side = backend.pis.last;
    side.emit(approval('settled', 'tool-one'));
    await settle(tester);
    side.finishRun();
    await settle(tester);
    expect(answers(side).single, {'type': 'extension_ui_response', 'id': 'settled', 'value': '拒绝'});
    expect(agent.sideChat!.runtime.pendingDialogs, isEmpty);
    expect(find.byType(AlertDialog), findsNothing);
    side.emit(approval('next', 'tool-two'));
    await settle(tester);
    expect(find.text('tool-two'), findsOneWidget);
  });

  testWidgets('dragging over a reply floats 回复 and 侧边对话; 回复 quotes it after what is typed', (tester) async {
    await startApp(tester);
    reply(backend.pis.single, '问题', '第一段：结论是 A。');
    await settle(tester);
    await tester.enterText(input(), '我想问');
    await tester.pump();

    final words = find.textContaining('结论是 A', findRichText: true).first;
    final box = tester.getRect(words);
    final mouse = await tester.startGesture(box.centerLeft + const Offset(2, 0), kind: PointerDeviceKind.mouse);
    await tester.pump();
    await mouse.moveTo(box.centerRight - const Offset(2, 0));
    await tester.pump();
    await mouse.up();
    await tester.pumpAndSettle();
    expect(find.widgetWithText(TextButton, '回复'), findsOneWidget);
    expect(find.widgetWithText(TextButton, '侧边对话'), findsOneWidget);

    await tester.tap(find.widgetWithText(TextButton, '回复'));
    await tester.pumpAndSettle();
    final typed = tester.widget<TextField>(input()).controller!.text;
    expect(typed, startsWith('我想问\n\n> '), reason: 'the quote goes after what was typed');
    expect(typed, contains('结论是 A'));
    expect(find.widgetWithText(TextButton, '侧边对话'), findsNothing, reason: 'the box goes away');
  });

  testWidgets('a side conversation forks the session in memory, answers in the details, and brings its answer back', (tester) async {
    await startApp(tester);
    final main = backend.pis.single;
    reply(main, '问题', '结论是 A。');
    await settle(tester);
    final mainPrompts = main.sent('prompt').length;

    await tester.runAsync(() => agent.openSideChat('结论是 A'));
    await settle(tester);
    final side = backend.pis.last;
    expect(side, isNot(same(main)));
    expect(side.target.incognito, isFalse);
    expect(side.target.sideQuote, '结论是 A');
    expect(side.target.forkOf, agent.active!.sessionPath, reason: 'a copy of this session so far');
    expect(find.byType(SideChatView), findsOneWidget, reason: 'the details open on the side conversation');
    expect(find.text('结论是 A'), findsWidgets);

    await tester.enterText(find.byWidgetPredicate((w) => w is TextField && (w.decoration?.hintText ?? '').startsWith('问问这段内容')), 'A 是什么意思');
    await tester.tap(find.byTooltip('在侧边对话里发送'));
    await settle(tester);
    final asked = side.commands.lastWhere((c) => c['type'] == 'prompt')['message'] as String;
    expect(asked, '${SideChat.lead}\n> 结论是 A\n\nA 是什么意思');
    expect(main.sent('prompt').length, mainPrompts, reason: 'the main conversation is not asked anything');

    reply(side, asked, 'A 指的是第一种方案。');
    await settle(tester);
    expect(find.text('A 是什么意思'), findsOneWidget, reason: 'the question without the quoted passage');
    expect(find.textContaining('第一种方案', findRichText: true), findsWidgets);

    await tester.tap(find.text('带回主对话'));
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(input()).controller!.text, '侧边对话的结论：\n> A 指的是第一种方案。\n\n');

    await tester.tap(find.text('结束'));
    await settle(tester);
    expect(agent.sideChat, isNull);
    expect(backend.callsTo('slot.close').map((c) => c['slotId']), [side.slotId], reason: 'its session in the core closes too (e2e 1b)');
    expect(find.byType(SideChatView), findsNothing);
  });

  testWidgets('a failed first send retains input and quote for retry without resetting the side view', (tester) async {
    await startApp(tester);
    reply(backend.pis.single, '问题', '结论是 A。');
    await settle(tester);
    await tester.runAsync(() => agent.openSideChat('结论是 A'));
    await settle(tester);
    final side = backend.pis.last;
    final baseline = agent.sideChat!.baseline;
    side.failures['prompt'] = '保存失败';
    final field = find.byWidgetPredicate((w) => w is TextField && (w.decoration?.hintText ?? '').startsWith('问问这段内容'));
    await tester.enterText(field, '保留这个问题');
    await tester.tap(find.byTooltip('在侧边对话里发送'));
    await settle(tester);
    expect(tester.widget<TextField>(field).controller!.text, '保留这个问题');
    expect(agent.sideChat!.baseline, baseline);
    final failed = side.commands.lastWhere((c) => c['type'] == 'prompt')['message'];
    side.failures.clear();
    await tester.tap(find.byTooltip('在侧边对话里发送'));
    await settle(tester);
    expect(side.commands.lastWhere((c) => c['type'] == 'prompt')['message'], failed);
    expect(tester.widget<TextField>(field).controller!.text, isEmpty);
    expect(find.byType(SideChatView), findsOneWidget);
  });

  testWidgets('a 无痕 conversation opens a private side through its live parent slot', (tester) async {
    await startApp(tester);
    await tester.runAsync(agent.newTemporarySession);
    await settle(tester);
    expect(agent.canOpenSideChat, isTrue);
    final parent = agent.active!.slotId;
    await tester.runAsync(() => agent.openSideChat('临时讨论'));
    await settle(tester);
    expect(backend.pis.last.target.parentSlotId, parent);
    expect(backend.pis.last.target.incognito, isTrue);
    expect(backend.pis.last.target.forkOf, isNull);
    expect(find.text('不保存'), findsOneWidget);
  });
}
