import 'dart:io';

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/ui/home_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';

void main() {
  late FakeBackend backend;
  late AgentController agent;
  late Directory sessions;

  Future<void> startApp(WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(1400, 900));
    SharedPreferences.setMockInitialValues({'workspace': Directory.systemTemp.path});
    sessions = Directory.systemTemp.createTempSync('df_chat_');
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

  testWidgets('a finished reply offers copy, regenerate and fork', (tester) async {
    await startApp(tester);
    final pi = backend.pis.single..startRun('问题');
    final reply = {
      'role': 'assistant',
      'content': [
        {'type': 'text', 'text': '**答案**是 42'},
      ],
      'stopReason': 'stop',
      'timestamp': 2,
    };
    pi
      ..emit({'type': 'message_start', 'message': reply})
      ..emit({'type': 'message_end', 'message': reply})
      ..finishRun();
    await settle(tester);

    String? copied;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') copied = (call.arguments as Map)['text'] as String?;
      return null;
    });
    // The latest reply shows its actions without hovering.
    await tester.tap(find.byTooltip('复制回复（Markdown 原文）'));
    await tester.pump();
    expect(copied, '**答案**是 42');
    expect(find.byTooltip('重新生成（原来的回复会保留，可以切换回去）').evaluate().isNotEmpty || find.byTooltip('这条回复对应的问题已被压缩，无法重新生成').evaluate().isNotEmpty, isTrue);

    await tester.tap(find.byTooltip('从这里分叉：新开一个会话，保留到这条回复为止的内容'));
    await settle(tester);
    expect(pi.sent('clone'), hasLength(1));
  });

  testWidgets('Ctrl + plus / minus / 0 zoom the whole window', (tester) async {
    await startApp(tester);
    Size layoutSize() => MediaQuery.sizeOf(tester.element(find.byType(HomePage)));
    final base = layoutSize();

    Future<void> ctrl(LogicalKeyboardKey key) async {
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(key);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      await settle(tester);
    }

    await ctrl(LogicalKeyboardKey.equal);
    expect(agent.zoom, 1.1);
    expect(layoutSize().width, closeTo(base.width / 1.1, 0.01), reason: 'laid out smaller, painted larger');
    expect(find.text('缩放 110%'), findsOneWidget);

    await ctrl(LogicalKeyboardKey.minus);
    await ctrl(LogicalKeyboardKey.minus);
    expect(agent.zoom, 0.9);
    await ctrl(LogicalKeyboardKey.digit0);
    expect(agent.zoom, 1.0);
    expect(layoutSize(), base);
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('the rail opens the appearance controls', (tester) async {
    await startApp(tester);
    await tester.tap(find.bySemanticsLabel('外观'));
    await tester.pumpAndSettle();
    expect(find.text('界面缩放'), findsOneWidget);
    await tester.tap(find.byTooltip('放大（Ctrl + +）'));
    await settle(tester);
    expect(agent.zoom, 1.1);
    await tester.tap(find.text('小'));
    await settle(tester);
    expect(agent.textScale, 0.9);
    await tester.pump(const Duration(seconds: 2));
  });
}
