// T-140 hookup: the window side of the six backend APIs (rule draft edit, long goal switch,
// uninstall.start, goals.bySession, schedules.parseTime / timeText, 「蝶君去做」 with 要做的事).
import 'dart:io' show pid;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/attention_page.dart';
import 'package:dreamflutter/ui/schedule_page.dart';
import 'package:dreamflutter/ui/settings_butterfly.dart';
import 'package:dreamflutter/ui/settings_controls.dart' show V1Toggle;
import 'package:dreamflutter/ui/settings_restore.dart';
import 't87_fixture.dart';

void main() {
  Future<void> settle(WidgetTester t, [int rounds = 3]) async {
    for (var i = 0; i < rounds; i++) { await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 40))); await t.pump(const Duration(milliseconds: 50)); }
  }
  Future<T87Fixture> mount(WidgetTester t, Widget child, {Size size = const Size(1200, 1000)}) async {
    final f = (await t.runAsync(T87Fixture.create))!;
    addTearDown(() async { await t.pumpWidget(const SizedBox()); await t.runAsync(f.dispose); });
    await t.binding.setSurfaceSize(size);
    await t.pumpWidget(AgentScope(controller: f.agent, child: MaterialApp(theme: buildTheme(Brightness.light), home: Scaffold(body: child))));
    return f;
  }

  testWidgets('uninstall sends the keep choice and this window pid, then closes the window', (t) async {
    final f = await mount(t, const UninstallSetting());
    var closed = 0;
    f.agent.closeWindowForUninstall = () async => closed++;
    f.backend.handlers['uninstall.start'] = (_) => throw CoreException('unavailable', '当前不是支持卸载的 Windows 安装版');
    await t.tap(find.text('卸载…')); await t.pumpAndSettle();
    await t.tap(find.text('保留我的数据')); await t.pump();
    await t.tap(find.widgetWithText(OutlinedButton, '卸载')); await settle(t);
    expect(find.textContaining('不是支持卸载的 Windows 安装版'), findsOneWidget);
    expect(closed, 0);
    f.backend.handlers['uninstall.start'] = (_) => {'started': true};
    await t.tap(find.widgetWithText(OutlinedButton, '卸载')); await settle(t);
    expect(f.backend.callsTo('uninstall.start').last, {'keepData': true, 'windowPid': pid});
    expect(closed, 1);
  });

  testWidgets('long goals show when they last studied or 暂停了, and the switch sends setEnabled', (t) async {
    final f = (await t.runAsync(T87Fixture.create))!;
    final yesterday = DateTime.now().subtract(const Duration(days: 1));
    var rows = <Json>[
      {'id': 'l1', 'title': '把传感器选型的门道摸清楚', 'instruction': '学', 'revision': 3, 'enabled': true, 'lastStudiedAt': DateTime(yesterday.year, yesterday.month, yesterday.day, 23, 10).millisecondsSinceEpoch, 'noteCount': null},
      {'id': 'l2', 'title': '熟悉 GB/T 7714 的细节', 'instruction': '学', 'revision': 1, 'enabled': false, 'lastStudiedAt': null, 'noteCount': null},
    ];
    f.backend.handlers['selfwork.longGoals.list'] = (_) => rows;
    f.backend.handlers['selfwork.longGoals.setEnabled'] = (p) { rows = [for (final r in rows) r['id'] == p['id'] ? {...r, 'enabled': p['enabled'], 'revision': (r['revision'] as int) + 1} : r]; return rows.first; };
    addTearDown(() async { await t.pumpWidget(const SizedBox()); await t.runAsync(f.dispose); });
    await t.binding.setSurfaceSize(const Size(900, 700));
    await t.pumpWidget(AgentScope(controller: f.agent, child: MaterialApp(theme: buildTheme(Brightness.light), home: const Scaffold(body: ButterflyLongGoals()))));
    await settle(t);
    expect(find.text('空闲时自己学 · 上次 昨天 23:10'), findsOneWidget);
    expect(find.text('暂停了'), findsOneWidget);
    expect(find.textContaining('笔记'), findsNothing);
    await t.tap(find.byType(V1Toggle).first); await settle(t);
    expect(f.backend.callsTo('selfwork.longGoals.setEnabled').last, {'id': 'l1', 'enabled': false, 'revision': 3});
    expect(find.text('暂停了'), findsNWidgets(2));
  });

  testWidgets('改一改 edits a rule draft in place and saves through autonomy.drafts.update', (t) async {
    final f = (await t.runAsync(T87Fixture.create))!;
    var draft = <String, dynamic>{'name': '工作日 9 点整理新纪要', 'source': 'schedule', 'task': '把新纪要整理成要点', 'scope': {'kind': 'sandbox'}, 'actions': ['read'], 'delivery': '/workspace/outbox', 'assess': false, 'filter': {}};
    var version = 1;
    Json list() => {'counts': {'total': 1, 'now': 1, 'later': 0}, 'later': <Json>[], 'pending': <Json>[], 'now': [
      {'id': 'c1', 'kind': 'question', 'group': 'now', 'title': '确认蝶君起草的主动规则', 'reason': 'raw message', 'origin': {'role': 'butterfly'}, 'target': {'page': 'butterfly'}, 'actions': ['allow', 'reject'], 'data': {'kind': 'rule_draft', 'draft': draft, 'version': version}},
    ]};
    f.backend.handlers['attention.list'] = (_) => list();
    f.backend.handlers['attention.prioritized'] = (_) => <Json>[];
    f.backend.handlers['autonomy.drafts.update'] = (p) { draft = Map<String, dynamic>.from(p['draft'] as Map); version++; return {'id': 'c1'}; };
    await f.agent.attention.refresh();
    addTearDown(() async { await t.pumpWidget(const SizedBox()); await t.runAsync(f.dispose); });
    await t.binding.setSurfaceSize(const Size(1100, 900));
    await t.pumpWidget(AgentScope(controller: f.agent, child: MaterialApp(theme: buildTheme(Brightness.light), home: const AttentionPage())));
    await settle(t);
    expect(find.text('把新纪要整理成要点'), findsOneWidget);
    expect(find.text('raw message'), findsNothing);
    await t.pumpAndSettle();
    await t.tap(find.text('改一改')); await t.pumpAndSettle();
    expect(find.text('先观察'), findsNothing);
    await t.enterText(find.widgetWithText(TextField, '把新纪要整理成要点'), '只整理新纪要，不碰旧的');
    await t.tap(find.text('保存')); await settle(t, 5);
    final sent = f.backend.callsTo('autonomy.drafts.update').single;
    expect(sent['id'], 'c1'); expect(sent['version'], 1);
    expect((sent['draft'] as Map)['task'], '只整理新纪要，不碰旧的');
    expect((sent['draft'] as Map)['delivery'], '/workspace/outbox');
    expect(find.text('只整理新纪要，不碰旧的'), findsOneWidget);
    expect(find.text('先观察'), findsOneWidget);
    await t.pump(const Duration(milliseconds: 400)); // the closed editor's fields are disposed after its fade
  });

  testWidgets('新建 parses the time with schedules.parseTime; 蝶君去做 needs 要做的事 and leaves cwd to the backend', (t) async {
    final f = (await t.runAsync(T87Fixture.create))!;
    f.backend.handlers['schedules.occurrences'] = (_) => {'items': <Json>[], 'schedules': <Json>[]};
    f.backend.handlers['patrol.status'] = (_) => {'enabled': true, 'running': false};
    f.backend.handlers['patrol.log'] = (_) => <Json>[];
    f.backend.handlers['schedules.parseTime'] = (p) => p['text'] == '昨天8点'
        ? throw CoreException('bad_request', '这个时间已经过了，换一个以后的时间。')
        : {'trigger': {'type': 'once', 'at': 1794639600000, 'timezone': 'Asia/Shanghai'}, 'text': '11月14日 15:00'};
    f.backend.handlers['schedules.save'] = (p) => {...p, 'id': 'new1', 'version': 1};
    addTearDown(() async { await t.pumpWidget(const SizedBox()); await t.runAsync(f.dispose); });
    await t.binding.setSurfaceSize(const Size(1500, 1000));
    await t.pumpWidget(AgentScope(controller: f.agent, child: MaterialApp(theme: buildTheme(Brightness.light), home: const SchedulePage())));
    await settle(t);
    await t.tap(find.text('新建')); await settle(t);
    final fields = find.descendant(of: find.byType(ScheduleEditor), matching: find.byType(TextField));
    await t.enterText(fields.at(0), '交周报');
    await t.tap(find.text('到点提醒我')); await t.pumpAndSettle();
    await t.tap(find.text('蝶君去做').last); await t.pumpAndSettle();
    expect(find.text('要做的事'), findsOneWidget);
    await t.enterText(fields.at(1), '昨天8点');
    await t.tap(find.text('保存')); await settle(t);
    expect(find.text('请写要做的事'), findsOneWidget);
    await t.enterText(find.descendant(of: find.byType(ScheduleEditor), matching: find.byType(TextField)).at(2), '把这周的数据整理成周报');
    await t.tap(find.text('保存')); await settle(t);
    expect(find.textContaining('已经过了'), findsOneWidget);
    expect(f.backend.callsTo('schedules.save'), isEmpty);
    await t.enterText(fields.at(1), '明天下午3点');
    await t.tap(find.text('保存')); await settle(t);
    final saved = f.backend.callsTo('schedules.save').single;
    expect(saved['kind'], 'task'); expect(saved['prompt'], '把这周的数据整理成周报'); expect(saved.containsKey('cwd'), isFalse);
    expect(saved['trigger'], {'type': 'once', 'at': 1794639600000, 'timezone': 'Asia/Shanghai'});
  });
}
