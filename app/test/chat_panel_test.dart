import 'dart:io';

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/ui/composer.dart' show MentionChip;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';

void main() {

  group('panel and input box', () {
    late FakeBackend backend;
    late AgentController agent;
    late Directory sessions;

    Future<void> startApp(WidgetTester tester) async {
      await tester.binding.setSurfaceSize(const Size(1400, 900));
      SharedPreferences.setMockInitialValues({'workspace': Directory.systemTemp.path, 'onboarded': true});
      sessions = Directory.systemTemp.createTempSync('df_panel_');
      backend = FakeBackend()..butterflyHome = '${sessions.path}${Platform.pathSeparator}butterfly';
      backend.handlers['sandbox.status'] = (_) => {'state': 'ready', 'online': true};
      backend.handlers['desk.get'] = (_) => {
        'notes': [
          {'id': 'n1', 'title': '发布清单', 'content': '- 改价格'},
        ],
        'materials': [
          {'id': 'm1', 'kind': 'file', 'title': '去年数据.xlsx', 'path': r'C:\work\去年数据.xlsx'},
        ],
      };
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

    Finder input() => find.byWidgetPredicate((w) => w is TextField && w.decoration?.hintText == '说点什么…');

    testWidgets('a task mention goes along with the next workbench message', (tester) async {
      await startApp(tester);
      expect(find.text('写笺'), findsNothing, reason: 'the workbench has no desk any more');
      expect(find.text('去年数据.xlsx'), findsNothing, reason: '蝶君 cannot open this machine\'s paths');
      await tester.enterText(input(), '@发布');
      await settle(tester);
      await tester.tap(find.text('发布清单'));
      await settle(tester);
      expect(find.widgetWithText(MentionChip, '发布清单'), findsOneWidget);

      await tester.enterText(input(), '按这个准备材料');
      await tester.pump();
      await tester.tap(find.byTooltip('发送'));
      await settle(tester);
      final pi = backend.pis.single;
      expect(agent.active?.slotId, pi.slotId);
      final prompt = pi.commands.lastWhere((c) => c['type'] == 'prompt')['message'] as String;
      expect(prompt, startsWith('按这个准备材料'));
      expect(prompt, contains('<写笺 标题="发布清单">\n- 改价格\n</写笺>'));
      expect(find.byType(MentionChip), findsNothing, reason: 'sent, so the chips are gone');
    });

    testWidgets('typing @ suggests desk notes and materials', (tester) async {
      await startApp(tester);
      await tester.enterText(input(), '看看 @发布');
      await settle(tester);
      expect(find.text('发布清单'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await settle(tester);
      expect(find.widgetWithText(MentionChip, '发布清单'), findsOneWidget);
      expect(tester.widget<TextField>(input()).controller!.text, '看看 ', reason: 'the @word is replaced by the chip');
    });

    testWidgets('the details panel has changes without the old branch and actions blocks', (tester) async {
      await startApp(tester);
      final pi = backend.pis.single;
      pi.extraResponses['df_tree'] = {
        'nodes': [
          {'entryId': 'q1', 'parentId': null, 'text': '第一个问题', 'timestamp': '1', 'active': true, 'target': 'l1'},
          {'entryId': 'q2', 'parentId': 'q1', 'text': '原来的写法', 'timestamp': '2', 'active': false, 'target': 'leaf-old'},
          {'entryId': 'q2b', 'parentId': 'q1', 'text': '改过的写法', 'timestamp': '3', 'active': true, 'target': 'leaf-new'},
        ],
      };
      await tester.tap(find.byTooltip(RegExp('^详情')));
      await settle(tester);
      expect(find.text('本次改动'), findsOneWidget);
      expect(find.text('分支'), findsNothing);
      expect(find.text('常用操作'), findsNothing);
      expect(find.text('相关对话'), findsNothing);
      expect(pi.sent('df_navigate_tree'), isEmpty);
    });
  });
}
