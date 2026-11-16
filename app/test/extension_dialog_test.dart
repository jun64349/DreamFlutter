import 'dart:io';

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';
import 'fake_pi.dart';

void main() {
  late FakeBackend backend;
  late List<FakePi> pis;
  late AgentController agent;
  late Directory sessions;

  Future<void> startApp(WidgetTester tester, {bool withApprovalHistory = false, bool withConversation = false}) async {
    await tester.binding.setSurfaceSize(const Size(1280, 800));
    SharedPreferences.setMockInitialValues({'workspace': Directory.systemTemp.path});
    sessions = Directory.systemTemp.createTempSync('df_dialog_');
    backend = FakeBackend();
    pis = backend.pis;
    agent = AgentController(
      preferences: await tester.runAsync(Preferences.load) as Preferences,
      sessionStore: SessionStore(sessionsDir: sessions.path),
      backend: backend,
    );
    if (withApprovalHistory) {
      backend.handlers['confirm.list'] = (_) => [
        {
          'id': 'old-approval', 'slotId': agent.active?.slotId, 'sessionFile': agent.active?.sessionPath,
          'status': 'answered', 'answer': {'value': '允许'},
          'request': {'type': 'extension_ui_request', 'id': 'old-approval', 'method': 'select',
            'title': 'Agent 请求执行操作\n\n执行命令：\nhistory-command', 'options': ['允许', '拒绝']},
        },
        {
          'id': 'other-approval', 'slotId': 'another-slot', 'sessionFile': 'another-session',
          'status': 'answered', 'answer': {'value': '允许'},
          'request': {'type': 'extension_ui_request', 'id': 'other-approval', 'method': 'select',
            'title': 'Agent 请求执行操作\n\n其他对话\nother-command', 'options': ['允许', '拒绝']},
        },
      ];
    }
    await tester.pumpWidget(DreamFlutterApp(controller: agent));
    await tester.runAsync(agent.init);
    await tester.pumpAndSettle();
    if (withConversation) {
      pis.single.messages = [
        {'role': 'user', 'timestamp': 1, 'content': '请检查并整理报告'},
        {'role': 'assistant', 'timestamp': 2, 'stopReason': 'stop', 'content': [{'type': 'text', 'text': '我先检查工作区。'}]},
      ];
      await tester.runAsync(agent.active!.refreshHistory);
      await tester.pumpAndSettle();
    }
  }

  Future<void> requestApproval(WidgetTester tester, {String id = 'ui-1', String command = 'rm -rf build'}) async {
    await tester.runAsync(() async {
      pis.single.emit({
        'type': 'extension_ui_request',
        'id': id,
        'method': 'select',
        'title': 'Agent 请求执行操作\n\n执行命令：\n$command',
        'options': ['允许', '本会话内总是允许「bash」', '在此工作区总是允许「bash」', '拒绝'],
      });
      await Future<void>.delayed(const Duration(milliseconds: 50));
    });
    await tester.pumpAndSettle();
  }

  tearDown(() {
    agent.dispose();
    sessions.deleteSync(recursive: true);
  });

  testWidgets('answering an approval closes only the dialog', (tester) async {
    await startApp(tester);
    await requestApproval(tester);
    expect(find.text('执行命令：'), findsOneWidget);
    expect(find.byType(AlertDialog), findsNothing);
    expect(find.text('rm -rf build'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, '允许'));
    await tester.pumpAndSettle();

    expect(find.text('Agent 请求执行操作'), findsNothing);
    expect(find.text('新对话'), findsWidgets, reason: 'the main page must still be there');
    expect(pis.single.commands.last, {'type': 'extension_ui_response', 'id': 'ui-1', 'value': '允许'});
    expect(find.text('rm -rf build'), findsNothing, reason: 'an empty conversation returns to the home view');
  });

  testWidgets('an answered approval in a conversation folds and can be reopened', (tester) async {
    await startApp(tester, withConversation: true);
    await requestApproval(tester);
    expect(find.text('rm -rf build'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, '允许'));
    await tester.pumpAndSettle();
    expect(pis.single.commands.last, {'type': 'extension_ui_response', 'id': 'ui-1', 'value': '允许'});
    expect(find.text('rm -rf build'), findsNothing, reason: 'answered details are folded immediately');
    expect(find.text('已处理 1 项审批'), findsOneWidget);
    await tester.tap(find.text('已处理 1 项审批'));
    await tester.pumpAndSettle();
    expect(find.text('rm -rf build'), findsOneWidget);
    expect(find.text('已允许'), findsOneWidget);
  });

  testWidgets('a rejected approval folds and remains readable after the run', (tester) async {
    await startApp(tester, withConversation: true);
    await requestApproval(tester);
    await tester.tap(find.widgetWithText(OutlinedButton, '拒绝'));
    await tester.pumpAndSettle();
    expect(pis.single.commands.last['value'], '拒绝');
    expect(find.text('rm -rf build'), findsNothing);
    pis.single.finishRun();
    await tester.pumpAndSettle();
    expect(find.text('rm -rf build'), findsNothing);
    await tester.tap(find.text('已处理 1 项审批'));
    await tester.pumpAndSettle();
    expect(find.text('rm -rf build'), findsOneWidget);
    expect(find.text('已拒绝'), findsOneWidget);
  });

  testWidgets('answered history starts folded and remains scoped to its conversation', (tester) async {
    await startApp(tester, withApprovalHistory: true, withConversation: true);
    await tester.pumpAndSettle();
    expect(find.text('已处理 1 项审批'), findsOneWidget);
    expect(find.text('history-command'), findsNothing);
    await tester.tap(find.text('已处理 1 项审批'));
    await tester.pumpAndSettle();
    expect(find.text('history-command'), findsOneWidget);
    expect(find.text('other-command'), findsNothing);
    expect(find.widgetWithText(FilledButton, '允许'), findsNothing);
  });

  testWidgets('two approvals share one folded history after completion', (tester) async {
    await startApp(tester, withConversation: true);
    await requestApproval(tester, id: 'first', command: 'first-command');
    await tester.tap(find.widgetWithText(FilledButton, '允许'));
    await tester.pumpAndSettle();
    await requestApproval(tester, id: 'second', command: 'second-command');
    await tester.tap(find.widgetWithText(OutlinedButton, '拒绝'));
    await tester.pumpAndSettle();
    expect(find.text('已处理 2 项审批'), findsOneWidget);
    expect(find.text('first-command'), findsNothing);
    expect(find.text('second-command'), findsNothing);
    pis.single.finishRun();
    await tester.pumpAndSettle();
    expect(find.text('已处理 2 项审批'), findsOneWidget);
    expect(find.text('first-command'), findsNothing);
    expect(find.text('second-command'), findsNothing);
    await tester.tap(find.text('已处理 2 项审批'));
    await tester.pumpAndSettle();
    expect(find.text('first-command'), findsOneWidget);
    expect(find.text('second-command'), findsOneWidget);
    expect(find.text('已允许'), findsOneWidget);
    expect(find.text('已拒绝'), findsOneWidget);
    final responses = pis.single.commands.where((c) => c['type'] == 'extension_ui_response').toList();
    expect(responses.map((c) => [c['id'], c['value']]).toList(), [['first', '允许'], ['second', '拒绝']]);
  });

  testWidgets('a dialog whose run ended closes by itself', (tester) async {
    await startApp(tester);
    await requestApproval(tester);
    await tester.runAsync(() async {
      pis.single.finishRun();
      await Future<void>.delayed(const Duration(milliseconds: 50));
    });
    await tester.pumpAndSettle();

    expect(find.text('Agent 请求执行操作'), findsNothing);
    expect(find.text('新对话'), findsWidgets);
  });

  testWidgets('only conversation-wide permission is offered and sent back exactly', (tester) async {
    await startApp(tester);
    await requestApproval(tester);
    expect(find.text('在此工作区总是允许「bash」'), findsNothing);
    await tester.tap(find.widgetWithText(TextButton, '这个对话里都允许这类操作'));
    await tester.pumpAndSettle();
    expect(pis.single.commands.last['value'], '本会话内总是允许「bash」');
  });

  testWidgets('the trust prompt from the core gets the trust layout', (tester) async {
    await startApp(tester);
    await tester.runAsync(() async {
      pis.single.emit({
        'type': 'extension_ui_request',
        'id': 'trust-1',
        'method': 'select',
        'title': '信任此工作区？\n\nD:\\work\\proj\n\n这个工作区包含 Pi 项目配置。',
        'options': ['仅这次信任', '信任并记住', '这次不信任', '不信任并记住'],
      });
      await Future<void>.delayed(const Duration(milliseconds: 50));
    });
    await tester.pumpAndSettle();
    expect(find.text('信任这个工作区的配置吗？'), findsOneWidget);
    expect(find.text('D:\\work\\proj'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, '信任并记住'));
    await tester.pumpAndSettle();
    expect(pis.single.commands.last, {'type': 'extension_ui_response', 'id': 'trust-1', 'value': '信任并记住'});
  });
}
