import 'dart:io';

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/ui/library_page.dart' show LibraryPage;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';

void main() {
  late FakeBackend backend;
  late AgentController agent;
  late Directory sessions;

  var memories = <Json>[];
  var candidates = <Json>[];
  var proposals = <Json>[];

  Future<void> startApp(WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(1400, 2400));
    SharedPreferences.setMockInitialValues({'workspace': Directory.systemTemp.path});
    sessions = Directory.systemTemp.createTempSync('df_library_');
    backend = FakeBackend();
    memories = [
      {'id': 'm1', 'scope': 'global', 'kind': 'preference', 'content': '回答用中文，先给结论', 'source': 'user', 'status': 'active', 'updatedAt': 1},
    ];
    candidates = [
      {'id': 'c1', 'scope': 'global', 'kind': 'background', 'content': '用户在杭州工作', 'source': 'agent', 'status': 'candidate', 'action': 'add', 'reason': '对话里提到', 'updatedAt': 2},
    ];
    proposals = [
      {
        'id': 'p1',
        'title': 'weekly-report',
        'createdAt': 3,
        'payload': {'name': 'weekly-report', 'description': '写周报', 'content': '---\nname: weekly-report\n---\n\n步骤', 'scope': 'user'},
      },
    ];
    backend.handlers.addAll({
      'memory.list': (p) => p['status'] == 'candidate' ? candidates : memories,
      'memory.blocks': (_) => [
        {'key': 'about_me', 'title': '关于我', 'content': '', 'locked': false},
        {'key': 'preferences', 'title': '偏好与习惯', 'content': '', 'locked': true},
        {'key': 'agreements', 'title': '当前约定', 'content': '', 'locked': false},
      ],
      'memory.acceptPending': (p) {
        candidates = [];
        return {'ok': true};
      },
      'proposals.list': (_) => proposals,
      'proposals.accept': (_) {
        proposals = [];
        return {'path': 'x'};
      },
      'skills.list': (_) => [
        {'name': 'pdf-tools', 'description': '处理 PDF', 'filePath': r'C:\skills\pdf-tools\SKILL.md', 'scope': 'user', 'enabled': true},
      ],
      'templates.list': (_) => [
        {
          'name': '周报',
          'description': '整理周报',
          'body': '把 {{文件}} 整理成周报',
          'params': [
            {'name': '文件'},
          ],
        },
      ],
      'templates.command': (p) => {'command': '/周报 "${(p['values'] as Map)['文件']}"'},
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

  testWidgets('the rail shows pending counts and the memory page confirms candidates', (tester) async {
    await startApp(tester);
    await settle(tester);
    expect(agent.pendingMemories, 1);
    expect(agent.pendingProposals, 1);

    await tester.tap(find.byTooltip(RegExp('^记忆')));
    await settle(tester);
    // Candidates open first while there are any.
    expect(find.text('用户在杭州工作'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, '同意').first);
    await settle(tester);
    expect(backend.callsTo('memory.acceptPending').single, {'id': 'c1'});
    expect(find.text('用户在杭州工作'), findsNothing);

    await tester.tap(find.text('记忆库'));
    await settle(tester);
    expect(find.text('回答用中文，先给结论'), findsOneWidget);

    // Add a memory through the dialog.
    await tester.tap(find.text('添加记忆'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, '周报每周五交');
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, '保存').last);
    await settle(tester);
    expect(backend.callsTo('memory.save').single, {'content': '周报每周五交', 'kind': 'preference', 'scope': 'global', 'cwd': null});

    // Editing a block enables its save button.
    await tester.tap(find.text('常驻记忆块'));
    await settle(tester);
    expect(find.text('偏好与习惯'), findsOneWidget);
    expect(find.text('已锁定'), findsOneWidget);
    final blockField = find.byWidgetPredicate((w) => w is TextField && (w.decoration?.hintText ?? '').startsWith('例如：我叫'));
    await tester.enterText(blockField, '我是产品经理');
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, '保存').first);
    await settle(tester);
    expect(backend.callsTo('memory.setBlock').single, {'key': 'about_me', 'content': '我是产品经理'});
  });

  testWidgets('skills, templates and proposals', (tester) async {
    await startApp(tester);
    await settle(tester);
    await tester.tap(find.byTooltip(RegExp('^技能')));
    await settle(tester);

    // Pending proposals open first.
    expect(find.text('等你确认的技能'), findsOneWidget);
    await tester.tap(find.text('保存技能'));
    await settle(tester);
    expect(backend.callsTo('proposals.accept').single, {'id': 'p1'});

    await tester.tap(find.descendant(of: find.byType(LibraryPage), matching: find.text('技能')));
    await settle(tester);
    expect(find.text('pdf-tools'), findsOneWidget);
    await tester.tap(find.byType(Switch).first);
    await settle(tester);
    expect(backend.callsTo('skills.setEnabled').single, {'filePath': r'C:\skills\pdf-tools\SKILL.md', 'enabled': false});

    await tester.tap(find.descendant(of: find.byType(LibraryPage), matching: find.text('任务模板')));
    await settle(tester);
    expect(find.text('/周报'), findsOneWidget);
    await tester.tap(find.widgetWithText(OutlinedButton, '运行'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, 'a.md');
    await tester.tap(find.widgetWithText(FilledButton, '运行').last);
    await settle(tester);
    expect(backend.callsTo('templates.command').single, {
      'name': '周报',
      'values': {'文件': 'a.md'},
    });
    expect(agent.section, AppSection.chat, reason: 'running a template goes back to the chat');
    expect(backend.pis.single.sent('prompt').single, contains(r'/周报 \"a.md\"'));
  });

  testWidgets('a memory.changed event refreshes the badges', (tester) async {
    await startApp(tester);
    await settle(tester);
    candidates = [];
    backend.push({'event': 'memory.changed'});
    await settle(tester);
    expect(agent.pendingMemories, 0);
  });
}
