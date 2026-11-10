import 'dart:io';
import 'dart:convert';

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/butterfly_motion.dart';
import 'package:dreamflutter/ui/motion.dart';
import 'package:dreamflutter/ui/shell_widgets.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';

void main() {
  test('new defaults keep the named painting themes available', () {
    expect(PaintingTheme.byId(null, Brightness.light), PaintingTheme.warmPaper);
    expect(PaintingTheme.byId(null, Brightness.dark), PaintingTheme.twilight);
    expect(PaintingTheme.byId('jiadie', Brightness.light), PaintingTheme.jiadie);
    expect(PaintingTheme.byId('moye', Brightness.dark), PaintingTheme.moye);
  });

  test('sidebar keeps descendants under their parent and handles orphans and cycles', () {
    SidebarEntry entry(String path, String? parent, int day) => SidebarEntry(path: path, title: path,
      parentSession: parent, modifiedAt: DateTime(2026, 11, day), isActive: false, isRunning: false, hasUnseenResult: false, hasError: false);
    final rows = [entry('C:/root', null, 1), entry('C:/child', 'C:/root', 3), entry('C:/orphan', 'C:/missing', 2), entry('C:/a', 'C:/b', 4), entry('C:/b', 'C:/a', 5)];
    final ordered = orderSidebarEntries(rows).map((r) => r.path).toList();
    expect(ordered.indexOf('C:/child'), ordered.indexOf('C:/root') + 1);
    expect(ordered.toSet().length, rows.length);
  });

  test('saved side metadata stays excluded by default and is available to the shell', () async {
    final root = Directory.systemTemp.createTempSync('df_t84_side_');
    try {
      final file = File('${root.path}/side.jsonl')..writeAsStringSync([
        jsonEncode({'type': 'session', 'id': 'side', 'cwd': root.path, 'parentSession': '${root.path}/parent.jsonl'}),
        jsonEncode({'type': 'custom', 'customType': 'df.sideConversation', 'data': {'sessionId': 'side', 'quote': '这个公式'}}),
        jsonEncode({'type': 'message', 'message': {'role': 'user', 'content': [{'type': 'text', 'text': '请解释'}]}}),
      ].join('\n'));
      expect(await SessionStore.readSummary(file), isNull);
      final side = await SessionStore.readSummary(file, includeSideConversations: true);
      expect(side!.parentSession, '${root.path}/parent.jsonl');
      expect(side.isSideConversation, isTrue);
      expect(side.sideQuote, '这个公式');
    } finally { root.deleteSync(recursive: true); }
  });

  test('butterfly follows observed work and stays still on abort or error', () async {
    final root = Directory.systemTemp.createTempSync('df_t84_events_');
    SharedPreferences.setMockInitialValues({'workspace': root.path});
    final agent = AgentController(preferences: await Preferences.load(), backend: FakeBackend(), sessionStore: SessionStore(sessionsDir: root.path));
    try {
      await agent.init();
      final transcript = agent.transcript;
      void event(Json value) => transcript.apply(PiEvent.fromJson(value));
      expect(butterflyActivity(agent), ButterflyActivity.idle);
      event({'type': 'agent_start'});
      event({'type': 'message_end', 'message': {'role': 'user', 'content': '做这件事', 'timestamp': 1}});
      expect(butterflyActivity(agent), ButterflyActivity.received);
      event({'type': 'message_start', 'message': {'role': 'assistant', 'content': [{'type': 'thinking', 'thinking': '想一想'}], 'timestamp': 2}});
      event({'type': 'message_update', 'assistantMessageEvent': {'type': 'thinking_delta', 'contentIndex': 0, 'delta': '想一想'}});
      expect(butterflyActivity(agent), ButterflyActivity.thinking);
      for (final (name, activity) in [('search', ButterflyActivity.searching), ('read', ButterflyActivity.reading), ('edit', ButterflyActivity.working)]) {
        event({'type': 'tool_execution_start', 'toolCallId': name, 'toolName': name, 'args': {}});
        expect(butterflyActivity(agent), activity);
        event({'type': 'tool_execution_end', 'toolCallId': name, 'toolName': name, 'result': {'content': []}, 'isError': false});
      }
      agent.active!.pendingDialogs.add(ExtensionUiRequest.fromJson({'type': 'extension_ui_request', 'id': 'approval', 'method': 'confirm', 'title': '允许？'}));
      agent.pendingInbox = 1;
      expect(shellPendingCount(agent), 1, reason: 'the same approval is already in inbox.list');
      expect(butterflyActivity(agent), ButterflyActivity.waiting);
      agent.active!.pendingDialogs.clear();
      event({'type': 'message_end', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': '写给你'}], 'stopReason': 'stop', 'timestamp': 3}});
      expect(butterflyActivity(agent), ButterflyActivity.writing);
      event({'type': 'agent_settled', 'aborted': false});
      expect(butterflyActivity(agent), ButterflyActivity.complete);
      event({'type': 'message_end', 'message': {'role': 'assistant', 'content': [], 'stopReason': 'aborted', 'timestamp': 4}});
      expect(butterflyActivity(agent), ButterflyActivity.paused);
    } finally { agent.dispose(); root.deleteSync(recursive: true); }
  });

  testWidgets('reduced motion leaves butterfly, running dot and caret still', (tester) async {
    await tester.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: MediaQuery(
      data: const MediaQueryData(disableAnimations: true), child: const Row(children: [
        ButterflyAvatar(activity: ButterflyActivity.searching), BreathingDot(), StreamingCaret(),
      ]),
    )));
    await tester.pumpAndSettle();
    expect(tester.binding.transientCallbackCount, 0);
    final transform = tester.widgetList<Transform>(find.byType(Transform)).map((w) => w.transform.storage.toList()).toList();
    await tester.pump(const Duration(seconds: 2));
    expect(tester.widgetList<Transform>(find.byType(Transform)).map((w) => w.transform.storage.toList()).toList(), transform);
  });

  testWidgets('shell retains its pages, nests saved side chats, and adapts at 150 percent', (tester) async {
    final root = Directory.systemTemp.createTempSync('df_t84_shell_');
    final now = DateTime.now().millisecondsSinceEpoch;
    final backend = FakeBackend()..sessionRows = [
      {'path': '${root.path}/parent.jsonl', 'title': '父对话', 'modifiedAt': now, 'cwd': root.path},
      {'path': '${root.path}/fork.jsonl', 'title': '从这里重来', 'parentSession': '${root.path}/parent.jsonl', 'modifiedAt': now + 1, 'cwd': root.path},
    ];
    backend.handlers['sessions.children'] = (params) => params['parentSession'] == '${root.path}/parent.jsonl'
      ? [{'path': '${root.path}/side.jsonl', 'title': '问一下', 'sessionType': 'side', 'parentSession': '${root.path}/parent.jsonl', 'modifiedAt': now, 'cwd': root.path}]
      : <Json>[];
    SharedPreferences.setMockInitialValues({'workspace': root.path, 'onboarded': true});
    final agent = AgentController(preferences: await tester.runAsync(Preferences.load) as Preferences, sessionStore: SessionStore(sessionsDir: root.path), backend: backend);
    addTearDown(() async { await tester.pumpWidget(const SizedBox()); agent.dispose(); root.deleteSync(recursive: true); await tester.binding.setSurfaceSize(null); });
    await tester.binding.setSurfaceSize(const Size(1000, 800));
    await tester.pumpWidget(DreamFlutterApp(controller: agent));
    await tester.runAsync(agent.init);
    await tester.runAsync(agent.refreshSessions);
    await tester.pumpAndSettle();
    expect(find.text('父对话'), findsOneWidget);
    expect(find.text('问一下'), findsOneWidget);
    expect(tester.getTopLeft(find.text('今天')).dx, lessThan(tester.getTopLeft(find.text('父对话')).dx + 20), reason: 'time groups stay aligned with their rows during list animation');
    expect(tester.getTopLeft(find.text('问一下')).dx, greaterThan(tester.getTopLeft(find.text('父对话')).dx));
    await tester.tap(find.byTooltip('设置'));
    await tester.pumpAndSettle();
    expect(find.text('一方天地'), findsOneWidget);
    expect(find.text('新对话'), findsNWidgets(2), reason: 'navigation and the default conversation breadcrumb');
    await agent.setZoom(1.5);
    await tester.pumpAndSettle();
    expect(find.byTooltip('打开侧栏'), findsOneWidget);
    for (final section in AppSection.values.where((s) => s != AppSection.butterfly)) {
      agent.showSection(section);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull, reason: '${section.name} at 150%');
    }
    expect(tester.takeException(), isNull);
  });
}
