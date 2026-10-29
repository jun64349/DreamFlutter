import 'dart:io';

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';

void main() {
  late FakeBackend backend;
  late AgentController agent;
  late Directory sessions;

  var notes = <Json>[];
  var inbox = <Json>[];

  Future<void> startApp(WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(1500, 1000));
    SharedPreferences.setMockInitialValues({'workspace': Directory.systemTemp.path});
    sessions = Directory.systemTemp.createTempSync('df_work_');
    backend = FakeBackend();
    notes = [];
    inbox = [
      {
        'kind': 'approval',
        'id': 'ui-9',
        'title': 'Agent 请求执行操作\n\n执行命令：\nnpm publish',
        'createdAt': 1,
        'cwd': Directory.systemTemp.path,
        'data': {
          'method': 'select',
          'options': ['允许', '拒绝'],
        },
      },
      {'kind': 'limit', 'id': 'n1', 'title': '已达到单次运行的最大轮数（60 轮）', 'body': '任务已暂停。', 'createdAt': 2},
      {'kind': 'memory', 'id': 'm1', 'title': '用户喜欢表格', 'createdAt': 3},
    ];
    backend.handlers.addAll({
      'desk.get': (_) => {
        'notes': notes,
        'materials': [
          {'id': 'r1', 'kind': 'text', 'title': '去年数据', 'content': '收入 100 万'},
        ],
        'tasks': [
          {'id': 't1', 'title': '整理周报', 'goal': '整理周报', 'cwd': Directory.systemTemp.path, 'source': 'note', 'status': 'done', 'noteId': 'w1', 'runs': 1, 'durationMs': 65000},
        ],
        'artifacts': [
          {'id': 'a1', 'path': r'C:\work\report.md', 'taskId': 't1', 'exists': false},
        ],
      },
      'notes.save': (p) {
        final note = {'id': 'w1', 'cwd': p['cwd'], 'title': (p['title'] as String?)?.isNotEmpty == true ? p['title'] : '未命名写笺', 'content': p['content'] ?? ''};
        notes = [note];
        return note;
      },
      'tasks.list': (p) => p['noteId'] != null ? const [] : const [],
      'artifacts.list': (_) => const [],
      'tasks.create': (p) => {
        'task': {'id': 't2', 'title': p['title'], 'goal': p['goal'], 'cwd': p['cwd'], 'source': p['source'], 'status': 'waiting'},
        'prompt': '${p['goal']}\n<写笺>…</写笺>',
      },
      'inbox.list': (_) => inbox,
      'confirm.answer': (p) {
        inbox = inbox.where((i) => i['id'] != p['id']).toList();
        return {'ok': true};
      },
      'notices.resolve': (p) {
        inbox = inbox.where((i) => i['id'] != p['id']).toList();
        return {'slotId': null};
      },
    });
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

  testWidgets('a note handed to the agent becomes a bound task running in the chat', (tester) async {
    await startApp(tester);
    await tester.tap(find.text('书桌'));
    await settle(tester);
    expect(find.text('去年数据'), findsOneWidget);
    expect(find.text('整理周报'), findsOneWidget);
    expect(find.text('report.md'), findsOneWidget);

    await tester.tap(find.byTooltip('新写笺'));
    await settle(tester);
    expect(find.text('交给 Agent'), findsOneWidget);
    await tester.enterText(find.byWidgetPredicate((w) => w is TextField && w.decoration?.hintText?.startsWith('用 Markdown') == true), '季度复盘：收入增长 12%');
    await tester.pump(const Duration(seconds: 1));
    await settle(tester);
    expect(backend.callsTo('notes.save').last['content'], '季度复盘：收入增长 12%');

    await tester.tap(find.text('交给 Agent'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('写成报告'));
    await tester.tap(find.byType(Checkbox));
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, '开始'));
    await settle(tester);

    final created = backend.callsTo('tasks.create').single;
    expect(created['source'], 'note');
    expect(created['noteId'], 'w1');
    expect(created['materialIds'], ['r1']);
    expect(created['goal'], contains('报告'));
    expect(backend.callsTo('tasks.bind').single, {'taskId': 't2', 'slotId': backend.pis.single.slotId});
    expect(agent.section, AppSection.chat);
    expect(backend.pis.single.sent('prompt').single, contains('<写笺>'));
  });

  testWidgets('the inbox answers approvals and limit cards', (tester) async {
    await startApp(tester);
    await settle(tester);
    expect(agent.pendingInbox, 2, reason: 'memory candidates have their own badge');
    await tester.tap(find.text('任务'));
    await settle(tester);
    expect(find.textContaining('npm publish'), findsOneWidget);
    expect(find.text('已达到单次运行的最大轮数（60 轮）'), findsOneWidget);
    expect(find.text('去「记忆」确认'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, '允许'));
    await settle(tester);
    expect(backend.callsTo('confirm.answer').single, {
      'id': 'ui-9',
      'response': {'value': '允许'},
    });
    expect(find.textContaining('npm publish'), findsNothing);

    await tester.tap(find.widgetWithText(FilledButton, '继续'));
    await settle(tester);
    expect(backend.callsTo('notices.resolve').single, {'id': 'n1', 'action': 'continue'});
    expect(agent.pendingInbox, 0);

    await tester.tap(find.text('去「记忆」确认'));
    await settle(tester);
    expect(agent.section, AppSection.memory);
  });

  testWidgets('schedules: create with the editor, approve a proposal, run now', (tester) async {
    await startApp(tester);
    var schedules = <Json>[
      {'id': 's1', 'name': '每天天气', 'prompt': '查天气', 'cwd': Directory.systemTemp.path, 'kind': 'report', 'trigger': {'type': 'cron', 'cron': '0 8 * * *'}, 'status': 'pending_approval', 'describe': '按日历：0 8 * * *', 'createdBy': 'agent'},
      {'id': 's2', 'name': '看新闻', 'prompt': '看新闻', 'cwd': Directory.systemTemp.path, 'kind': 'task', 'trigger': {'type': 'interval', 'everyMs': 3600000}, 'status': 'active', 'describe': '每 1 小时', 'nextRunAt': 1},
    ];
    backend.handlers.addAll({
      'schedules.list': (_) => schedules,
      'schedules.defaults': (_) => {'timezone': 'Asia/Shanghai'},
      'schedules.preview': (_) => {'error': null, 'next': [1, 2, 3]},
      'schedules.save': (p) => {...p, 'id': 's3'},
      'schedules.setStatus': (p) {
        schedules = [for (final s in schedules) s['id'] == p['id'] ? {...s, 'status': p['status']} : s];
        return {'ok': true};
      },
      'schedules.runNow': (_) => {'ok': true},
    });
    await tester.tap(find.text('任务').first);
    await settle(tester);
    await tester.tap(find.text('定时'));
    await settle(tester);
    expect(find.text('每天天气'), findsOneWidget);
    expect(find.text('等你批准'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, '批准'));
    await settle(tester);
    expect(backend.callsTo('schedules.setStatus').single, {'id': 's1', 'status': 'active'});

    await tester.tap(find.widgetWithText(OutlinedButton, '立即运行').last);
    await settle(tester);
    expect(backend.callsTo('schedules.runNow').single, {'id': 's2'});

    await tester.tap(find.text('新建定时任务'));
    await settle(tester);
    await tester.enterText(find.widgetWithText(TextField, '名称'), '周报提醒');
    await tester.enterText(find.widgetWithText(TextField, '每次要做的事'), '提醒我写周报');
    await tester.tap(find.text('工作日 9:00'));
    await settle(tester);
    await tester.tap(find.widgetWithText(FilledButton, '保存'));
    await settle(tester);
    final saved = backend.callsTo('schedules.save').single;
    expect(saved['name'], '周报提醒');
    expect(saved['trigger'], {'type': 'cron', 'cron': '0 9 * * 1-5', 'timezone': 'Asia/Shanghai'});
    expect(saved['allowedTools'], isNull);
  });

  testWidgets('a limit notice from the core is announced', (tester) async {
    await startApp(tester);
    backend.push({
      'event': 'notices.changed',
      'notice': {'title': '今天的花费已达到上限'},
    });
    await settle(tester);
    expect(find.textContaining('今天的花费已达到上限'), findsOneWidget);
  });
}
