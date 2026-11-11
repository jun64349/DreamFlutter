import 'dart:io';

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/ui/greetings.dart' show allGreetings;
import 'package:dreamflutter/ui/run_summary.dart' show RunPanel;
import 'package:dreamflutter/ui/sidebar.dart' show Sidebar, SidebarWorkspaceButton;
import 'package:dreamflutter/ui/window_frame.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';

/// The 0.4 window frame (design option 3 with option 1's title bar): the title
/// bar's breadcrumb and workspace menu, the one sidebar, and the details panel.
void main() {
  late FakeBackend backend;
  late AgentController agent;
  late Directory root;
  late Directory thesis;
  late Directory other;

  Future<void> startApp(WidgetTester tester, {Size size = const Size(1400, 900), Map<String, Object> prefs = const {}}) async {
    await tester.binding.setSurfaceSize(size);
    root = Directory.systemTemp.createTempSync('df_frame_');
    thesis = Directory(p.join(root.path, '毕设论文'))..createSync();
    other = Directory(p.join(root.path, '周报'))..createSync();
    SharedPreferences.setMockInitialValues({
      'workspace': thesis.path,
      'recentWorkspaces': [thesis.path, other.path],
      'onboarded': true,
      ...prefs,
    });
    backend = FakeBackend();
    agent = AgentController(
      preferences: await tester.runAsync(Preferences.load) as Preferences,
      sessionStore: SessionStore(sessionsDir: (Directory(p.join(root.path, 'sessions'))..createSync()).path),
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
    root.deleteSync(recursive: true);
  });

  Finder inTitleBar(Finder finder) => find.descendant(of: find.byType(AppTitleBar), matching: finder);

  Finder inSidebar(Finder finder) => find.descendant(of: find.byType(SidebarWorkspaceButton), matching: finder);

  testWidgets('the title bar says where you are; the workspace is chosen in the sidebar (0.8.2)', (tester) async {
    await startApp(tester);
    expect(inTitleBar(find.text('工作台')), findsOneWidget);
    expect(inTitleBar(find.text('毕设论文')), findsNothing, reason: '0.8.2: the workspace moved to the sidebar');
    expect(inSidebar(find.text('毕设论文')), findsOneWidget);
    expect(inTitleBar(find.text('新对话')), findsOneWidget, reason: 'the conversation\'s title');
    expect(find.text('毕设论文 的对话'), findsNothing, reason: 'the workspace is already named in the top bar');
    // The buttons sit at the right edge, whatever the breadcrumb's length (v0.4.0: a gap of a sixth of the window after them).
    final bar = tester.getRect(find.byType(AppTitleBar));
    expect(tester.getRect(find.byTooltip(RegExp('^详情')).first).right, greaterThan(bar.right - 16));

    // The list of workspaces is read from disk after start.
    for (var i = 0; i < 100 && agent.recentWorkspaces.isEmpty; i++) {
      await settle(tester);
    }
    expect(agent.recentWorkspaces, contains(other.path));
    await tester.tap(inSidebar(find.text('毕设论文')));
    await tester.pumpAndSettle();
    expect(find.text('切换工作区'), findsOneWidget);
    expect(find.text(thesis.path), findsOneWidget);
    expect(find.text(other.path), findsOneWidget);
    expect(find.text('打开文件夹作为工作区…'), findsOneWidget);

    await tester.tap(find.text('周报'));
    await settle(tester);
    expect(agent.workspace, other.path);
    expect(inSidebar(find.text('周报')), findsOneWidget);
    expect(find.text('切换工作区'), findsNothing, reason: 'the menu closes once a workspace is picked');
  });

  testWidgets('Ctrl+O and the sidebar\'s switch button open the same menu, from any page', (tester) async {
    await startApp(tester);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyO);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pumpAndSettle();
    expect(find.text('切换工作区'), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.text('切换工作区'), findsNothing);

    // From the memory page: back to the workbench with the menu open.
    await tester.tap(find.byTooltip(RegExp('^记忆')));
    await settle(tester);
    expect(agent.section, AppSection.memory);
    expect(inTitleBar(find.text('记忆')), findsOneWidget);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyO);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pumpAndSettle();
    expect(agent.section, AppSection.chat);
    expect(find.text('切换工作区'), findsOneWidget);
  });

  testWidgets('the details open when asked: beside a wide conversation, over a narrow one', (tester) async {
    await startApp(tester);
    expect(find.byType(RunPanel), findsNothing, reason: 'closed until asked for');

    await tester.tap(find.byTooltip(RegExp('^详情')));
    await settle(tester);
    expect(find.byType(RunPanel), findsOneWidget);
    expect(find.text('这个对话'), findsOneWidget);
    expect(find.text('常用操作'), findsOneWidget); // 0.8.1 R.3
    expect(find.text('刷新记忆快照'), findsNothing);
    final panel = tester.getRect(find.byType(RunPanel));
    final input = tester.getRect(find.byWidgetPredicate((w) => w is TextField && w.decoration?.hintText == '说点什么…'));
    expect(input.right, lessThanOrEqualTo(panel.left), reason: 'a wide window docks the panel beside the conversation');

    await tester.binding.setSurfaceSize(const Size(1000, 800));
    await tester.pumpAndSettle();
    final narrowPanel = tester.getRect(find.byType(RunPanel));
    final narrowInput = tester.getRect(find.byWidgetPredicate((w) => w is TextField && w.decoration?.hintText == '说点什么…'));
    expect(narrowInput.right, greaterThan(narrowPanel.left), reason: 'a narrow one lays it over the conversation');

    await tester.tap(find.byTooltip('收起详情').first);
    await settle(tester);
    expect(find.byType(RunPanel), findsNothing);
    expect(agent.preferences.runPanelOpen, isFalse);
  });

  testWidgets('the details\' overview is in blocks that fold, and a long run shows its latest steps', (tester) async {
    await startApp(tester);
    backend.handlers['runs.list'] = (_) => [
      {'id': 'r1', 'status': 'done', 'toolCalls': 9, 'cost': 0.031, 'inputTokens': 5000, 'outputTokens': 800, 'startedAt': 1, 'endedAt': 52001, 'files': [p.join(thesis.path, '对比.docx')]},
    ];
    backend.handlers['runs.steps'] = (_) => [
      for (var i = 1; i <= 9; i++) {'kind': 'tool', 'name': 'read', 'summary': '报告$i.md', 'status': 'done', 'durationMs': 120},
    ];
    await tester.tap(find.byTooltip(RegExp('^详情')));
    await settle(tester);
    expect(find.text('改动'), findsOneWidget, reason: '0.8.2: changed and created files are one list, each marked');
    expect(find.textContaining('对比.docx'), findsOneWidget);
    expect(find.text('上下文与花费'), findsNothing);
    await tester.tap(find.byTooltip('收起详情').first);
    await settle(tester);
    await tester.tap(find.byTooltip(RegExp('^详情')));
    await settle(tester);
    expect(find.text('改动'), findsOneWidget, reason: '0.8.2: changed and created files are one list, each marked');
    expect(find.text('读取  报告9.md'), findsNothing);
  });

  testWidgets('无痕 is picked in the input box, next to the two modes (0.4, roadmap 4.6)', (tester) async {
    await startApp(tester);
    expect(find.text('标准模式'), findsNothing);
    expect(find.text('极简模式'), findsNothing);
    await tester.tap(find.byTooltip('无痕'));
    await settle(tester);
    expect(agent.active!.incognito, isTrue);
    expect(backend.pis.last.target.agentMode, 'minimal');
    expect(find.textContaining('无痕对话：极简模式，不保存记录'), findsNothing);
    expect(find.byTooltip('无痕对话没有详情'), findsOneWidget);
    expect(find.descendant(of: find.byTooltip('无痕'), matching: find.text('无痕')), findsOneWidget);
  });

  testWidgets('a new conversation shows the butterfly and one greeting, nothing else (0.4, v0.3.1 test 5)', (tester) async {
    await startApp(tester);
    final greetings = allGreetings.toSet();
    expect(find.byWidgetPredicate((w) => w is Text && greetings.contains(w.data)), findsOneWidget);
    expect(find.text('整理一份周报'), findsNothing, reason: 'no suggestion cards');
    expect(find.textContaining('Agent 会在工作区里读写文件'), findsNothing, reason: 'no explanation');
  });

  testWidgets('the sidebar is as wide as it was dragged, also after a restart', (tester) async {
    await startApp(tester);
    final before = tester.getSize(find.byType(Sidebar)).width;
    final handle = find.descendant(of: find.byType(Sidebar), matching: find.byType(ResizeHandle));
    await tester.drag(handle, const Offset(80, 0));
    await settle(tester);
    expect(agent.preferences.sidebarWidth, closeTo(Preferences.sidebarWidths.initial + 80, 1));
    expect(tester.getSize(find.byType(Sidebar)).width, closeTo(before + 80, 1));

    // Not past its limits.
    await tester.drag(handle, const Offset(-600, 0));
    await settle(tester);
    expect(agent.preferences.sidebarWidth, Preferences.sidebarWidths.min);
  });
}
