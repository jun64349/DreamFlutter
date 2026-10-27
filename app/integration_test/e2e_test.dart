// End-to-end acceptance: the real app UI driving a real core (Pi sessions
// hosted in the background service) and a real model. Run with:
//   flutter test integration_test/e2e_test.dart -d windows
// Screenshots are written to build/e2e_shots/. Keep the test window visible
// (it may be covered, but not minimized: a minimized window renders no frames).

import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

const model = String.fromEnvironment('E2E_MODEL', defaultValue: Preferences.defaultModelKey);

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  final shotKey = GlobalKey();
  final shotsDir = Directory(p.join(Directory.current.path, 'build', 'e2e_shots'))..createSync(recursive: true);

  Future<void> idle(WidgetTester tester, [Duration d = const Duration(milliseconds: 200)]) async {
    await tester.runAsync(() => Future<void>.delayed(d));
    await tester.pump();
  }

  /// Snapshot of the agent for failure messages (app stdout is not captured).
  String describe(AgentController agent) {
    final lines = ['status=${agent.status} running=${agent.isRunning} runtimes=${agent.runtimes.length} session=${agent.currentSessionPath}'];
    for (final item in agent.transcript.items) {
      lines.add(switch (item) {
        UserItem(:final text) => '  user: $text',
        AssistantItem(:final parts, :final stopReason, :final errorMessage) =>
          '  assistant[$stopReason${errorMessage == null ? '' : ' $errorMessage'}]: ${parts.map((p) => switch (p) {
                TextPart(:final text) => 'text(${text.length})',
                ThinkingPart(:final text) => 'thinking(${text.length})',
                ToolCallPart(:final toolCallId) => 'tool(${agent.transcript.tool(toolCallId)?.name}:${agent.transcript.tool(toolCallId)?.status.name})',
              }).join(' ')}',
        NoticeItem(:final kind, :final message) => '  notice($kind): $message',
      });
    }
    return lines.join('\n');
  }

  Future<void> waitFor(WidgetTester tester, String what, bool Function() condition, AgentController agent,
      {Duration timeout = const Duration(minutes: 3)}) async {
    final deadline = DateTime.now().add(timeout);
    while (!condition()) {
      if (agent.status == ConnectionStatus.crashed || agent.status == ConnectionStatus.missingRuntime) {
        fail('Pi is not running while waiting for "$what":\n${agent.statusDetail}');
      }
      if (DateTime.now().isAfter(deadline)) fail('timed out waiting for "$what"\n${describe(agent)}');
      await idle(tester);
    }
  }

  Future<void> shot(WidgetTester tester, String name) async {
    await tester.pump();
    await tester.runAsync(() async {
      final boundary = shotKey.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final image = await boundary.toImage(pixelRatio: 1);
      final png = await image.toByteData(format: ui.ImageByteFormat.png);
      File(p.join(shotsDir.path, '$name.png')).writeAsBytesSync(png!.buffer.asUint8List());
    });
  }

  final composer = find.byWidgetPredicate((w) {
    final hint = w is TextField ? (w.decoration?.hintText ?? '') : '';
    return hint.contains('Enter 发送') || hint.contains('插话');
  });

  Future<void> sendMessage(WidgetTester tester, String text) async {
    // Click into the composer first, like a user would: an earlier click
    // elsewhere moves focus away from it.
    await tester.tap(composer);
    await tester.pump();
    await tester.enterText(composer, text);
    await tester.pump();
    expect(tester.widget<TextField>(composer).controller!.text, text, reason: 'text reached the composer');
    await tester.tap(find.text('发送'));
    await tester.pump();
  }

  List<AssistantItem> assistants(AgentController agent) => agent.transcript.items.whereType<AssistantItem>().toList();
  String lastText(AgentController agent) =>
      assistants(agent).lastOrNull?.parts.whereType<TextPart>().map((t) => t.text).join() ?? '';
  Finder sidebarTile(String titleStart) => find.descendant(
    of: find.byType(ListView).first,
    matching: find.textContaining(titleStart),
  );

  testWidgets('v0.1.1 acceptance against the real core', (tester) async {
    final temp = Directory.systemTemp.createTempSync('df_e2e_');
    final workspace = Directory(p.join(temp.path, 'workspace'))..createSync();
    final otherWorkspace = Directory(p.join(temp.path, 'other'))..createSync();
    final sessionsDir = p.join(temp.path, 'sessions');
    File(p.join(workspace.path, 'hello.txt')).writeAsStringSync('hello from dreamflutter\n');
    // Project config (needs a trust decision): keep almost nothing recent, so
    // even a short session has something to compact.
    File(p.join(workspace.path, '.pi', 'settings.json'))
      ..createSync(recursive: true)
      ..writeAsStringSync('{"compaction": {"keepRecentTokens": 20}}');

    SharedPreferences.setMockInitialValues({
      'workspace': workspace.path,
      'modelKey': model,
      'recentWorkspaces': [otherWorkspace.path],
    });
    // An isolated core: own data dir and session dir, the user's Pi agent dir
    // (for model credentials).
    CoreBackend newBackend() => CoreBackend(dataDir: p.join(temp.path, 'core'), extraArgs: ['--session-dir', sessionsDir]);
    var agent = AgentController(
      preferences: await Preferences.load(),
      sessionStore: SessionStore(sessionsDir: sessionsDir),
      backend: newBackend(),
    );

    // Stop this test's core even when a step fails.
    addTearDown(() => agent.shutdownCore());
    await tester.pumpWidget(RepaintBoundary(key: shotKey, child: DreamFlutterApp(controller: agent)));
    unawaited(agent.init());
    // The workspace has project config: the core asks through the window.
    await waitFor(tester, 'trust prompt', () => find.text('信任这个工作区的配置吗？').evaluate().isNotEmpty, agent);
    await shot(tester, '00_trust_prompt');
    await tester.tap(find.text('仅这次信任'));
    await tester.pump();
    await waitFor(tester, 'ready', () => agent.isReady, agent);
    expect(agent.model?.key, model);
    expect(agent.approvalMode, ApprovalMode.changes);
    await shot(tester, '00_ready');

    // 1. Read-only tools run without asking: prompt -> read -> reply.
    await sendMessage(tester, '请用 read 工具读取 hello.txt，然后只回复文件内容，不要别的文字。');
    await waitFor(tester, 'reply', () => !agent.isRunning && lastText(agent).isNotEmpty, agent);
    expect(lastText(agent), contains('hello from dreamflutter'));
    expect(agent.transcript.tools.values.singleWhere((r) => r.name == 'read').status, ToolStatus.done);
    final sessionA = agent.currentSessionPath!;
    final runtimeA = agent.active!;
    await shot(tester, '01_read_reply');

    // 2. Background run: start a long answer, open a new session meanwhile.
    final turnsBefore = assistants(agent).length;
    await sendMessage(tester, '写一篇 1500 字关于大海的散文。直接在回复里写，不要使用任何工具。');
    await waitFor(tester, 'A running', () => agent.isRunning && assistants(agent).length > turnsBefore, agent);
    await tester.tap(find.text('新会话'));
    await waitFor(tester, 'B active', () => agent.active != runtimeA && agent.isReady, agent);
    expect(runtimeA.isRunning, isTrue, reason: 'A keeps running in the background');
    expect(runtimeA.transcript.items.whereType<AssistantItem>().last.aborted, isFalse);
    expect(find.textContaining('后台运行 1 个'), findsOneWidget);
    await shot(tester, '02_background_running');

    // 3. Work in B while A runs: a bash call needs approval in "changes" mode.
    await sendMessage(tester, '用 bash 工具运行命令：echo approval-ok ，然后告诉我输出。');
    await waitFor(tester, 'approval dialog', () => find.text('Agent 请求执行操作').evaluate().isNotEmpty, agent);
    expect(find.textContaining('echo approval-ok'), findsWidgets);
    await shot(tester, '03_approval_dialog');
    await tester.tap(find.widgetWithText(FilledButton, '允许'));
    await tester.pump();
    await waitFor(tester, 'B reply', () => !agent.isRunning && lastText(agent).contains('approval-ok'), agent);
    expect(agent.transcript.tools.values.singleWhere((r) => r.name == 'bash').status, ToolStatus.done);
    await shot(tester, '04_parallel_sessions');

    // 4. Back to A: same process, still running or finished; stop it if needed.
    await tester.tap(sidebarTile('请用 read').first);
    await waitFor(tester, 'A active', () => agent.active == runtimeA, agent);
    await idle(tester, const Duration(milliseconds: 500));
    expect(agent.runtimes.length, greaterThanOrEqualTo(2));
    // The model may have reached for a tool while writing; decline it.
    if (find.text('Agent 请求执行操作').evaluate().isNotEmpty) {
      await tester.tap(find.widgetWithText(OutlinedButton, '拒绝'));
      await tester.pump();
    }
    if (agent.isRunning) {
      await tester.tap(find.text('停止'));
      await waitFor(tester, 'A stopped', () => !agent.isRunning, agent);
    }
    expect(
      assistants(agent).skip(turnsBefore).expand((a) => a.parts),
      isNotEmpty,
      reason: 'A kept working while in the background\n${describe(agent)}',
    );
    await shot(tester, '05_back_to_a');

    // 5. Fork from the essay request: a new session that keeps the first
    //    exchange, with the essay request back in the input box.
    // The long essay pushed the request off screen; scroll up to it first.
    final messages = find.descendant(of: find.byType(SelectionArea), matching: find.byType(Scrollable)).first;
    await tester.scrollUntilVisible(find.byIcon(Icons.call_split), -300, scrollable: messages);
    await tester.pump();
    await tester.tap(find.byIcon(Icons.call_split).last);
    await waitFor(tester, 'forked', () => agent.currentSessionPath != sessionA && agent.active == runtimeA, agent);
    await idle(tester);
    expect(tester.widget<TextField>(composer).controller!.text, contains('大海'));
    expect(agent.transcript.items.whereType<UserItem>().single.text, contains('hello.txt'));
    await shot(tester, '06_forked');

    // 6. Context panel and manual compaction in the fork. Pi summarizes whole
    //    earlier turns, so give it a second turn first.
    await sendMessage(tester, '只回复两个字：好的');
    await waitFor(tester, 'second turn', () => !agent.isRunning && agent.transcript.items.whereType<UserItem>().length == 2 && lastText(agent).isNotEmpty, agent);
    await tester.tap(find.text('上下文').last);
    await tester.pumpAndSettle();
    expect(find.text('立即压缩'), findsOneWidget);
    await shot(tester, '07_context_dialog');
    await tester.enterText(find.byWidgetPredicate((w) => w is TextField && (w.decoration?.hintText?.contains('重点保留') ?? false)), '保留文件内容');
    await tester.tap(find.widgetWithText(FilledButton, '压缩'));
    await waitFor(tester, 'compacted', () => find.textContaining('压缩完成').evaluate().isNotEmpty, agent);
    await shot(tester, '08_compacted');
    await tester.tap(find.byTooltip('关闭'));
    await tester.pumpAndSettle();
    expect(agent.transcript.items.whereType<NoticeItem>().where((n) => n.kind == NoticeKind.compaction), isNotEmpty);

    // 7. Skills panel, settings page and workspace menu render.
    await tester.tap(find.text('Skills 与命令'));
    await tester.pumpAndSettle();
    await shot(tester, '09_skills');
    await tester.tap(find.byTooltip('关闭'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('设置'));
    await tester.pumpAndSettle();
    expect(find.text('修改和命令需确认'), findsOneWidget);
    await shot(tester, '10_settings');
    await tester.pageBack();
    await tester.pumpAndSettle();

    await tester.tap(find.text('工作区').first);
    await tester.pumpAndSettle();
    expect(find.text(p.basename(otherWorkspace.path)), findsOneWidget);
    await shot(tester, '11_workspace_menu');
    await tester.tap(find.text(p.basename(otherWorkspace.path)));
    await waitFor(tester, 'other workspace', () => SessionStore.samePath(agent.workspace, otherWorkspace.path) && agent.isReady, agent);
    expect(agent.transcript.items, isEmpty);
    await shot(tester, '12_other_workspace');

    // 8. Close the window mid-run: the session keeps running in the core, and
    //    a new window attaches to it and sees it finish.
    await sendMessage(tester, '写一段 300 字左右关于星空的文字。直接写，不要使用任何工具。');
    await waitFor(tester, 'C running', () => agent.isRunning, agent);
    final sessionC = agent.currentSessionPath!;
    agent.dispose(); // the window goes away; the core keeps the session
    await tester.pumpWidget(const SizedBox());
    await idle(tester, const Duration(seconds: 1));

    agent = AgentController(
      preferences: await Preferences.load(),
      sessionStore: SessionStore(sessionsDir: sessionsDir),
      backend: newBackend(),
    );
    await tester.pumpWidget(RepaintBoundary(key: shotKey, child: DreamFlutterApp(controller: agent)));
    unawaited(agent.init());
    final reattached = await (() async {
      await waitFor(tester, 'reattached', () => agent.runtimes.any((r) => r.sessionPath != null && SessionStore.samePath(r.sessionPath!, sessionC)), agent);
      return agent.runtimes.firstWhere((r) => SessionStore.samePath(r.sessionPath!, sessionC));
    })();
    await tester.runAsync(() => agent.openSession(sessionC));
    await waitFor(tester, 'C finished in the new window', () => !reattached.isRunning && reattached.transcript.items.whereType<AssistantItem>().isNotEmpty, agent);
    expect(reattached.transcript.items.whereType<UserItem>().last.text, contains('星空'));
    expect(lastText(agent), isNotEmpty);
    await shot(tester, '13_reattached_after_window_closed');

    await agent.shutdownCore();
    agent.dispose();
    await idle(tester, const Duration(seconds: 2));
  }, timeout: const Timeout(Duration(minutes: 15)));
}
