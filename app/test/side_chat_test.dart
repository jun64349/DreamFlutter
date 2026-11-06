import 'dart:io';

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/state/side_chat.dart';
import 'package:dreamflutter/ui/side_chat_view.dart';
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
    expect(side.target.incognito, isTrue);
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

  testWidgets('a 无痕 conversation has nothing to fork', (tester) async {
    await startApp(tester);
    await tester.runAsync(agent.newTemporarySession);
    await settle(tester);
    expect(agent.canOpenSideChat, isFalse);
  });
}
