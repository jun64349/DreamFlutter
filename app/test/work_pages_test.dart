import 'dart:io';

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/ui/butterfly_page.dart';
import 'package:dreamflutter/ui/chat_view.dart';
import 'package:desktop_drop/desktop_drop.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:path/path.dart' as p;
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
    backend = FakeBackend()..butterflyHome = p.join(sessions.path, 'butterfly');
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
          {'id': 'a1', 'path': r'\\wsl.localhost\DreamFlutterSandbox\workspace\scratch\report.md', 'taskId': 't1', 'exists': false},
          // Written on this machine by the v0.2 desk's agent: not 蝶君's.
          {'id': 'a0', 'path': r'C:\work\old-desk.md', 'taskId': 't0', 'exists': true},
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
      'butterfly.handOff': (p) => {
        'task': {'id': 't3', 'title': '季度复盘', 'goal': '季度复盘', 'cwd': backend.butterflyHome, 'source': 'note', 'status': 'waiting', 'noteId': p['noteId']},
        'prompt': '用户把下面这份写笺交给你。\n<写笺 标题="季度复盘">…</写笺>\n资料的副本已经放进 inbox：\n- /workspace/inbox/去年数据.md',
      },
      'butterfly.outbox': (_) => [
        {'name': '图/销量.png', 'path': r'\\wsl.localhost\DreamFlutterSandbox\workspace\outbox\图\销量.png', 'size': 2048, 'modifiedAt': 1},
      ],
      'sandbox.status': (_) => {'state': 'ready', 'online': true},
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

  testWidgets('butterfly tasks use the shared composer and prepare before running', (tester) async {
    await startApp(tester);
    final tasks = <Json>[];
    backend.handlers['butterfly.tasks'] = (_) => tasks;
    backend.handlers['butterfly.prepare'] = (p) {
      final intent = {'id': 'i1', 'task_id': 't3', 'slot_id': p['slotId'], 'goal': p['goal'], 'state': 'waiting', 'start_at': 9999999999999, 'restatement': '我会整理季度复盘', 'plan': '先看资料，再归纳结果。'};
      tasks.add({'id': 't3', 'title': p['goal'], 'status': 'in_progress', 'progress': '已复述任务，等待开工', 'intent': intent});
      return intent;
    };
    await tester.tap(find.text('蝶君')); await settle(tester);
    for (var i = 0; i < 20 && agent.butterfly?.isReady != true; i++) { await settle(tester); }
    expect(agent.butterfly?.isReady, isTrue);
    expect(find.text('交流'), findsNothing); expect(find.text('工作'), findsNothing);
    expect(find.byTooltip('新写笺'), findsNothing);
    final input = find.byWidgetPredicate((w) => w is TextField && w.decoration?.hintText == '说点什么…');
    await tester.enterText(input, '季度复盘：收入增长 12%');
    await tester.pump();
    await tester.tap(find.byTooltip('发送')); await settle(tester);
    expect(find.text('我会整理季度复盘'), findsOneWidget);
    final pi = backend.pis.lastWhere((p) => p.target.sandbox);
    pi.emit({'type': 'extension_ui_request', 'id': 'plan-confirm', 'method': 'confirm', 'title': '蝶君准备开工', 'message': '先看资料，再归纳结果。'});
    await settle(tester);
    expect(find.byType(AlertDialog), findsNothing, reason: 'the plan remains inline and the composer stays available');
    expect(backend.callsTo('butterfly.prepare').single, {'goal': '季度复盘：收入增长 12%', 'slotId': pi.slotId});
    expect(backend.callsTo('butterfly.start'), isEmpty);
    expect(pi.sent('prompt'), isEmpty);
    expect(backend.pis.where((p) => !p.target.sandbox).every((p) => p.sent('prompt').isEmpty), isTrue);
    expect(backend.callsTo('desk.get'), isEmpty);
  });

  testWidgets('only the page on screen takes dropped files (v0.3.2 test)', (tester) async {
    await startApp(tester);
    bool takes(Finder page) => tester.widgetList<DropTarget>(find.descendant(of: page, matching: find.byType(DropTarget, skipOffstage: false), skipOffstage: false)).any((d) => d.enable);
    final workbench = find.byType(ChatView, skipOffstage: false).first;
    expect(takes(workbench), isTrue);

    // Both conversations remain built, but only the visible page takes a drop.
    await tester.tap(find.text('蝶君'));
    await settle(tester);
    agent.butterflyTab.value = ButterflyTab.talk;
    await settle(tester);
    expect(takes(find.byType(ButterflyPage, skipOffstage: false)), isTrue);
    expect(takes(workbench), isFalse, reason: 'the hidden workbench must not take a drop meant for 蝶君');

    await tester.tap(find.text('工作台'));
    await settle(tester);
    expect(takes(workbench), isTrue);
    expect(takes(find.byType(ButterflyPage, skipOffstage: false)), isFalse, reason: 'images dropped on the workbench turned up in 蝶君\'s input box');

    // A page pushed on top (settings) covers both.
    await tester.tap(find.byTooltip(RegExp('^设置')));
    await settle(tester);
    expect(takes(workbench), isFalse);
  });

  testWidgets('without a sandbox butterfly links to settings', (tester) async {
    await startApp(tester);
    backend.handlers['sandbox.status'] = (_) => {'state': 'absent', 'online': true};
    await tester.tap(find.text('蝶君'));
    await settle(tester);
    expect(find.text('蝶君的沙箱还没准备好'), findsOneWidget);
    expect(find.text('交流'), findsNothing);
    expect(find.text('工作'), findsNothing, reason: '「工作」 runs in the sandbox too');
    expect(find.byTooltip('新写笺'), findsNothing);
    expect(backend.callsTo('desk.get'), isEmpty);
  });

  testWidgets('unified attention handles approvals and limits while memory stays in later', (tester) async {
    await startApp(tester);
    backend.handlers['attention.list']=(_)=>{
      'now':[for(final i in inbox.where((i)=>i['kind']!='memory')) {...i,'id':'${i['kind']}:${i['id']}','title':i['kind']=='approval'?'运行 npm publish':i['title'],'origin':{'role':'workbench'},'target':{'page':'chat'},'actions':i['kind']=='limit'?['continue','end']:['allow','reject']}],
      'later':[for(final i in inbox.where((i)=>i['kind']=='memory')) {...i,'id':'memory:${i['id']}','origin':{'role':'workbench'},'target':{'page':'memory','itemId':i['id']},'actions':['allow','reject']}],
      'counts':{'total':inbox.length},'pending':<Json>[],
    };
    backend.handlers['attention.resolve']=(p){inbox.removeWhere((i)=>'${i['kind']}:${i['id']}'==p['id']);return {'id':'done-${p['id']}','itemId':p['id'],'status':'applied','undoable':false};};
    await agent.refreshPendingCounts();await tester.tap(find.text('等你处理').first);await settle(tester);
    expect(agent.pendingInbox,3);expect(find.textContaining('npm publish'),findsOneWidget);expect(find.text('现在需要你'),findsOneWidget);expect(find.text('有空看看'),findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton,'允许').first);await settle(tester);expect(backend.callsTo('attention.resolve').first,{'id':'approval:ui-9','action':'allow'});
    await tester.tap(find.widgetWithText(TextButton,'继续'));await settle(tester);expect(backend.callsTo('attention.resolve').last,{'id':'limit:n1','action':'continue'});expect(agent.pendingInbox,1);expect(find.text('撤销'),findsNothing);
    await tester.tap(find.text('去看看'));await settle(tester);expect(agent.section,AppSection.memory);
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
