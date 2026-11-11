import 'dart:io';
import 'dart:ui' show PointerDeviceKind;

import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/artifact_widgets.dart';
import 'package:dreamflutter/ui/chat_view.dart';
import 'package:dreamflutter/ui/composer.dart';
import 'package:dreamflutter/ui/gateway_pages.dart';
import 'package:dreamflutter/ui/memory_page.dart';
import 'package:dreamflutter/ui/mini_charts.dart';
import 'package:dreamflutter/ui/providers_page.dart' show apiLabels;
import 'package:dreamflutter/ui/run_summary.dart';
import 'package:dreamflutter/ui/shell_widgets.dart';
import 'package:dreamflutter/ui/spending_page.dart';
import 'package:flutter/gestures.dart' show kSecondaryMouseButton;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';
import 't87_fixture.dart';
import 't87_memory_test.dart' show pumpT87;

class _Agent extends AgentController {
  _Agent(Preferences preferences, Directory root, FakeBackend backend)
    : super(preferences: preferences, sessionStore: SessionStore(sessionsDir: root.path), backend: backend);

  final opened = <String>[];
  final revealed = <String>[];
  @override
  Future<void> openFile(String path) async => opened.add(path);
  @override
  Future<void> revealFile(String path) async => revealed.add(path);
}

void main() {
  late Directory root;
  late FakeBackend backend;
  late _Agent agent;

  Widget app(AgentController owner, Widget home) => AgentScope(
    controller: owner, child: MaterialApp(theme: buildTheme(Brightness.light), home: home),
  );

  Future<void> setup(WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(1500, 1050));
    root = Directory.systemTemp.createTempSync('df_t94_');
    backend = FakeBackend();
    SharedPreferences.setMockInitialValues({'workspace': root.path, 'onboarded': true});
    agent = _Agent((await tester.runAsync(Preferences.load))!, root, backend);
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      agent.dispose();
      root.deleteSync(recursive: true);
    });
  }

  final channel = GatewayChannel.fromJson({
    'id': 'channel', 'name': '测试渠道', 'source': 'df', 'kind': 'payg',
    'api': 'openai-completions', 'baseUrl': 'https://example.invalid/v1', 'lowBalance': 2,
  });
  Finder field(String label) => find.byWidgetPredicate((w) => w is TextField &&
    (w.decoration?.labelText == label || w.decoration?.hintText == label));
  final saveButton = find.widgetWithText(FilledButton, '保存');

  Future<void> editor(WidgetTester tester) async {
    await setup(tester);
    backend.handlers['gateway.platforms'] = (_) => [
      {'id': 'relay', 'name': '示例服务商', 'kind': 'relay', 'endpoints': [
        {'api': 'openai-completions', 'baseUrl': 'https://relay.example.invalid/v1'},
      ]},
    ];
    backend.handlers['gateway.saveChannel'] = (_) => {'id': 'channel'};
    await tester.pumpWidget(app(agent, Scaffold(body: Builder(builder: (context) =>
      TextButton(onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => ChannelEditorPage(existing: channel),
      )), child: const Text('打开编辑器')),
    ))));
    await tester.tap(find.text('打开编辑器'));
    await tester.pumpAndSettle();
  }

  Future<void> choose(WidgetTester tester, String before, String after) async {
    await tester.tap(find.widgetWithText(TextButton, before));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(MenuItemButton, after));
    await tester.pumpAndSettle();
  }

  testWidgets('T94 channel options independently enable save and reach the backend', (tester) async {
    await editor(tester);
    Future<void> check(String key, Object value, Future<void> Function() edit) async {
      expect(tester.widget<FilledButton>(saveButton).onPressed, isNull);
      final calls = backend.callsTo('gateway.saveChannel').length;
      await edit();
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(saveButton).onPressed, isNotNull);
      await tester.tap(saveButton);
      await tester.pumpAndSettle();
      expect(backend.callsTo('gateway.saveChannel'), hasLength(calls + 1));
      expect(backend.callsTo('gateway.saveChannel').last[key], value);
    }
    await check('kind', 'plan', () => choose(tester, '按量付费', '编程套餐'));
    await check('platform', 'relay', () => tester.tap(find.text('示例服务商')));
    await check('api', 'anthropic-messages', () =>
      choose(tester, apiLabels['openai-completions']!, apiLabels['anthropic-messages']!));
    await check('lowBalance', 7.5, () async {
      await tester.ensureVisible(field('不提醒'));
      await tester.enterText(field('不提醒'), '7.5');
    });
  });

  testWidgets('T94 unsaved channel back offers continue, discard, and save', (tester) async {
    await editor(tester);
    Future<void> back(String label) async {
      await tester.pump();
      await tester.tap(find.byType(BackButton));
      await tester.pumpAndSettle();
      final dialog = find.byType(AlertDialog);
      expect(find.descendant(of: dialog, matching: find.text('改动还没保存')), findsOneWidget);
      await tester.tap(find.descendant(of: dialog, matching: find.text(label)));
      await tester.pumpAndSettle();
    }
    await tester.enterText(field('渠道名称'), '本地草稿');
    await back('继续编辑');
    expect(tester.widget<TextField>(field('渠道名称')).controller!.text, '本地草稿');
    expect(backend.callsTo('gateway.saveChannel'), isEmpty);
    await back('不保存');
    expect(find.byType(ChannelEditorPage), findsNothing);
    expect(backend.callsTo('gateway.saveChannel'), isEmpty);
    await tester.tap(find.text('打开编辑器'));
    await tester.pumpAndSettle();
    await tester.enterText(field('渠道名称'), '保留草稿');
    await back('保存');
    expect(find.byType(ChannelEditorPage), findsNothing);
    expect(backend.callsTo('gateway.saveChannel').single['name'], '保留草稿');
  });

  testWidgets('T94 connection test saves first and shows a plain 404 with hover detail', (tester) async {
    await editor(tester);
    const raw = 'HTTP 404: {"error":"unknown endpoint"}';
    backend.handlers['gateway.testChannel'] = (_) => {'ok': false, 'error': raw};
    await tester.enterText(field('渠道名称'), '先保存这个名称');
    await tester.tap(find.text('测试连接'));
    await tester.pumpAndSettle();
    expect(backend.calls.where((call) => const ['gateway.saveChannel', 'gateway.testChannel'].contains(call.method))
      .map((call) => call.method), ['gateway.saveChannel', 'gateway.testChannel']);
    expect(backend.callsTo('gateway.saveChannel').single['name'], '先保存这个名称');
    expect(backend.callsTo('gateway.testChannel').single['channel'], 'channel');
    final result = find.text('服务器找不到这个地址：检查接口地址和接口类型');
    expect(result, findsOneWidget);
    expect(tester.getCenter(result).dy, closeTo(tester.getCenter(find.text('测试连接')).dy, 2));
    expect(find.text(raw), findsNothing);
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    addTearDown(mouse.removePointer);
    await mouse.moveTo(tester.getCenter(result));
    await tester.pump(const Duration(milliseconds: 700));
    await tester.pumpAndSettle();
    expect(find.text(raw), findsOneWidget);
  });

  Future<String> files(WidgetTester tester) async {
    await setup(tester);
    final changed = File('${root.path}${Platform.pathSeparator}changed.txt')..writeAsStringSync('current content');
    final created = File('${root.path}${Platform.pathSeparator}created.txt')..writeAsStringSync('new content');
    backend.handlers.addAll({
      'runs.list': (_) => [{'id': 'run', 'files': [changed.path]}],
      'tasks.forSession': (_) => {'id': 'task'},
      'artifacts.list': (_) => [{'path': created.path}],
    });
    await tester.runAsync(agent.init);
    await agent.setRunPanelOpen(true);
    await tester.pumpWidget(app(agent, const Scaffold(body: ChatView())));
    await pumpT87(tester);
    await tester.pumpAndSettle();
    return changed.path;
  }

  testWidgets('T94 Files groups changes and creations and opens a docked preview', (tester) async {
    final changed = await files(tester);
    final panel = find.byType(RunPanel);
    final fileBlock = find.ancestor(of: find.text('文件'), matching: find.byType(Column)).first;
    for (final text in ['changed.txt', 'created.txt', '改动', '新建']) {
      expect(find.descendant(of: fileBlock, matching: find.text(text)), findsOneWidget);
    }
    final oldWidth = tester.getSize(panel).width;
    final oldComposer = tester.getSize(find.byType(Composer)).width;
    await tester.tap(find.text('changed.txt'));
    await tester.pumpAndSettle();
    expect(agent.panelPreviewing.value, isTrue);
    expect(tester.getSize(panel).width, greaterThan(oldWidth));
    expect(tester.getSize(find.byType(Composer)).width, lessThan(oldComposer));
    expect(find.descendant(of: panel, matching: find.byKey(ValueKey('diff-$changed'))), findsOneWidget);
    await tester.tap(find.text('现在的内容'));
    await tester.runAsync(() async {
      await tester.pump();
      await Future<void>.delayed(const Duration(milliseconds: 40));
    });
    await pumpT87(tester);
    expect(find.descendant(of: panel, matching: find.byType(FilePreviewBody)), findsOneWidget);
    final previewText = find.descendant(of: find.byType(FilePreviewBody), matching: find.byType(SelectableText));
    expect(tester.widget<SelectableText>(previewText).data, 'current content');
    await tester.tap(find.text('改了什么'));
    await tester.pumpAndSettle();
    expect(find.byKey(ValueKey('diff-$changed')), findsOneWidget);
    await tester.tap(find.byTooltip('回到这个对话'));
    await tester.pumpAndSettle();
    expect(agent.panelPreviewing.value, isFalse);
    expect(tester.getSize(panel).width, oldWidth);
    expect(tester.getSize(find.byType(Composer)).width, oldComposer);
  });

  testWidgets('T94 Files right click offers the six actions and dispatches the shell actions', (tester) async {
    final path = await files(tester);
    Future<void> menu() async {
      await tester.tap(find.text('changed.txt'), buttons: kSecondaryMouseButton, kind: PointerDeviceKind.mouse);
      await tester.pumpAndSettle();
    }
    await menu();
    for (final label in ['预览', '看改了什么', '用默认程序打开', '打开所在文件夹', '另存为…', '复制路径']) {
      expect(find.widgetWithText(ListTile, label), findsOneWidget);
    }
    await tester.tap(find.text('用默认程序打开'));
    await tester.pumpAndSettle();
    expect(agent.opened, [path]);
    expect(agent.revealed, isEmpty);
    await menu();
    await tester.tap(find.text('打开所在文件夹'));
    await tester.pumpAndSettle();
    expect(agent.revealed, [path]);
  });

  testWidgets('T94 home centers the quotation and places its attribution below', (tester) async {
    await setup(tester);
    await tester.runAsync(agent.init);
    await tester.pumpWidget(app(agent, const Scaffold(body: ChatView())));
    await tester.pumpAndSettle();
    final quote = tester.widget<ShellQuoteLine>(find.byType(ShellQuoteLine));
    final axis = tester.getCenter(find.byType(ChatView)).dx;
    final line = find.text(quote.line);
    final source = find.text(quote.source);
    expect(tester.getCenter(line).dx, closeTo(axis, 1));
    expect(tester.getCenter(source).dx, closeTo(axis, 1));
    expect(tester.getTopLeft(source).dy, greaterThan(tester.getBottomLeft(line).dy));
    final greeting = find.byType(ShellGreeting);
    final label = find.descendant(of: greeting, matching: find.byType(Text));
    expect(tester.getCenter(greeting).dx, closeTo(axis, 1));
    final paragraph = tester.widget<Text>(label);
    final left = tester.getTopLeft(label).dx - tester.getTopLeft(greeting).dx;
    expect(left, greaterThan(0));
    expect(left, closeTo(paragraph.style!.letterSpacing!, 0.01));
  });

  testWidgets('T94 spending charts change measure and show values on hover', (tester) async {
    await setup(tester);
    final now = DateTime.now();
    final today = '${now.year}-${now.month.toString().padLeft(2, '0')}-${now.day.toString().padLeft(2, '0')}';
    backend.handlers['ledger.summary'] = (params) => {'rows': [
      {'period': today, 'key': params['groupBy'] == 'model' ? 'test/m' : 'conversation',
        'requests': 4, 'amounts': {'USD': 1.25}},
    ]};
    await tester.pumpWidget(app(agent, const SpendingPage()));
    await tester.pumpAndSettle();
    final bars = find.byType(DayBarChart);
    final rings = find.byType(DonutChart);
    expect(tester.widget<DayBarChart>(bars).values, [...List.filled(29, 0.0), 1.25]);
    expect(tester.widgetList<DonutChart>(rings).map((ring) => ring.values), [[1.25], [1.25]]);
    expect(find.text('本月按用途'), findsOneWidget);
    expect(find.text('本月按模型'), findsOneWidget);
    await tester.tap(find.text('按次数'));
    await tester.pumpAndSettle();
    expect(tester.widget<DayBarChart>(bars).values.last, 4);
    expect(tester.widgetList<DonutChart>(rings).map((ring) => ring.values), [[4.0], [4.0]]);
    final paint = find.descendant(of: bars, matching: find.byType(CustomPaint)).first;
    final bounds = tester.getRect(paint);
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    addTearDown(mouse.removePointer);
    await mouse.moveTo(Offset(bounds.right - 2, bounds.center.dy));
    await tester.pumpAndSettle();
    final label = '${now.month}月${now.day}日';
    expect(find.text('$label · 4 次'), findsOneWidget);
    await tester.tap(find.text('按金额'));
    await tester.pumpAndSettle();
    expect(find.text('$label · \$1.25'), findsOneWidget);
  });

  testWidgets('T94 memory search and all four group chips filter entries and update counts', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1100, 900));
    final fixture = (await tester.runAsync(T87Fixture.create))!;
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(fixture.dispose);
    });
    await tester.pumpWidget(app(fixture.agent, const Scaffold(body: MemoryPage())));
    await pumpT87(tester);
    final entries = ['you', 'project', 'old', 'own'];
    void visible(List<String> expected) {
      for (final id in entries) {
        expect(find.byKey(ValueKey('memory-content-$id')), expected.contains(id) ? findsOneWidget : findsNothing);
      }
    }
    final groups = {'你 1': ['you'], '这个项目 2': ['project', 'old'], '蝶君 1': ['own'], '全部 4': entries};
    visible(entries);
    // One after another on the same page: switching must not reuse another group's card (duplicate GlobalKey).
    for (final group in groups.entries) {
      await tester.tap(find.widgetWithText(ChoiceChip, group.key));
      await tester.pumpAndSettle();
      visible(group.value);
    }
    await tester.enterText(field('找一条记忆'), '简练');
    await tester.pumpAndSettle();
    visible(['you']);
    for (final label in ['全部 1', '你 1', '这个项目 0', '蝶君 0']) {
      expect(find.widgetWithText(ChoiceChip, label), findsOneWidget);
    }
    await tester.tap(find.byTooltip('清除'));
    await tester.pumpAndSettle();
    visible(entries);
  });
}
