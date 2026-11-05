// Everyday scenarios in a real window, with the real fonts, against the fake
// backend (no model, no sandbox): reading and copying a conversation while it
// grows, at every common zoom, in the workbench and in 蝶君; dropped files
// reaching only the page on screen; every page, settings category and theme
// opening without an error. The checklist this belongs to is
// docs/testing/scenarios.md.
//   flutter test integration_test/scenarios_test.dart -d windows

import 'dart:io';

import 'package:desktop_drop/desktop_drop.dart';
import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/sidebar.dart' show Sidebar;
import 'package:dreamflutter/ui/butterfly_page.dart';
import 'package:dreamflutter/ui/chat_view.dart';
import 'package:dreamflutter/ui/keys.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../test/fake_backend.dart';
import '../test/fake_pi.dart';

/// A 1×1 PNG.
const _png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  // Keys are pressed through the test, not on the real keyboard.
  HeldKeys.askWindows = false;

  late FakeBackend backend;
  late AgentController agent;
  late Directory sessions;
  var ts = 10;
  String? copied;

  Future<void> settle(WidgetTester tester) async {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pumpAndSettle();
  }

  Future<void> startApp(WidgetTester tester) async {
    sessions = Directory.systemTemp.createTempSync('df_scenarios_');
    SharedPreferences.setMockInitialValues({'workspace': sessions.path, 'onboarded': true});
    backend = FakeBackend()..butterflyHome = p.join(sessions.path, 'butterfly');
    backend.handlers.addAll({
      'sandbox.status': (_) => {'state': 'ready', 'online': true, 'bundled': true},
      'desk.get': (_) => {'notes': const [], 'materials': const [], 'tasks': const [], 'artifacts': const []},
      'butterfly.outbox': (_) => const [],
      'inbox.list': (_) => const [],
      'tasks.list': (_) => const [],
      'artifacts.list': (_) => const [],
      'schedules.list': (_) => const [],
      'memory.list': (_) => const [],
      'memory.blocks': (_) => const [],
      'skills.list': (_) => const [],
      'templates.list': (_) => const [],
      'proposals.list': (_) => const [],
    });
    agent = AgentController(
      preferences: await Preferences.load(),
      sessionStore: SessionStore(sessionsDir: sessions.path),
      backend: backend,
    );
    addTearDown(() {
      agent.dispose();
      sessions.deleteSync(recursive: true);
    });
    copied = null;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') copied = (call.arguments as Map)['text'] as String?;
      return null;
    });
    await tester.pumpWidget(DreamFlutterApp(controller: agent, ownTitleBar: true));
    await tester.runAsync(agent.init);
    await settle(tester);
  }

  /// A place in the window's sidebar: 工作台, 蝶君 and 任务 by name, the rest by the foot icons' tooltips (0.4).
  Finder nav(String label) => const {'工作台', '蝶君', '任务'}.contains(label)
      ? find.descendant(of: find.byType(Sidebar), matching: find.text(label)).first
      : find.byTooltip(RegExp('^$label')).first;

  void reply(FakePi pi, String text) {
    final message = {
      'role': 'assistant',
      'content': [
        {'type': 'text', 'text': text},
      ],
      'stopReason': 'stop',
      'timestamp': ts++,
    };
    pi.emit({'type': 'message_start', 'message': message});
    pi.emit({'type': 'message_end', 'message': message});
  }

  Future<void> earlierAnswers(WidgetTester tester, FakePi pi, int count) async {
    for (var i = 0; i < count; i++) {
      pi.startRun('第 $i 个问题');
      reply(pi, List.filled(8, '第 $i 段回答里的一行字，长一点好占地方，让对话能滚动起来。').join('\n\n'));
      pi.finishRun();
      await settle(tester);
    }
  }

  Future<Future<void> Function(String)> streamReply(WidgetTester tester, FakePi pi, {List<Json> images = const []}) async {
    pi.streaming = true;
    pi.emit({'type': 'agent_start'});
    final question = {
      'role': 'user',
      'content': [
        {'type': 'text', 'text': '看看这张图\n\n[Image: original 1350x817, displayed at 1350x817. Multiply coordinates by 1.00 to map to original image.]'},
        ...images,
      ],
      'timestamp': ts++,
    };
    pi.emit({'type': 'message_start', 'message': question});
    pi.emit({'type': 'message_end', 'message': question});
    pi.emit({
      'type': 'message_start',
      'message': {'role': 'assistant', 'content': <Object>[], 'timestamp': ts++},
    });
    pi.emit({
      'type': 'message_update',
      'assistantMessageEvent': {'type': 'text_start', 'contentIndex': 0},
    });
    return (text) async {
      pi.emit({
        'type': 'message_update',
        'assistantMessageEvent': {'type': 'text_delta', 'contentIndex': 0, 'delta': text},
      });
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 2)));
      await tester.pump(const Duration(milliseconds: 16));
    };
  }

  Finder messageList() => find.descendant(of: find.byType(SelectionArea), matching: find.byType(ListView));
  ScrollPosition listPosition(WidgetTester tester) => tester.state<ScrollableState>(find.descendant(of: messageList(), matching: find.byType(Scrollable)).first).position;

  /// Drags across the paragraph starting with [word] and copies with Ctrl+C.
  Future<String?> dragCopy(WidgetTester tester, String word) async {
    copied = null;
    final box = tester.getRect(find.textContaining(word, findRichText: true).last);
    final gesture = await tester.startGesture(box.centerLeft + const Offset(1, 0), kind: PointerDeviceKind.mouse);
    await tester.pump();
    await gesture.moveTo(box.center);
    await tester.pump();
    await gesture.moveTo(box.centerRight - const Offset(1, 0));
    await tester.pump();
    await gesture.up();
    await tester.pumpAndSettle();
    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyC);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pumpAndSettle();
    return copied;
  }

  testWidgets('reading while a reply streams: the wheel, the 回到底部 button, steady pictures', (tester) async {
    await startApp(tester);
    final pi = backend.pis.single;
    await earlierAnswers(tester, pi, 5);
    final delta = await streamReply(tester, pi, images: [
      {'type': 'image', 'data': _png, 'mimeType': 'image/png'},
    ]);
    await delta('回答开始。');
    // The note Pi adds for the model is not shown to the person.
    expect(find.textContaining('Multiply coordinates'), findsNothing);
    expect(find.text('看看这张图'), findsOneWidget);
    // The picture is the same image every frame (a new one each token flickered).
    ImageProvider picture() => tester.widget<Image>(find.descendant(of: messageList(), matching: find.byType(Image)).first).image;
    final first = picture();

    final position = listPosition(tester);
    await tester.sendEventToBinding(PointerScrollEvent(position: tester.getCenter(messageList()), scrollDelta: const Offset(0, -50)));
    final reading = position.pixels;
    for (var f = 0; f < 40; f++) {
      await delta('第 $f 个词，还有更多。');
    }
    expect(position.pixels, moreOrLessEquals(reading, epsilon: 0.5), reason: 'one wheel notch up stays up while the reply grows');
    expect(identical(picture(), first) || picture() == first, isTrue);

    await tester.tap(find.byTooltip('回到底部，并跟着新内容'));
    await tester.pump();
    for (var f = 0; f < 10; f++) {
      await delta('又一句。');
    }
    expect(position.maxScrollExtent - position.pixels, lessThan(0.5), reason: 'the button follows the end again');
    pi.finishRun();
    await settle(tester);
  });

  testWidgets('a drag copies the paragraph under the mouse at every common zoom, in the workbench and in 蝶君', (tester) async {
    await startApp(tester);
    final pi = backend.pis.single;
    await earlierAnswers(tester, pi, 4);
    pi.startRun('最后一问');
    reply(pi, '甲段：第一段的文字在这里。\n\n乙段：第二段的文字。\n\n丙段：第三段的文字。');
    pi.finishRun();
    await settle(tester);

    // 蝶君's conversation, with the same reply.
    await tester.tap(nav('蝶君'));
    await settle(tester);
    agent.butterflyTab.value = ButterflyTab.talk;
    await settle(tester);
    final butterflyPi = backend.pis.last;
    expect(butterflyPi, isNot(same(pi)));
    await earlierAnswers(tester, butterflyPi, 4);
    butterflyPi.startRun('最后一问');
    reply(butterflyPi, '子段：第一段的文字在这里。\n\n丑段：第二段的文字。\n\n寅段：第三段的文字。');
    butterflyPi.finishRun();
    await settle(tester);

    for (final zoom in [1.0, 1.1, 1.25, 1.5]) {
      while (agent.zoom != zoom) {
        agent.stepZoom(agent.zoom < zoom ? 1 : -1);
      }
      await tester.tap(nav('工作台'));
      await settle(tester);
      expect(await dragCopy(tester, '甲段'), startsWith('甲段：第一段的文字在这里'), reason: 'workbench at $zoom');
      expect(copied, isNot(contains('乙段')));
      await tester.tap(nav('蝶君'));
      await settle(tester);
      expect(await dragCopy(tester, '子段'), startsWith('子段：第一段的文字在这里'), reason: '蝶君 at $zoom');
      expect(copied, isNot(contains('丑段')));
    }
  });

  testWidgets('dropped files reach only the page on screen', (tester) async {
    await startApp(tester);
    bool takes(Finder page) => tester.widgetList<DropTarget>(find.descendant(of: page, matching: find.byType(DropTarget, skipOffstage: false), skipOffstage: false)).any((d) => d.enable);
    final workbench = find.byType(ChatView, skipOffstage: false).first;
    final butterfly = find.byType(ButterflyPage, skipOffstage: false);
    await tester.tap(nav('蝶君'));
    await settle(tester);
    for (final tab in ButterflyTab.values) {
      agent.butterflyTab.value = tab;
      await settle(tester);
      expect(takes(butterfly), isTrue, reason: '蝶君 › $tab');
      expect(takes(workbench), isFalse, reason: 'the workbench behind 蝶君 › $tab');
    }
    await tester.tap(nav('工作台'));
    await settle(tester);
    expect(takes(workbench), isTrue);
    expect(takes(butterfly), isFalse);
  });

  testWidgets('every page, settings category and theme opens without an error', (tester) async {
    await startApp(tester);
    final pages = {
      '任务': ['待处理', '全部任务', '定时'],
      '记忆': ['记忆库', '待确认', '常驻记忆块'],
      '技能': ['技能', '任务模板', '待确认'],
    };
    for (final MapEntry(key: page, value: tabs) in pages.entries) {
      await tester.tap(nav(page));
      await settle(tester);
      for (final tab in tabs) {
        await tester.tap(find.text(tab).last);
        await settle(tester);
      }
    }
    await tester.tap(nav('蝶君'));
    await settle(tester);
    for (final tab in ButterflyTab.values) {
      agent.butterflyTab.value = tab;
      await settle(tester);
    }

    await tester.tap(nav('仪表盘'));
    await settle(tester);
    await tester.pageBack();
    await settle(tester);

    await tester.tap(nav('外观'));
    await settle(tester);
    await tester.tap(find.text('完成'));
    await settle(tester);

    await tester.tap(nav('设置'));
    await settle(tester);
    for (final category in ['通用', '外观', '模型与网关', '对话', '记忆', '安全与审批', '运行上限', '蝶君沙箱', '工具与 MCP', '数据与迁移', '关于']) {
      await tester.tap(find.text(category).first);
      await settle(tester);
    }
    await tester.pageBack();
    await settle(tester);

    // Each painting theme on the workbench with a conversation, and on 蝶君.
    final pi = backend.pis.first;
    await tester.tap(nav('工作台'));
    await settle(tester);
    await earlierAnswers(tester, pi, 1);
    for (final theme in PaintingTheme.all) {
      agent.setThemeMode(theme.brightness == Brightness.dark ? ThemeMode.dark : ThemeMode.light);
      agent.setPaintingTheme(theme);
      await settle(tester);
      await tester.tap(nav('蝶君'));
      await settle(tester);
      await tester.tap(nav('工作台'));
      await settle(tester);
    }
    expect(pi, isNotNull);
  });

  testWidgets('the input box: Shift+Enter is a new line, Enter sends', (tester) async {
    await startApp(tester);
    final pi = backend.pis.single;
    final input = find.byWidgetPredicate((w) => w is TextField && (w.decoration?.hintText ?? '').contains('Enter 发送'));
    await tester.tap(input);
    await tester.enterText(input, '第一行');
    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    await tester.pump();
    expect(pi.commands.where((c) => c['type'] == 'prompt'), isEmpty, reason: 'Shift+Enter does not send');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await settle(tester);
    expect(pi.commands.where((c) => c['type'] == 'prompt'), hasLength(1));
  });
}
