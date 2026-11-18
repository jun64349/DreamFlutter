import 'dart:io';

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/onboarding.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/ui/onboarding_tour.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';

/// 「入门 5 课」(route step 4): the follow-along lessons over the real window.
void main() {
  late FakeBackend backend;
  late AgentController agent;

  Future<void> open(WidgetTester tester, {Map<String, Object> prefs = const {}}) async {
    await tester.binding.setSurfaceSize(const Size(1400, 900));
    SharedPreferences.setMockInitialValues({'workspace': Directory.systemTemp.path, 'onboarded': true, ...prefs});
    final sessions = Directory.systemTemp.createTempSync('df_tour_');
    backend = FakeBackend();
    agent = AgentController(
      preferences: await tester.runAsync(Preferences.load) as Preferences,
      sessionStore: SessionStore(sessionsDir: sessions.path),
      backend: backend,
    );
    addTearDown(() {
      agent.dispose();
      sessions.deleteSync(recursive: true);
    });
    await tester.pumpWidget(DreamFlutterApp(controller: agent));
    await tester.runAsync(agent.init);
    await tester.pumpAndSettle();
  }

  // The layer follows its lit place every 250 ms while a lesson shows; settle with plain pumps.
  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 6; i++) {
      await tester.pump(const Duration(milliseconds: 300));
    }
  }

  testWidgets('the sidebar card starts lesson 1 and its read-only steps move on with 看懂了', (tester) async {
    await open(tester);
    expect(find.text('入门 5 课 · 0 / 5'), findsOneWidget);
    expect(find.text('约 45 分钟学会'), findsOneWidget);
    await tester.tap(find.text('开始 ›'));
    await settle(tester);
    expect(find.textContaining('第 1 课 · 1 / 3'), findsOneWidget);
    await tester.tap(find.text('看懂了'));
    await settle(tester);
    expect(find.textContaining('第 1 课 · 2 / 3'), findsOneWidget);
    await tester.tap(find.text('看懂了'));
    await settle(tester);
    await tester.tap(find.text('下一课'));
    await settle(tester);
    expect(find.textContaining('第 2 课 · 1 / 5'), findsOneWidget);
    expect(find.text('入门 5 课 · 1 / 5'), findsOneWidget);
    final saved = agent.preferences.tour;
    expect((saved.lesson, saved.step), (1, 0));
  });

  testWidgets('a step with a lit place dims the rest: only the lit place works, doing it moves on', (tester) async {
    await open(tester, prefs: {'tour.lesson': 1, 'tour.step': 1});
    await tester.tap(find.text('继续 ›'));
    await settle(tester);
    expect(find.textContaining('第 2 课 · 2 / 5'), findsOneWidget);
    // 「等你处理」is outside the hole: the shade swallows the click.
    await tester.tap(find.text('等你处理').first, warnIfMissed: false);
    await settle(tester);
    expect(agent.section, AppSection.chat);
    expect(find.textContaining('第 2 课 · 2 / 5'), findsOneWidget);
    await tester.tap(find.byTooltip(RegExp('^设置')));
    await settle(tester);
    expect(agent.section, AppSection.settings);
    expect(find.textContaining('第 2 课 · 3 / 5'), findsOneWidget);
  });

  testWidgets('after 模型 is chosen the add-channel button is the lit place, and opening it moves on', (tester) async {
    await open(tester, prefs: {'tour.lesson': 1, 'tour.step': 2});
    agent.showSection(AppSection.settings);
    await tester.tap(find.text('继续 ›'));
    await settle(tester);
    expect(find.textContaining('第 2 课 · 3 / 5'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('settings-nav-模型')));
    await settle(tester);
    await tester.tap(find.text('添加渠道').first);
    await settle(tester);
    expect(find.textContaining('第 2 课 · 4 / 5'), findsOneWidget);
  });

  testWidgets('lesson 2 is skipped when the setup wizard already connected a model', (tester) async {
    await open(tester, prefs: {'tour.lesson': 1});
    agent.gatewayChannels = [...agent.gatewayChannels, _channel()];
    await tester.tap(find.text('继续 ›'));
    await settle(tester);
    expect(find.textContaining('第 3 课 · 1 / 5'), findsOneWidget);
  });

  testWidgets('moments the app reports finish their steps (copying a reply)', (tester) async {
    await open(tester, prefs: {'tour.lesson': 2, 'tour.step': 3});
    await tester.tap(find.text('继续 ›'));
    await settle(tester);
    expect(find.textContaining('第 3 课 · 4 / 5'), findsOneWidget);
    agent.tourSignal('approved');
    await settle(tester);
    expect(find.textContaining('第 3 课 · 4 / 5'), findsOneWidget, reason: 'another step\'s moment does nothing');
    agent.tourSignal('copied');
    await settle(tester);
    expect(find.textContaining('第 3 课 · 5 / 5'), findsOneWidget);
  });

  testWidgets('先退出 hides the lesson and keeps the place; 不用了 removes the card for good', (tester) async {
    await open(tester, prefs: {'tour.lesson': 2, 'tour.step': 4});
    await tester.tap(find.text('继续 ›'));
    await settle(tester);
    await tester.tap(find.text('先退出'));
    await settle(tester);
    expect(find.textContaining('第 3 课 ·'), findsNothing);
    expect(find.text('入门 5 课 · 2 / 5'), findsOneWidget);
    expect(find.text('第 3 课：第一次对话'), findsOneWidget);

    agent.tour.lesson = 0;
    agent.tour.step = 0;
    agent.tour.leave();
    await settle(tester);
    await tester.tap(find.text('不用了'));
    await settle(tester);
    expect(find.textContaining('入门 5 课'), findsNothing);
    expect(agent.preferences.tour.closed, isTrue);
  });

  testWidgets('做完再看 finishes the course; the next acceptance clears the wait', (tester) async {
    await open(tester, prefs: {'tour.lesson': 4, 'tour.step': 4});
    await tester.tap(find.text('继续 ›'));
    await settle(tester);
    expect(find.textContaining('第 5 课 · 5 / 5'), findsOneWidget);
    await tester.tap(find.text('做完再看'));
    await settle(tester);
    expect(find.textContaining('入门 5 课'), findsNothing);
    expect(agent.tour.waitingForReport, isTrue);
    agent.tourSignal('accepted');
    expect(agent.tour.waitingForReport, isFalse);
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    expect(agent.preferences.tour.waitingForReport, isFalse);
  });

  testWidgets('帮我填好 puts the lesson\'s words into the composer', (tester) async {
    await open(tester, prefs: {'tour.lesson': 2, 'tour.step': 1});
    await tester.tap(find.text('继续 ›'));
    await settle(tester);
    await tester.tap(find.text('帮我填好'));
    await settle(tester);
    expect(find.textContaining(leavePrompt), findsWidgets);
  });

  testWidgets('the practice folder gets its five files, and keeps ones already there', (tester) async {
    final root = Directory.systemTemp.createTempSync('df_practice_');
    addTearDown(() => root.deleteSync(recursive: true));
    File('${root.path}/练习/读书笔记.md')
      ..createSync(recursive: true)
      ..writeAsStringSync('mine');
    final folder = await tester.runAsync(() => preparePracticeFolder(dataRoot: root.path)) as String;
    for (final name in practiceFiles) {
      expect(File('$folder/$name').lengthSync(), greaterThan(0), reason: name);
    }
    expect(File('$folder/读书笔记.md').readAsStringSync(), 'mine');
  });
}

GatewayChannel _channel() => GatewayChannel.fromJson({
  'id': 'c1',
  'platform': 'deepseek',
  'name': 'DeepSeek',
  'enabled': true,
  'models': <Object?>[],
});
