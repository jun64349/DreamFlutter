// End-to-end acceptance: the real app UI driving a real core (Pi sessions
// hosted in the background service) and a real model. Run with:
//   flutter test integration_test/e2e_test.dart -d windows
// Screenshots are written to build/e2e_shots/. Keep the test window visible
// (it may be covered, but not minimized: a minimized window renders no frames).
// The model is deepseek-v4.1-flash on the OpenCode Go channel configured in the
// app (copied into the test's own core with core/scripts/copy-channels.ts); without
// one, or with --dart-define=E2E_MODEL=provider/id, a model of the user's Pi config.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/theme.dart' show AppColors;
import 'package:dreamflutter/ui/dashboard_page.dart' show DashboardPage;
import 'package:dreamflutter/ui/desk_page.dart' show DeskPage;
import 'package:dreamflutter/ui/library_page.dart' show LibraryPage;
import 'package:dreamflutter/ui/memory_page.dart' show MemoryPage;
import 'package:dreamflutter/ui/motion.dart' show BreathingDot;
import 'package:dreamflutter/ui/schedules.dart' show SchedulesTab;
import 'package:dreamflutter/ui/settings_page.dart' show SettingsPage;
import 'package:dreamflutter/ui/sidebar.dart' show Sidebar;
import 'package:dreamflutter/ui/tasks_page.dart' show TasksPage;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// A model of the user's Pi configuration, when asked for (`--dart-define=E2E_MODEL=provider/id`)
/// or when no OpenCode Go channel is configured in the app.
const piModel = String.fromEnvironment('E2E_MODEL', defaultValue: Preferences.defaultModelKey);

/// Tests run on OpenCode Go (the user's choice, 2026-11-01): the channel configured in the app.
const goModel = 'deepseek-v4.1-flash';

/// Copies the app's OpenCode Go channels (keys stay encrypted) into the test core's
/// data dir; returns the channel offering [goModel], if any. Nothing is created.
Future<String?> copyGoChannel(String toDataDir) async {
  final main = CoreLocator.findMain([Directory.current.path]);
  final node = PiRuntimeLocator.findOnPath('node');
  if (main == null || node == null) return null;
  final coreDir = p.dirname(p.dirname(main));
  final result = await Process.run(node, [
    '--disable-warning=ExperimentalWarning',
    p.join(coreDir, 'scripts', 'copy-channels.ts'),
    CoreLocator.defaultDataDir(),
    toDataDir,
  ], workingDirectory: coreDir);
  if (result.exitCode != 0) return null;
  for (final channel in jsonDecode((result.stdout as String).trim()) as List) {
    if ((channel['models'] as List).contains(goModel)) return channel['channel'] as String;
  }
  return null;
}

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
      if (DateTime.now().isAfter(deadline)) {
        // What the window showed, for diagnosis.
        await tester.runAsync(() async {
          final boundary = shotKey.currentContext?.findRenderObject() as RenderRepaintBoundary?;
          final png = await (await boundary?.toImage(pixelRatio: 1))?.toByteData(format: ui.ImageByteFormat.png);
          if (png != null) File(p.join(shotsDir.path, 'zz_timeout.png')).writeAsBytesSync(png.buffer.asUint8List());
        });
        fail('timed out waiting for "$what"\n${describe(agent)}');
      }
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
    return hint.contains('Enter 发送') || hint.contains('插进');
  });

  Future<void> sendMessage(WidgetTester tester, String text) async {
    // Click into the composer first, like a user would: an earlier click
    // elsewhere moves focus away from it.
    await tester.tap(composer);
    await tester.pump();
    await tester.enterText(composer, text);
    await tester.pump();
    expect(tester.widget<TextField>(composer).controller!.text, text, reason: 'text reached the composer');
    await tester.tap(find.byTooltip('发送'));
    await tester.pump();
  }

  /// A category in the settings page's left column.
  Finder settingsCategory(String name) => find.descendant(of: find.byType(SettingsPage), matching: find.widgetWithText(ListTile, name));

  List<AssistantItem> assistants(AgentController agent) => agent.transcript.items.whereType<AssistantItem>().toList();
  String lastText(AgentController agent) =>
      assistants(agent).lastOrNull?.parts.whereType<TextPart>().map((t) => t.text).join() ?? '';
  /// A navigation-rail button (pages may show the same word, the rail comes first).
  Finder nav(String label) => find.text(label).first;

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

    final goChannel = const bool.hasEnvironment('E2E_MODEL') ? null : await copyGoChannel(p.join(temp.path, 'core'));
    final model = goChannel != null ? 'df-$goChannel/$goModel' : piModel;
    // ignore: avoid_print
    print('E2E model: $model');
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

    // The template step writes into the user's Pi prompts folder: never leave it behind.
    addTearDown(() {
      final leftover = File(p.join(Platform.environment['USERPROFILE'] ?? '', '.pi', 'agent', 'prompts', 'e2e周报.md'));
      if (leftover.existsSync()) leftover.deleteSync();
    });
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
    expect(find.descendant(of: find.byType(Sidebar), matching: find.byType(BreathingDot)), findsOneWidget, reason: 'A runs in the background');
    await shot(tester, '02_background_running');

    // 3. Work in B while A runs: a command that writes needs approval in "changes" mode.
    await sendMessage(tester, '用 pwsh 工具运行这条命令：Set-Content approval.txt approval-ok; Get-Content approval.txt ，然后告诉我输出。');
    await waitFor(tester, 'approval dialog', () => find.text('Agent 请求执行操作').evaluate().isNotEmpty, agent);
    expect(find.textContaining('Set-Content approval.txt'), findsWidgets);
    await shot(tester, '03_approval_dialog');
    await tester.tap(find.widgetWithText(FilledButton, '允许'));
    await tester.pump();
    await waitFor(tester, 'B reply', () => !agent.isRunning && lastText(agent).contains('approval-ok'), agent);
    expect(agent.transcript.tools.values.firstWhere((r) => r.name == 'pwsh').status, ToolStatus.done);
    await shot(tester, '04_parallel_sessions');

    // 4. Back to A: same process, still running or finished; stop it if needed.
    // By its current title: the auxiliary model may have renamed it by now.
    final titleA = agent.sidebar.firstWhere((e) => SessionStore.samePath(e.path, sessionA)).title;
    await tester.tap(sidebarTile(titleA).first);
    await waitFor(tester, 'A active', () => agent.active == runtimeA, agent);
    await idle(tester, const Duration(milliseconds: 500));
    expect(agent.runtimes.length, greaterThanOrEqualTo(2));
    // The model may have reached for a tool while writing; decline it.
    if (find.text('Agent 请求执行操作').evaluate().isNotEmpty) {
      await tester.tap(find.widgetWithText(OutlinedButton, '拒绝'));
      await tester.pump();
    }
    if (agent.isRunning) {
      await tester.tap(find.byTooltip('停止'));
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
    // With a long essay the question may not be built yet: drag up until its
    // fork button is, then bring the essay request's (the last one) into view.
    final forkQuestion = find.byTooltip('分叉为新会话：保留这条消息之前的内容，并把这条消息放回输入框供你修改');
    for (var i = 0; i < 50 && forkQuestion.evaluate().isEmpty; i++) {
      await tester.drag(messages, const Offset(0, 300));
      await tester.pump();
    }
    await tester.ensureVisible(forkQuestion.last);
    await tester.pump();
    await tester.tap(forkQuestion.last);
    await waitFor(tester, 'forked', () => agent.currentSessionPath != sessionA && agent.active == runtimeA, agent);
    await idle(tester);
    expect(tester.widget<TextField>(composer).controller!.text, contains('大海'));
    expect(agent.transcript.items.whereType<UserItem>().single.text, contains('hello.txt'));
    await shot(tester, '06_forked');

    // 6. Context panel and manual compaction in the fork. Pi summarizes whole
    //    earlier turns, so give it a second turn first.
    await sendMessage(tester, '只回复两个字：好的');
    await waitFor(tester, 'second turn', () => !agent.isRunning && agent.transcript.items.whereType<UserItem>().length == 2 && lastText(agent).isNotEmpty, agent);
    await tester.tap(find.byKey(const ValueKey('context-ring')));
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
    await tester.tap(find.byTooltip('Skills 与命令'));
    await tester.pumpAndSettle();
    await shot(tester, '09_skills');
    await tester.tap(find.byTooltip('关闭'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('设置'));
    await tester.pumpAndSettle();
    await tester.tap(settingsCategory('外观'));
    await tester.pumpAndSettle();
    expect(find.text('界面缩放'), findsOneWidget);
    await tester.tap(settingsCategory('安全与审批'));
    await tester.pumpAndSettle();
    expect(find.text('修改和命令需确认'), findsOneWidget);
    await shot(tester, '10_settings');
    await tester.pageBack();
    await tester.pumpAndSettle();

    await tester.tap(find.textContaining('工作区 · ').first);
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
    // Paper, not an empty widget: a bare window paints black, which looked
    // like a flash when switching workspaces (the step before).
    await tester.pumpWidget(ColoredBox(color: AppColors.light.background));
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

    // 9. Edit the message in place: the new version sits next to the old one.
    final starRequest = agent.transcript.items.whereType<UserItem>().last;
    await tester.runAsync(() => agent.editMessage(starRequest));
    await idle(tester);
    expect(tester.widget<TextField>(composer).controller!.text, contains('星空'));
    await sendMessage(tester, '改成写月亮，100 字以内，直接写，不要使用任何工具。');
    await waitFor(tester, 'moon reply', () => !agent.isRunning && lastText(agent).isNotEmpty && agent.transcript.items.whereType<UserItem>().last.text.contains('月亮'), agent);
    await waitFor(tester, 'version switcher', () => find.text('2/2').evaluate().isNotEmpty, agent);
    await shot(tester, '14_versions');
    // The switcher shows under the question and under its reply.
    await tester.tap(find.byTooltip('上一个版本').first);
    await waitFor(tester, 'back to version 1', () => agent.transcript.items.whereType<UserItem>().last.text.contains('星空') && find.text('1/2').evaluate().isNotEmpty, agent);
    await shot(tester, '15_version_1');

    // 9b. The run panel's branch tab: the star request and its moon rewrite
    //     both hang under the same point, and the star version is shown.
    await tester.tap(find.text('分支'));
    await waitFor(
      tester,
      'branch tree',
      () => find.textContaining('改成写月亮').evaluate().isNotEmpty && find.textContaining('1 处分支').evaluate().isNotEmpty,
      agent,
      timeout: const Duration(seconds: 30),
    );
    await shot(tester, '15b_branch_tree');
    await tester.tap(find.text('本次运行'));
    await tester.pumpAndSettle();

    // 10. Full-text search across sessions.
    final searchBox = find.byWidgetPredicate((w) => w is TextField && w.decoration?.hintText == '搜索所有会话');
    await tester.enterText(searchBox, '星空');
    await waitFor(tester, 'search hit', () => find.textContaining('我：', findRichText: true).evaluate().isNotEmpty, agent);
    await shot(tester, '16_search');
    await tester.enterText(searchBox, '');
    await idle(tester);

    // 11. Channels: the DeepSeek provider from Pi's config is listed and answers a test.
    await tester.tap(find.text('设置'));
    await tester.pumpAndSettle();
    await tester.tap(settingsCategory('模型与网关'));
    await tester.pumpAndSettle();
    await waitFor(tester, 'channels listed', () => find.text('来自 Pi 配置').evaluate().isNotEmpty, agent);
    await tester.tap(find.widgetWithText(TextButton, '测试').first);
    await waitFor(tester, 'channel ok', () => find.textContaining('可用 · ').evaluate().isNotEmpty, agent);
    await shot(tester, '17_channels');
    await tester.pageBack();
    await tester.pumpAndSettle();

    // 12. The dashboard counts today's model responses and shows the channel.
    await tester.tap(nav('仪表盘'));
    await waitFor(tester, 'dashboard loaded', () => find.textContaining('次回复').evaluate().isNotEmpty && find.textContaining('今天').evaluate().isNotEmpty, agent);
    await tester.tap(find.text('模型').last); // the breakdown by model
    await tester.pumpAndSettle();
    // The table is below the spending chart: scroll it into view (lists build only what is visible).
    final dashboardList = find.descendant(of: find.byType(DashboardPage), matching: find.byType(Scrollable)).first;
    await tester.scrollUntilVisible(find.text('花费按模型价格计算；没有填写价格的模型算 \$0，可以在渠道里补上价格。'), 200, scrollable: dashboardList);
    // The breakdown comes from the usage index, which may still be catching up with the session files.
    await waitFor(tester, 'model breakdown', () => find.textContaining('deepseek').evaluate().isNotEmpty, agent, timeout: const Duration(seconds: 30));
    await shot(tester, '18_dashboard');
    await tester.pageBack();
    await tester.pumpAndSettle();

    // 13. A temporary chat says so and is not saved.
    await tester.tap(find.byTooltip('临时对话：不保存记录，也不读写记忆'));
    await waitFor(tester, 'temporary chat', () => agent.active?.incognito == true && agent.isReady, agent);
    expect(find.textContaining('临时对话：不会保存记录'), findsOneWidget);
    await shot(tester, '19_temporary_chat');

    // 14. "Remember ..." saves a memory right away; the memory page lists it.
    await tester.tap(find.descendant(of: find.byType(Sidebar), matching: find.byIcon(Icons.add)));
    await waitFor(tester, 'normal session', () => agent.active?.incognito == false && agent.isReady, agent);
    await sendMessage(tester, '请记住：我写周报喜欢用表格。记住后只回复「好的」。');
    await waitFor(tester, 'remembered', () => !agent.isRunning && lastText(agent).isNotEmpty, agent);
    expect(agent.transcript.tools.values.where((r) => r.name == 'memory_save'), isNotEmpty, reason: describe(agent));
    await tester.tap(nav('记忆'));
    // Candidates from automatic extraction open first: switch to the library.
    Finder onMemoryPage(Finder f) => find.descendant(of: find.byType(MemoryPage), matching: f);
    await tester.pumpAndSettle();
    await tester.tap(onMemoryPage(find.text('记忆库')).first); // the panel entry; the section heading says it too
    await waitFor(tester, 'memory listed', () => onMemoryPage(find.textContaining('表格')).evaluate().isNotEmpty, agent);
    await tester.pumpAndSettle();
    await shot(tester, '20_memory_page');

    // 15. Save the request as a task template (drafted by the model), see it on the skills page.
    await tester.tap(nav('对话'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('更多操作'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('存为模板'));
    await waitFor(tester, 'template draft', () => find.text('保存任务模板').evaluate().isNotEmpty, agent, timeout: const Duration(minutes: 2));
    final nameField = find.byWidgetPredicate((w) => w is TextField && (w.decoration?.labelText ?? '').startsWith('模板名'));
    await tester.enterText(nameField, 'e2e周报');
    await tester.pump();
    await shot(tester, '21_template_draft');
    await tester.tap(find.widgetWithText(FilledButton, '保存'));
    await waitFor(tester, 'template saved', () => find.text('保存任务模板').evaluate().isEmpty, agent);
    await tester.tap(nav('技能'));
    await tester.pumpAndSettle();
    await tester.tap(find.descendant(of: find.byType(LibraryPage), matching: find.text('任务模板')));
    await waitFor(tester, 'template listed', () => find.descendant(of: find.byType(LibraryPage), matching: find.text('/e2e周报')).evaluate().isNotEmpty, agent);
    await shot(tester, '22_templates');
    await agent.backend.call('templates.remove', {'name': 'e2e周报'});
    await tester.tap(nav('对话'));
    await tester.pumpAndSettle();

    // 16. Desk: write a note, hand it to the agent with a pasted material; the
    // task runs in the chat, its file shows up as an artifact on the desk.
    await tester.tap(nav('书桌'));
    await waitFor(tester, 'desk', () => find.byTooltip('新写笺').evaluate().isNotEmpty, agent);
    await agent.backend.call('materials.add', {'cwd': agent.workspace, 'kind': 'text', 'title': '会议纪要', 'content': '周三和设计团队开会，决定下周一上线新版首页。'});
    await tester.tap(find.byTooltip('新写笺'));
    await waitFor(tester, 'note editor', () => find.text('交给 Agent').evaluate().isNotEmpty, agent);
    await tester.enterText(
      find.byWidgetPredicate((w) => w is TextField && w.decoration?.hintText?.startsWith('用 Markdown') == true),
      '# 上线安排\n根据资料写一份待办清单，保存为 todo.md 文件（用 write 工具），然后用一句话回复。',
    );
    await idle(tester, const Duration(seconds: 1));
    await tester.tap(find.text('交给 Agent'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('自己写要求'));
    await tester.pump();
    await tester.enterText(find.byWidgetPredicate((w) => w is TextField && w.decoration?.hintText == '写下你的要求'), '按写笺里的要求做。');
    await tester.tap(find.byType(Checkbox).first);
    await tester.pump();
    await shot(tester, '23_hand_off');
    await tester.tap(find.widgetWithText(FilledButton, '开始'));
    await waitFor(tester, 'task started', () => agent.section == AppSection.chat && agent.isRunning, agent);
    // Writing a file (and any command the model runs first) needs approval in "changes" mode.
    final approve = find.widgetWithText(FilledButton, '允许');
    while (agent.isRunning || lastText(agent).isEmpty) {
      await waitFor(tester, 'approval or done', () => approve.evaluate().isNotEmpty || (!agent.isRunning && lastText(agent).isNotEmpty), agent);
      if (approve.evaluate().isNotEmpty) {
        await tester.tap(approve.first);
        await tester.pump();
        await idle(tester);
      }
    }
    expect(File(p.join(agent.workspace, 'todo.md')).existsSync(), isTrue, reason: describe(agent));
    await waitFor(tester, 'run summary', () => find.textContaining('本次运行').evaluate().isNotEmpty, agent);
    expect(find.textContaining('写笺任务'), findsOneWidget);
    await shot(tester, '24_task_in_chat');
    await tester.tap(nav('书桌'));
    await tester.pumpAndSettle();
    await waitFor(tester, 'artifact on desk', () => find.descendant(of: find.byType(DeskPage), matching: find.text('todo.md')).evaluate().isNotEmpty, agent);
    await shot(tester, '25_desk');
    await tester.tap(nav('任务'));
    await waitFor(tester, 'tasks page', () => find.text('全部任务').evaluate().isNotEmpty, agent);
    await tester.tap(find.text('全部任务'));
    await waitFor(tester, 'task listed', () => find.descendant(of: find.byType(TasksPage), matching: find.text('完成')).evaluate().isNotEmpty, agent);
    await shot(tester, '26_tasks');
    await tester.tap(nav('对话'));
    await tester.pumpAndSettle();

    // 17. A scheduled task run on demand: it runs in the background (its own
    // session), the run record shows the result and the delivery.
    final schedule = asJsonMap(await agent.backend.call('schedules.save', {
      'name': 'e2e 报时',
      'prompt': '用一句话说出现在大概是一天中的什么时段（上午、下午或晚上）。不要使用任何工具。',
      'cwd': agent.workspace,
      'kind': 'report',
      'trigger': {'type': 'interval', 'everyMs': 24 * 3600 * 1000},
    }));
    await tester.tap(nav('任务'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('定时'));
    await waitFor(tester, 'schedule listed', () => find.text('e2e 报时').evaluate().isNotEmpty, agent);
    await tester.pumpAndSettle(); // the tab switch animates
    await tester.tap(find.widgetWithText(OutlinedButton, '立即运行'));
    String? runStatus;
    await waitFor(tester, 'scheduled run done', () {
      unawaited(agent.backend.call('schedules.get', {'id': schedule['id']}).then((v) {
        final runs = asJsonMap(v)['runs'] as List? ?? const [];
        runStatus = runs.isEmpty ? null : (runs.first as Map)['status'] as String?;
      }));
      return runStatus == 'done' || runStatus == 'failed';
    }, agent);
    expect(runStatus, 'done');
    await idle(tester, const Duration(seconds: 1));
    await shot(tester, '27_schedules');
    await tester.tap(find.descendant(of: find.byType(SchedulesTab), matching: find.byTooltip('操作')).first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('执行记录'));
    await waitFor(tester, 'history', () => find.text('「e2e 报时」的执行记录').evaluate().isNotEmpty, agent);
    await tester.pumpAndSettle();
    await shot(tester, '28_schedule_history');
    await tester.tap(find.widgetWithText(TextButton, '关闭'));
    await tester.pumpAndSettle();
    await agent.backend.call('schedules.remove', {'id': schedule['id']});

    // 18. web_fetch reads a page without asking for approval.
    await tester.tap(nav('对话'));
    await tester.pumpAndSettle();
    await tester.tap(find.descendant(of: find.byType(Sidebar), matching: find.byIcon(Icons.add)));
    await waitFor(tester, 'fresh session', () => agent.isReady && agent.transcript.items.isEmpty, agent);
    await sendMessage(tester, '用 web_fetch 工具读取 https://example.com ，然后直接根据读到的内容只回复页面的标题，不要运行命令。');
    // The model may still want a command afterwards (it asks, as it should):
    // decline it, but web_fetch itself must never ask.
    final asking = find.text('Agent 请求执行操作');
    while (agent.isRunning || asking.evaluate().isNotEmpty || lastText(agent).isEmpty) {
      await waitFor(tester, 'fetched', () => asking.evaluate().isNotEmpty || (!agent.isRunning && lastText(agent).isNotEmpty), agent);
      if (asking.evaluate().isNotEmpty) {
        expect(find.textContaining('web_fetch'), findsNothing, reason: 'web_fetch asked for approval');
        await tester.tap(find.widgetWithText(OutlinedButton, '拒绝').first);
        await tester.pump();
      }
    }
    expect(agent.transcript.tools.values.where((r) => r.name == 'web_fetch' && r.status == ToolStatus.done), isNotEmpty, reason: describe(agent));
    // The title is "Example Domain"; the model sometimes translates it anyway.
    expect(lastText(agent).toLowerCase(), anyOf(contains('example'), contains('示例')));
    await shot(tester, '29_web_fetch');

    // 19. Images reach the model (v0.1.1 bug: Pi's "block images" setting
    //     replaced them with a note), and the reply has its own actions.
    await tester.tap(find.descendant(of: find.byType(Sidebar), matching: find.byIcon(Icons.add)));
    await waitFor(tester, 'fresh session for the image', () => agent.isReady && agent.transcript.items.isEmpty, agent);
    final red = await tester.runAsync(() async {
      final recorder = ui.PictureRecorder();
      Canvas(recorder).drawRect(const Rect.fromLTWH(0, 0, 64, 64), Paint()..color = const Color(0xFFDC1414));
      final image = await recorder.endRecording().toImage(64, 64);
      final png = await image.toByteData(format: ui.ImageByteFormat.png);
      return base64Encode(png!.buffer.asUint8List());
    });
    await tester.runAsync(() => agent.send('这张图片是什么颜色？只回复颜色的中文名称。', images: [ImageBlock(data: red!, mimeType: 'image/png')]));
    await waitFor(tester, 'image reply', () => !agent.isRunning && lastText(agent).isNotEmpty, agent);
    expect(lastText(agent), contains('红'), reason: describe(agent));
    await tester.pumpAndSettle();
    expect(find.byTooltip('复制回复（Markdown 原文）'), findsOneWidget, reason: 'the latest reply shows its actions');
    await shot(tester, '30_image_reply_actions');

    // 20. Ctrl + plus zooms the whole window; Ctrl + 0 restores it.
    Future<void> ctrl(LogicalKeyboardKey key) async {
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(key);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      await idle(tester);
    }

    await ctrl(LogicalKeyboardKey.equal);
    await ctrl(LogicalKeyboardKey.equal);
    expect(agent.zoom, 1.25);
    await shot(tester, '31_zoom_125');
    await ctrl(LogicalKeyboardKey.digit0);
    expect(agent.zoom, 1.0);

    // 21. Minimal mode: a new session with only the persistent PowerShell; state
    // persists between commands; a read-only command needs no approval.
    await agent.selectAgentMode('minimal');
    await waitFor(tester, 'minimal session', () => agent.isReady && agent.agentMode == 'minimal' && agent.transcript.items.isEmpty, agent);
    await sendMessage(tester, r'先用 pwsh 执行 $n = 6 * 7 ，再用另一次 pwsh 调用输出 $n 的值，最后只回复这个数字。');
    // Assigning a variable is not read-only, so the commands may ask first.
    final approve21 = find.widgetWithText(FilledButton, '允许');
    while (agent.isRunning || approve21.evaluate().isNotEmpty || lastText(agent).isEmpty) {
      await waitFor(tester, 'approval or minimal reply', () => approve21.evaluate().isNotEmpty || (!agent.isRunning && lastText(agent).isNotEmpty), agent);
      if (approve21.evaluate().isNotEmpty) {
        await tester.tap(approve21.first);
        await tester.pump();
        await idle(tester);
      }
    }
    expect(lastText(agent), contains('42'), reason: describe(agent));
    expect(agent.transcript.tools.values.every((r) => r.name == 'pwsh'), isTrue, reason: describe(agent));
    await shot(tester, '32_minimal_mode');

    // 22. Plan mode (standard): the agent presents a plan for review instead of acting.
    await agent.selectAgentMode('standard');
    await waitFor(tester, 'standard session', () => agent.isReady && agent.agentMode == 'standard' && agent.transcript.items.isEmpty, agent);
    await idle(tester); // let the composer redraw with the plan-mode button
    await tester.tap(find.byTooltip('计划模式：先让 Agent 给出计划，你批准后再动手'));
    await waitFor(tester, 'plan mode on', () => agent.planMode, agent);
    await sendMessage(tester, '在工作区新建 plan-demo.txt，内容是 hello。');
    // Not 'not running' alone: right after sending, the run has not started yet.
    // While planning the model may look around with a command that asks first: allow it.
    final reviewing = find.text('请审阅 Agent 的计划');
    final approvePlanning = find.widgetWithText(FilledButton, '允许');
    while (reviewing.evaluate().isEmpty && (agent.isRunning || lastText(agent).isEmpty)) {
      await waitFor(tester, 'plan review', () => reviewing.evaluate().isNotEmpty || approvePlanning.evaluate().isNotEmpty || (!agent.isRunning && lastText(agent).isNotEmpty), agent);
      if (approvePlanning.evaluate().isNotEmpty) {
        await tester.tap(approvePlanning.first);
        await tester.pump();
        await idle(tester);
      }
    }
    expect(find.text('请审阅 Agent 的计划'), findsOneWidget, reason: describe(agent));
    await shot(tester, '33_plan_review');
    await tester.tap(find.widgetWithText(FilledButton, '批准，开始执行'));
    await tester.pump();
    final approve22 = find.widgetWithText(FilledButton, '允许');
    while (agent.isRunning || approve22.evaluate().isNotEmpty) {
      await waitFor(tester, 'approval or done', () => approve22.evaluate().isNotEmpty || !agent.isRunning, agent);
      if (approve22.evaluate().isNotEmpty) {
        await tester.tap(approve22.first);
        await tester.pump();
        await idle(tester);
      }
    }
    expect(agent.planMode, isFalse);
    expect(File(p.join(agent.workspace, 'plan-demo.txt')).existsSync(), isTrue, reason: describe(agent));
    await shot(tester, '34_plan_done');

    // 23. A model group: its first channel has an invalid key, so the
    //     conversation moves on to DeepSeek and the window says so.
    final slash = model.indexOf('/');
    final modelId = model.substring(slash + 1);
    final bad = asJsonMap(
      await agent.backend.call('gateway.saveChannel', {
        'name': '坏 Key 渠道',
        'platform': 'deepseek',
        'api': 'openai-completions',
        'baseUrl': 'https://api.deepseek.com/v1',
        'models': [
          {'id': modelId},
        ],
        'keys': [
          {'secret': 'sk-invalid-dreamflutter-e2e'},
        ],
      }),
    );
    await agent.backend.call('gateway.saveGroup', {
      'id': 'e2e',
      'name': '实测组',
      'entries': [
        {'channel': bad['id'], 'model': modelId, 'priority': 0},
        {'channel': goChannel ?? 'pi:${model.substring(0, slash)}', 'model': modelId, 'priority': 1},
      ],
    });
    await waitFor(tester, 'group in the model menu', () => agent.models.any((m) => m.key == 'dreamflutter/e2e'), agent);
    await tester.tap(find.byWidgetPredicate((w) => w is Tooltip && (w.message ?? '').startsWith('模型：')).first);
    await tester.pumpAndSettle();
    expect(find.text('模型组'), findsOneWidget, reason: 'groups come first, under their own heading');
    await shot(tester, '35_model_menu');
    await tester.tap(find.text('实测组').last);
    await waitFor(tester, 'group selected', () => agent.model?.key == 'dreamflutter/e2e', agent);
    // Toasts as sent (a snackbar can wait behind earlier ones).
    final toasts = <String>[];
    final toastSub = agent.toasts.listen(toasts.add);
    final answersBefore = assistants(agent).where((a) => a.stopReason != 'error').length;
    await sendMessage(tester, '只回复两个字：你好');
    // A new answer, not the previous step's: right after sending, the run has not started yet.
    await waitFor(
      tester,
      'answer through the group',
      () => !agent.isRunning && assistants(agent).where((a) => a.stopReason != 'error').length > answersBefore && lastText(agent).isNotEmpty,
      agent,
    );
    await toastSub.cancel();
    expect(toasts.any((t) => t.startsWith('已从「坏 Key 渠道')), isTrue, reason: 'the window announces the switch: $toasts');
    expect(assistants(agent).last.stopReason, isNot('error'), reason: describe(agent));
    await shot(tester, '36_model_group');

    await agent.shutdownCore();
    agent.dispose();
    await idle(tester, const Duration(seconds: 2));
  }, timeout: const Timeout(Duration(minutes: 15)));
}
