// T-142 visual acceptance: real Windows Flutter rendering with the same demo
// conversations and filenames as prototype/v1-redesign.html.
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/goal_conversation.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/setup_wizard.dart';
import 'package:dreamflutter/ui/rich_blocks.dart';
import 'package:dreamflutter/ui/message_widgets.dart' show WorkBlock;
import 'package:dreamflutter/ui/context_usage_ring.dart';
import 'package:dreamflutter/ui/web_surface.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'v012_compare_test.dart' show Demo, at;
import 'v1_visual_data.dart';

void installV1Data(Demo demo) {
  final skill = File(p.join(demo.root.path, 'skills', 'specifications', 'SKILL.md'))
    ..createSync(recursive: true)
    ..writeAsStringSync('# 规格书要点提取\n\n读一份规格书（PDF），抽出精度、量程、接口、供电和参考价格。数字要带单位和出处页码。');
  File(p.join(skill.parent.path, 'extract.py')).writeAsStringSync('# demo fixture');
  final report = File(p.join(demo.project, 'reports', '周报-W45.md'))..createSync(recursive: true)..writeAsStringSync('# 周报\n\n温度 22.4 ℃，湿度 61.8%。');
  final script = File(p.join(demo.project, 'scripts', 'summary.py'))..createSync(recursive: true)..writeAsStringSync('print("summary")');
  for (final relative in ['data/raw/2026-11/传感器-温湿度-第45周.csv', 'data/raw/2026-11/1110.csv', 'reports/周报-W44.md']) {
    File(p.join(demo.project, relative))..createSync(recursive: true)..writeAsStringSync(relative.endsWith('.csv') ? 'temperature,humidity\n22.4,61.8\n' : '# W44 周报\n\n上周平均温度 21.8 ℃。');
  }
  final memories = <Json>[
    {'id': 'brief', 'content': '回复简练，普通问答不用做成卡片', 'scope': 'global', 'version': 1, 'updatedAt': at(13, 10, 20)},
    {'id': 'sht40', 'content': 'SHT40 湿度精度 ±1.8%，比 DHT22 高一截', 'scope': 'butterfly', 'createdBy': 'main_agent', 'version': 1, 'updatedAt': at(13, 9, 12)},
    {'id': 'weekly', 'content': '每周一要交组会周报，用 W 加周次命名', 'scope': 'workspace', 'workspacePath': demo.project, 'version': 1, 'updatedAt': at(12, 16)},
    {'id': 'plot', 'content': '做实验数据分析偏好用 Python 画图', 'scope': 'global', 'version': 1, 'updatedAt': at(8, 11)},
  ];
  const memoryTitles = {'brief': '第三章 文献综述润色', 'weekly': '整理本周温湿度数据成周报', 'plot': '实验数据画成箱线图'};
  final memorySources = {
    for (final entry in memoryTitles.entries)
      entry.key: (File(p.join(demo.root.path, 'memory-${entry.key}.jsonl'))
        ..writeAsStringSync([
          jsonEncode({'type': 'session', 'id': 'memory-${entry.key}', 'cwd': demo.project}),
          jsonEncode({'type': 'session_info', 'name': entry.value}),
        ].join('\n'))).path,
  };
  demo.install();
  demo.backend.settings = {...demo.backend.settings, 'defaultModel': 'deepseek/deepseek-v4.1-flash', 'monthlyBudgetUsd': 40, 'userName': '小周'};
  demo.backend.handlers.addAll({
    'attention.list': (_) {
      final list = demo.attention();
      final question = (list['now'] as List).first as Json;
      question['reason'] = '不答的话 14:20 后按「先不算」继续';
      (question['data'] as Json)['options'] = ['算进去', '先不算（推荐）'];
      return list;
    },
    'schedules.occurrences': (_) {
      final calendar = demo.occurrences();
      return {
        'schedules': [
          for (final row in calendar['schedules'] as List<Json>) {
            ...row,
            if (row['id'] == 's_weekly') 'name': '组会纪要',
            if (row['id'] == 's_report') ...{
              'name': '交传感器报告',
              'nextRunAt': at(14, 15),
              'trigger': {'type': 'once', 'at': at(14, 15)},
            },
          },
        ],
        'items': [
          for (final row in calendar['items'] as List<Json>)
            if (row['scheduleId'] != 's_med' || row['at'] != at(14, 22)) {
              ...row,
              if (row['scheduleId'] == 's_med' && (row['at'] == at(14, 8) || row['at'] == at(14, 12))) 'status': 'done',
              if (row['scheduleId'] == 's_report') 'at': at(14, 15),
            },
        ],
      };
    },
    'patrol.status': (_) => {'enabled': true, 'intervalMin': 30, 'nextAt': at(14, 10), 'running': false, 'lastRun': {'endedAt': at(14, 9, 30), 'status': 'ok', 'note': '无需行动'}},
    'gateway.channels': (_) => [
      {'id': 'deepseek', 'provider': 'deepseek', 'platform': 'deepseek', 'name': 'DeepSeek', 'kind': 'payg', 'api': 'openai-completions', 'baseUrl': 'https://api.deepseek.com', 'models': [{'id': 'deepseek-v4.1-flash', 'name': 'DeepSeek V4.1 Flash'}, {'id': 'deepseek-v4.1', 'name': 'DeepSeek V4.1'}], 'keys': [], 'enabled': true},
    ],
    'gateway.groups': (_) => <Json>[],
    'gateway.platforms': (_) => [
      {'id': 'deepseek', 'name': 'DeepSeek', 'kind': 'payg', 'endpoints': [{'api': 'openai-completions', 'baseUrl': 'https://api.deepseek.com'}], 'models': ['deepseek-v4.1-flash'], 'modelDetails': [{'id': 'deepseek-v4.1-flash', 'name': 'DeepSeek V4.1 Flash'}]},
      {'id': 'glm', 'name': '智谱', 'kind': 'payg', 'endpoints': [{'api': 'openai-completions', 'baseUrl': 'https://open.bigmodel.cn'}], 'models': ['glm-4.6'], 'modelDetails': [{'id': 'glm-4.6', 'name': 'GLM-4.6'}]},
      {'id': 'opencode-go', 'name': 'OpenCode Go', 'kind': 'plan', 'endpoints': [{'api': 'openai-completions', 'baseUrl': 'https://opencode.example.invalid'}], 'models': ['deepseek-v4.1-flash'], 'modelDetails': [{'id': 'deepseek-v4.1-flash', 'name': 'DeepSeek V4.1 Flash'}]},
      {'id': 'other', 'name': '其他', 'kind': 'relay', 'endpoints': <Json>[], 'models': <String>[], 'modelDetails': <Json>[]},
    ],
    'gateway.saveChannel': (_) => 'deepseek',
    'setup.testChannel': (_) => {'ok': true},
    'setup.recommendModels': (_) => {'conversation': 'deepseek/deepseek-v4.1-flash', 'small': 'deepseek/deepseek-v4.1-flash', 'large': 'deepseek/deepseek-v4.1'},
    'memory.items': (_) => memories.map((row) => {...row}).toList(),
    'memory.item': (params) {
      final item = memories.firstWhere((row) => row['id'] == params['id']);
      final learning = item['id'] == 'sht40';
      return {
        'item': item,
        'sources': [{'kind': learning ? 'learning' : 'session', 'ref': learning ? 'demo-learning-note' : memorySources[item['id']], 'at': item['updatedAt']}],
        if (learning) 'sourceTitle': 'SHT40 数据手册',
        'versions': <Json>[],
        'log': <Json>[],
      };
    },
    'memory.log': (_) => {'days': [
      {'day': '2026-11-13', 'entries': [
        {'opId': 'add', 'kind': 'add', 'after': memories.first, 'undoable': true, 'at': at(13, 10, 20)},
        {'opId': 'edit', 'kind': 'update', 'before': {'content': '每周一交周报'}, 'after': memories[2], 'undoable': true, 'at': at(13, 9, 12)},
      ]},
    ], 'boundaries': <Json>[], 'hasMore': false},
    'skills.list': (_) => [
      {'kind': 'skill', 'name': '规格书要点提取', 'description': '从传感器规格书里抽精度、量程、接口、价格', 'filePath': skill.path, 'sourceKind': 'agent', 'scope': 'user', 'trust': 'trusted', 'enabled': true, 'usageCount': 6, 'lastUsedAt': at(12, 16)},
      {'kind': 'skill', 'name': '实验数据画图', 'description': '把温湿度记录画成对比图', 'filePath': skill.path, 'sourceKind': 'community', 'scope': 'user', 'trust': 'trusted', 'enabled': true, 'usageCount': 3},
    ],
    'mcp.list': (_) => {'servers': [
      {'name': '实验室资料库', 'description': '查询规格书与实验资料', 'source': p.join(demo.root.path, 'mcp.json'), 'scope': 'user', 'trust': 'trusted', 'enabled': true, 'usageCount': 12, 'butterflyAllowed': true, 'tools': [{'name': '搜索资料', 'enabled': true}, {'name': '写入笔记', 'enabled': false, 'readOnly': false}]},
      {'name': '飞书文档', 'description': '读写飞书云文档', 'source': p.join(demo.root.path, 'mcp.json'), 'scope': 'user', 'trust': 'trusted', 'enabled': false, 'tools': <Json>[]},
    ]},
    'proposals.list': (_) => [{'id': 'skill-pending', 'kind': 'skill', 'title': '组会纪要整理', 'payload': {'name': '组会纪要整理', 'description': '蝶君在沙箱里试过 3 次', 'sourceKind': 'agent'}}],
    'runs.list': (_) => [{'id': 'run', 'files': [report.path]}],
    'artifacts.list': (_) => [{'path': script.path}],
    'tasks.forSession': (_) => {'id': 'task'},
    'ledger.summary': (params) {
      final period = '${params['period']}', group = '${params['groupBy']}';
      if (period == 'day') {
        final since = DateTime.fromMillisecondsSinceEpoch((params['since'] as num).toInt());
        final raw = [30, 55, 20, 70, 45, 80, 35, 60, 25, 50, 65, 40, 72, 38, 55, 62, 28, 45, 90, 52, 40, 33, 58, 66, 47, 71, 36, 49, 60, 44];
        return {'timeZone': 'Asia/Taipei', 'rows': [for (final (i, value) in raw.indexed) {'period': _day(since.add(Duration(days: i))), 'key': 'all', 'requests': value ~/ 3, 'amounts': {'USD': value / 100}}]};
      }
      final now = DateTime.now(), day = DateTime(now.year, now.month, now.day);
      if (DateTime.fromMillisecondsSinceEpoch((params['since'] as num).toInt()) == day) return {'rows': [{'period': _day(now), 'key': 'conversation', 'requests': 38, 'amounts': {'USD': .42}}]};
      if (group == 'model') {
        return {'rows': [
          {'period': _day(now), 'key': 'deepseek/deepseek-v4.1-flash', 'requests': 734, 'amounts': {'USD': 6.0}},
          {'period': _day(now), 'key': 'glm/glm-4.6', 'requests': 361, 'amounts': {'USD': 2.96}},
          {'period': _day(now), 'key': 'opencode-go/deepseek-v4.1', 'requests': 109, 'amounts': {'USD': .9}},
        ]};
      }
      return {'rows': [
        {'period': _day(now), 'key': 'conversation', 'requests': 625, 'amounts': {'USD': 5.14}},
        {'period': _day(now), 'key': 'subagent', 'requests': 313, 'amounts': {'USD': 2.56}},
        {'period': _day(now), 'key': 'memory', 'requests': 168, 'amounts': {'USD': 1.38}},
        {'period': _day(now), 'key': 'auxiliary', 'requests': 98, 'amounts': {'USD': .78}},
      ]};
    },
    'ledger.entries': (_) => [
      {'requested_at': at(13, 10, 12), 'purpose': 'conversation', 'provider': 'deepseek', 'model': 'deepseek-v4.1-flash', 'amount': .42, 'currency': 'USD', 'amount_source': 'provider_actual'},
      {'requested_at': at(13, 10, 5), 'purpose': 'memory', 'provider': 'deepseek', 'model': 'deepseek-v4.1-flash', 'amount': .01, 'currency': 'USD', 'amount_source': 'price_estimate'},
    ],
  });
  final previous = demo.backend.onLaunch;
  demo.backend.onLaunch = (pi) {
    previous?.call(pi);
    // 窗口打开对话时多半是在已有进程里「切换」过去（switch_session），不是新开进程：两条路都要灌演示对话，
    // 否则对话场景拍出来是空白新对话页（T-143 发现 T-142 起的对照图都是这样）。
    final previousCommand = pi.onCommand;
    pi.onCommand = (c) { previousCommand?.call(c); if (c['type'] == 'switch_session' && c['sessionPath'] == demo.wbPath) pi.messages = _workbenchMessages(demo); };
    if (pi.target.sessionPath == demo.wbPath) pi.messages = _workbenchMessages(demo);
  };
}

List<Json> _workbenchMessages(Demo demo) {
  {
    {
      return [
        {'role': 'user', 'timestamp': at(13, 10), 'content': '把 data/raw 里这周的温湿度数据整理成周报，结论写进 reports/周报-W45.md'},
        {'role': 'assistant', 'timestamp': at(13, 10, 12), 'model': 'deepseek-v4.1-flash', 'provider': 'deepseek', 'stopReason': 'toolUse', 'content': [
          {'type': 'toolCall', 'id': 'r1', 'name': 'read', 'arguments': {'path': 'data/raw/2026-11/传感器-温湿度-第45周.csv'}},
          {'type': 'toolCall', 'id': 'r2', 'name': 'read', 'arguments': {'path': 'reports/周报-W44.md'}},
          {'type': 'toolCall', 'id': 'r3', 'name': 'read', 'arguments': {'path': 'data/raw/2026-11/1110.csv'}},
          {'type': 'toolCall', 'id': 'run', 'name': 'bash', 'arguments': {'command': 'python scripts/summary.py --week 45'}},
          {'type': 'toolCall', 'id': 'w1', 'name': 'edit', 'arguments': {'path': 'reports/周报-W45.md', 'oldText': '# 周报', 'newText': '# W45 周报'}},
        ]},
        for (final id in ['r1', 'r2', 'r3']) {'role': 'toolResult', 'toolCallId': id, 'toolName': 'read', 'isError': false, 'content': [{'type': 'text', 'text': 'ok'}]},
        {'role': 'toolResult', 'toolCallId': 'w1', 'toolName': 'edit', 'isError': false, 'content': [{'type': 'text', 'text': '周报已更新'}]},
        {'role': 'toolResult', 'toolCallId': 'run', 'toolName': 'bash', 'isError': false, 'content': [{'type': 'text', 'text': '读取 7 天 · 2016 条记录\n平均温度 22.4 ℃，湿度 61.8 %'}]},
        {'role': 'assistant', 'timestamp': at(13, 10, 12), 'model': 'deepseek-v4.1-flash', 'provider': 'deepseek', 'stopReason': 'stop', 'content': [{'type': 'text', 'text': 'W45 周报写好了。这周室内温度整体平稳，周三那场雨让夜里的湿度连续超限，露点接近 18 ℃，实验柜要注意防潮。\n\n| 指标 | 本周 | 上周 |\n| --- | --- | --- |\n| 平均温度 | 22.4 ℃ | 21.8 ℃ |\n| 平均湿度 | 61.8 % | 55.2 % |\n| 湿度超限 | 14 次 | 3 次 |\n\n> 超限都集中在 19:00 以后，和下雨的时间对得上。'}]},
        {'role': 'user', 'timestamp': at(13, 10, 14), 'content': '顺便给我汇总脚本的核心部分'},
        {'role': 'assistant', 'timestamp': at(13, 10, 16), 'model': 'deepseek-v4.1-flash', 'provider': 'deepseek', 'stopReason': 'stop', 'content': [{'type': 'text', 'text': '核心是按周读取、计算均值，再挑出湿度超限的记录：\n\n```python\nweek = read_week("data/raw", 45)\nover = week[week.humidity > 75]\nsummary = week.mean()\n```'}]},
      ];
    }
  }
}

String _day(DateTime day) => '${day.year}-${day.month.toString().padLeft(2, '0')}-${day.day.toString().padLeft(2, '0')}';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  // 只拍几张：--dart-define=V1_ONLY=02-chat,04-plan（按名字开头匹配，逗号隔开）；拍齐就提前结束（用户 2026-11-16：别每次拍满）。
  const only = String.fromEnvironment('V1_ONLY');
  const craftThemes = ['jiadie', 'shensi'];
  const craftStates = ['empty', 'ready', 'running'];
  const craftScenes = ['home', 'chat', 'appearance'];
  const filledScenes = [
    ('craft-filled-jiadie', 'jiadie', 1.0),
    ('craft-filled-shensi', 'shensi', 1.0),
    ('craft-filled-jiadie-125', 'jiadie', 1.25),
  ];
  final filledNames = {for (final (name, _, _) in filledScenes) name};
  final craftNames = [for (final id in craftThemes) for (final state in craftStates) 'craft-$id-$state'];
  final craftSceneNames = [for (final id in craftThemes) for (final scene in craftScenes) 'craft-scene-$id-$scene'];
  final craftCaptures = [...craftNames, ...craftSceneNames, ...filledNames];
  bool matchesShot(String request, String name) =>
      filledNames.contains(request) ? name == request : name.startsWith(request);
  final wanted = <String>{};
  for (final prefix in only.split(',').map((s) => s.trim()).where((s) => s.isNotEmpty)) {
    // A craft prefix requests each matching state, not just the first image.
    final matching = prefix.startsWith('craft-')
        ? craftCaptures.where((name) => matchesShot(prefix, name))
        : const <String>[];
    wanted.addAll(matching.isEmpty ? [prefix] : matching);
  }
  final taken = <String>{};
  testWidgets('T-142 v1 real-window comparison scenes', (tester) async { try {
    final root = Directory.systemTemp.createTempSync('df_v1_cmp_');
    final demo = Demo(root);
    final dark = Platform.environment['V1_DARK'] == '1';
    final renderer = await tester.runAsync(startV1Renderer);
    WebSurfaces.userDataFolder = p.join(root.path, 'webview-profile');
    Directory(demo.home).createSync(recursive: true);
    Directory(demo.project).createSync(recursive: true);
    installV1Data(demo);
    await tester.runAsync(() => installV1VisualData(demo, () => _workbenchMessages(demo), dark: dark));
    SharedPreferences.setMockInitialValues({'workspace': demo.project, 'onboarded': true, 'modelKey': 'opencode-go/deepseek-v4.1-flash', 'runPanelOpen': false, 'decorativeMotion': false});
    final agent = AgentController(preferences: await Preferences.load(), sessionStore: SessionStore(sessionsDir: root.path), backend: demo.backend);
    final key = GlobalKey();
    final mode = dark ? 'dark' : 'light';
    final shots = Directory(p.join(Directory.current.path, 'build', only.contains('polish-') ? 't143-polish' : only.contains('review-') ? 't143-review' : 'v1_compare', mode))..createSync(recursive: true);
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      agent.dispose();
      await RichRenderer.instance.dispose();
      await renderer!.close(force: true);
      try { root.deleteSync(recursive: true); } catch (_) {}
    });
    Future<void> settle([int rounds = 6]) async {
      for (var i = 0; i < rounds; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 40)));
        await tester.pump(const Duration(milliseconds: 120));
      }
    }
    Future<void> shot(String name) async {
      if (wanted.isNotEmpty && !wanted.any((request) => matchesShot(request, name))) return;
      await settle();
      final error = tester.takeException();
      if (error != null) throw StateError('$name: $error');
      await tester.runAsync(() async {
        final boundary = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        final image = await boundary.toImage(pixelRatio: 1);
        final data = await image.toByteData(format: ui.ImageByteFormat.png);
        final destination = name.startsWith('craft-scene-') || filledNames.contains(name)
            ? (Directory(p.join(Directory.current.path, 'build', 't143-review', 'light'))..createSync(recursive: true))
            : shots;
        File(p.join(destination.path, '$name.png')).writeAsBytesSync(data!.buffer.asUint8List(), flush: true);
        image.dispose();
      });
      if (wanted.isNotEmpty) { taken.addAll(wanted.where((request) => matchesShot(request, name))); if (taken.length == wanted.length) throw const _AllShot(); }
    }
    Future<void> app([Widget? home]) async {
      await tester.pumpWidget(RepaintBoundary(key: key, child: DreamFlutterApp(controller: agent, home: home)));
      await settle(3);
    }
    Future<void> checkPlanBounds(double width) async {
      final header = tester.getRect(find.byKey(const ValueKey('plan-header')));
      final list = tester.getRect(find.byKey(const ValueKey('plan-list')));
      final composer = tester.getRect(find.byKey(const ValueKey('composer-body')));
      expect(header.left, closeTo(composer.left, 1));
      expect(header.right, closeTo(composer.right, 1));
      expect(list.left, closeTo(composer.left, 1));
      expect(list.right, closeTo(composer.right, 1));
      expect(header.left, greaterThanOrEqualTo(0));
      expect(composer.right, lessThanOrEqualTo(width));
    }
    await tester.binding.setSurfaceSize(const Size(1500, 920));
    await agent.setThemeMode(dark ? ThemeMode.dark : ThemeMode.light);
    await app();
    await tester.runAsync(agent.init);
    agent.coreInfo['port'] = renderer!.port;
    RichRenderer.configure(renderer.port);
    await tester.runAsync(agent.refreshSessions);
    await settle(8);
    if (wanted.any((name) => name.startsWith('polish-'))) {
      Future<void> theme(String id) async {
        final painting = PaintingTheme.all.firstWhere((p) => p.id == id);
        await agent.setPaintingTheme(painting);
        await agent.setThemeMode(painting.isDark ? ThemeMode.dark : ThemeMode.light);
        await settle();
      }
      for (final id in ['jiadie', 'caodie', 'youhua']) {
        if (!wanted.contains('polish-home-$id')) continue;
        await theme(id);
        await shot('polish-home-$id');
      }
      if (wanted.contains('polish-butterfly-home')) {
        await theme('youhua');
        await tester.runAsync(() => agent.openButterfly());
        await tester.runAsync(() => agent.butterfly!.newSession(forceNew: true));
        await agent.butterfly!.setRunPanelOpen(false);
        agent.showSection(AppSection.butterfly);
        await shot('polish-butterfly-home');
        agent.showSection(AppSection.chat);
      }
      if (wanted.any((name) => name.startsWith('polish-process-') || name.startsWith('polish-context-'))) {
        await tester.runAsync(() => agent.openSession(demo.wbPath));
        await agent.setRunPanelOpen(false);
        await settle(8);
        agent.transcript.items.whereType<AssistantItem>().first.parts.insert(0,
          ThinkingPart('先核对文件和列名，再计算本周数据，保留原始资料以便复查。', durationMs: 5000));
        await app();
        tester.widget<CustomScrollView>(find.byKey(const ValueKey('conversation-list'))).controller!.jumpTo(0);
        await settle();
        await tester.tap(find.descendant(of: find.byType(WorkBlock).first, matching: find.byType(InkWell)).first);
        await settle();
        await tester.tap(find.text('思考 · 5 秒'));
        await settle();
        await tester.tap(find.descendant(of: find.byType(WorkBlock).first,
          matching: find.textContaining('python scripts/summary.py')).first);
        await settle();
        for (final id in ['jiadie', 'youhua']) {
          if (!wanted.contains('polish-process-$id')) continue;
          await theme(id);
          agent.active!.stats = const SessionStats(totalTokens: 59000, cost: .06, contextTokens: 59000, contextWindow: 128000, contextPercent: 46.09375);
          await agent.setRunPanelOpen(true);
          await agent.setRunPanelOpen(false);
          await settle();
          expect(tester.widget<ContextUsageRing>(find.byType(ContextUsageRing)).value, closeTo(.4609375, .0001));
          await shot('polish-process-$id');
        }
        if (wanted.contains('polish-context-high')) {
          await theme('youhua');
          agent.active!.stats = const SessionStats(totalTokens: 117760, cost: .06, contextTokens: 117760, contextWindow: 128000, contextPercent: 92);
          await app();
          await tester.tap(find.byKey(const ValueKey('context-ring')));
          await settle();
          expect(agent.runPanelOpen, isTrue, reason: 'usage ring still opens the context panel');
          await agent.setRunPanelOpen(false);
          await shot('polish-context-high');
        }
      }
      if (wanted.contains('polish-patrol')) {
        await theme('jiadie');
        agent.showSection(AppSection.schedules);
        await settle();
        await tester.tap(find.textContaining('巡检：').first);
        await shot('polish-patrol');
      }
      if (filledNames.any(wanted.contains)) {
        agent.showSection(AppSection.chat);
        await tester.runAsync(() => agent.newSession(forceNew: true));
        await settle();
      }
    }
    if (filledNames.any(wanted.contains)) {
      final appearance = agent.appearance.value;
      final input = find.byKey(const ValueKey('composer-input'));
      final composer = find.byKey(const ValueKey('composer-body'));
      final editable = find.descendant(of: input, matching: find.byType(EditableText));
      const lastParagraph = '最后一段：确认周报中的温度、湿度和缺失记录。 Final review complete.';
      const draft = '请核对本周传感器记录，保留原始资料并注明处理过程。\n'
          'Read the original temperature and humidity files before updating the report.\n'
          r'D:\workspace\reports\temperature-monitoring\2026\raw\November\sensor_data_for_the_entire_laboratory_with_calibration_and_timestamp_details.csv'
          '\n将原始读取路径与报告里的三张图逐项核对。\n'
          'SingleTokenWithoutSpaces_TheTemperatureAndHumidityCalibrationResultsForTheEntireLaboratoryDuringTheNovemberFieldExperimentMustRemainReadableAtTheEdgeOfTheComposerViewport.\n'
          '空值用明确的标记表示，并保留原始单位。\n'
          'The summary should include clear headings, units, and one decision for each exception.\n'
          '请分别总结周三夜间和其余各天的湿度变化。\n'
          'Compare the cached data with the source table before making a final statement.\n'
          '记录每一处改动并给出下一步复核建议。\n'
          'Check that the editor can scroll through all lines, including the final selection.\n'
          '$lastParagraph';
      final end = TextPosition(offset: draft.length);
      final selection = TextSelection(baseOffset: draft.length - lastParagraph.length, extentOffset: end.offset);
      try {
        await agent.setThemeMode(ThemeMode.light);
        expect(agent.runPanelOpen, isFalse);
        for (final (name, theme, zoom) in filledScenes) {
          if (!wanted.contains(name)) continue;
          await agent.setPaintingTheme(PaintingTheme.byId(theme, Brightness.light));
          await agent.setZoom(zoom);
          await settle();
          tester.binding.focusedEditable = null;
          await tester.enterText(input, draft);
          await settle();
          final state = tester.state<EditableTextState>(editable);
          final editor = state.renderEditable;
          expect(state.widget.controller.selection, TextSelection.collapsed(offset: end.offset));
          expect(editor.offset.pixels, greaterThan(0), reason: 'a long draft scrolls down to its end');
          final viewport = (Offset.zero & editor.size).inflate(1);
          expect(viewport.contains(editor.getLocalRectForCaret(end).center), isTrue,
              reason: 'the caret remains visible at the end of the draft');

          tester.testTextInput.updateEditingValue(TextEditingValue(text: draft, selection: selection));
          await settle();
          expect(state.widget.controller.selection, selection);
          final boxes = editor.getBoxesForSelection(selection).map((box) => box.toRect()).toList();
          expect(boxes, isNotEmpty, reason: 'the final paragraph is rendered and selected');
          for (final box in boxes) {
            expect(viewport.contains(box.topLeft) && viewport.contains(box.bottomRight), isTrue,
                reason: 'the final selection is fully visible in the editor');
          }
          final fullSelection = TextSelection(baseOffset: 0, extentOffset: end.offset);
          expect(editor.getBoxesForSelection(fullSelection).every((box) => box.left >= -1 && box.right <= editor.size.width + 1), isTrue,
              reason: 'a long word or path wraps within the editor');
          final body = tester.renderObject<RenderBox>(composer);
          final shape = (tester.widget<AnimatedContainer>(composer).decoration! as ShapeDecoration).shape;
          final inner = shape.getInnerPath(Offset.zero & body.size);
          expect(body.size.width, lessThanOrEqualTo(900.01));
          if (zoom == 1) expect(body.size.width, closeTo(900, 1));
          final editorInWindow = tester.getRect(editable);
          const window = Rect.fromLTWH(0, 0, 1500, 920);
          expect(window.contains(editorInWindow.topLeft) && window.contains(editorInWindow.bottomRight), isTrue,
              reason: 'the editor stays within the real window at ${(zoom * 100).round()}% zoom');
          for (final corner in [Offset.zero, Offset(editor.size.width, 0), Offset(0, editor.size.height), editor.size.bottomRight(Offset.zero)]) {
            expect(inner.contains(editor.localToGlobal(corner, ancestor: body)), isTrue,
                reason: 'all four corners of the rectangular editor fit inside the painted outline');
          }
          expect(agent.runPanelOpen, isFalse);
          await shot(name);
        }
      } finally {
        tester.widget<TextField>(input).controller!.clear();
        FocusManager.instance.primaryFocus?.unfocus();
        await agent.setZoom(appearance.zoom);
        await agent.setPaintingTheme(PaintingTheme.byId(appearance.lightTheme, Brightness.light));
        await agent.setThemeMode(appearance.themeMode);
        await settle();
      }
    }
    // The two themes share the same mounted fixture for each scene so only the
    // painting and its controls change between the resulting captures.
    if (craftSceneNames.any(wanted.contains)) {
      final appearance = agent.appearance.value;
      Future<void> captureThemes(String scene) async {
        for (final id in craftThemes) {
          final name = 'craft-scene-$id-$scene';
          if (!wanted.contains(name)) continue;
          await agent.setPaintingTheme(PaintingTheme.byId(id, Brightness.light));
          await shot(name);
        }
      }
      bool requests(String scene) => craftThemes.any((id) => wanted.contains('craft-scene-$id-$scene'));
      try {
        await agent.setThemeMode(ThemeMode.light);
        if (requests('home')) {
          expect(find.byKey(const ValueKey('composer-input')), findsOneWidget);
          await captureThemes('home');
        }
        if (requests('chat')) {
          await tester.runAsync(() => agent.openSession(demo.wbPath));
          await agent.setRunPanelOpen(true);
          await settle(8);
          final conversation = find.byKey(const ValueKey('conversation-list'));
          expect(conversation, findsOneWidget);
          tester.widget<CustomScrollView>(conversation).controller!.jumpTo(0);
          await captureThemes('chat');
        }
        if (requests('appearance')) {
          agent.openSettings('外观');
          await settle();
          expect(find.byKey(const ValueKey('settings-外观')), findsOneWidget);
          await captureThemes('appearance');
        }
      } finally {
        await agent.setPaintingTheme(PaintingTheme.byId(appearance.lightTheme, Brightness.light));
        await agent.setThemeMode(appearance.themeMode);
        agent.showSection(AppSection.chat);
        await agent.setRunPanelOpen(false);
      }
      await tester.runAsync(agent.newSession);
      await settle();
    }
    if (wanted.any((name) => name.startsWith('review-'))) {
      await agent.setPaintingTheme(PaintingTheme.byId('caodie', Brightness.light));
      await agent.setThemeMode(ThemeMode.light);
      await shot('review-home');
      await agent.setZoom(1.25);
      await shot('review-home-125');
      await agent.setZoom(1);
      await tester.runAsync(() => agent.openButterfly());
      await tester.runAsync(() => agent.butterfly!.newSession(forceNew: true));
      await agent.butterfly!.setRunPanelOpen(false);
      agent.showSection(AppSection.butterfly);
      await shot('review-butterfly-home');
      agent.showSection(AppSection.chat);
      await tester.runAsync(() => agent.openSession(demo.wbPath));
      await agent.setRunPanelOpen(true);
      await settle(8);
      await shot('review-right-open');
      final filesHeader = find.descendant(of: find.byKey(const ValueKey('panel-section-files')), matching: find.byType(TextButton)).first;
      await tester.tap(filesHeader);
      await shot('review-right-folded');
      await tester.tap(filesHeader);
      await agent.setRunPanelOpen(false);
      agent.transcript.items.whereType<AssistantItem>().first.parts.insert(0, ThinkingPart('先核对文件和列名，再计算本周数据，保留原始资料以便复查。', durationMs: 5000));
      Future<void> scrollConversation(bool end) async {
        await settle();
        final list = tester.widget<CustomScrollView>(find.byKey(const ValueKey('conversation-list')).last);
        list.controller!.jumpTo(end ? list.controller!.position.maxScrollExtent : 0);
        await settle();
      }
      await scrollConversation(false);
      await tester.tap(find.descendant(of: find.byType(WorkBlock).first, matching: find.byType(InkWell)).first);
      await settle();
      final thinkingLabel = find.text('思考 · 5 秒');
      await tester.tap(thinkingLabel);
      await shot('review-thinking');
      final attentionList = demo.backend.handlers['attention.list']!;
      final attentionPrioritized = demo.backend.handlers['attention.prioritized']!;
      demo.backend.handlers['attention.list'] = (_) => {'counts': {'total': 0}, 'now': [], 'later': [], 'pending': []};
      demo.backend.handlers['attention.prioritized'] = (_) => [];
      await tester.runAsync(agent.attention.refresh);
      agent.showSection(AppSection.tasks);
      await shot('review-attention-empty');
      demo.backend.handlers['attention.list'] = attentionList;
      demo.backend.handlers['attention.prioritized'] = attentionPrioritized;
      await tester.runAsync(agent.attention.refresh);
      await shot('review-attention-filled');
      agent.showSection(AppSection.chat);
      final pi = demo.backend.pis.firstWhere((pi) => pi.slotId == agent.active?.slotId);
      for (final (id, title) in [
        ('review-write', '写入文件：reports/周报-W45.md\n(14 个字符)'),
        ('review-command', '此命令需要批准。\nWrite-Output "report ready"'),
      ]) {
        pi.emit({'type': 'extension_ui_request', 'id': id, 'method': 'select',
          'title': 'Agent 请求执行操作\n\n$title', 'options': ['允许', '本会话内总是允许「bash」', '拒绝']});
        await scrollConversation(true);
        if (id == 'review-write') await shot('review-approval-pending');
        final card = find.byKey(ValueKey('approval-$id'));
        await tester.ensureVisible(card);
        await tester.tap(find.descendant(of: card, matching: find.widgetWithText(FilledButton, '允许')));
        await settle();
        expect(find.byKey(ValueKey('approval-$id')), findsNothing);
      }
      pi.finishRun();
      await scrollConversation(true);
      expect(find.text('已处理 2 项审批'), findsOneWidget);
      await shot('review-approval-done');
      await tester.tap(find.text('已处理 2 项审批'));
      await scrollConversation(true);
      await shot('review-approval-history');
      final missingReviews = wanted.difference(taken).where((name) => name.startsWith('review-')).toSet();
      if (missingReviews.isNotEmpty) throw StateError('Uncaptured review scenes: $missingReviews');
    }
    await shot('01-home');

    await tester.runAsync(() => agent.openSession(demo.wbPath));
    await agent.setRunPanelOpen(true);
    await settle(8);
    // The prototype depicts the beginning. Real conversations still open at the end.
    Future<void> showConversationStart() async {
      final list = tester.widget<CustomScrollView>(find.byKey(const ValueKey('conversation-list')).last);
      list.controller!.jumpTo(0);
      await settle();
    }
    // Bring the final diagram into the viewport once so lazy conversation rows build it.
    final diagram = find.byType(RichBlock);
    if (diagram.evaluate().isNotEmpty) await tester.ensureVisible(diagram.first);
    // Wait for the real WebView renderer, rather than photographing its source fallback.
    final drawingDeadline = DateTime.now().add(const Duration(seconds: 25));
    while (find.byKey(const ValueKey('rich-image')).evaluate().isEmpty && DateTime.now().isBefore(drawingDeadline)) {
      await settle(2);
    }
    expect(find.byKey(const ValueKey('rich-image')), findsOneWidget, reason: 'Mermaid must render through the local WebView service; base=${RichRenderer.baseUrl}; blocks=${diagram.evaluate().length}; errors=${find.byType(Text).evaluate().map((e) => (e.widget as Text).data).where((s) => s?.contains("没能画出") ?? false).toList()}');
    await showConversationStart();
    await shot('02-chat-workbench');

    await tester.runAsync(() => agent.openButterfly());
    await tester.runAsync(() => agent.butterfly!.openSession(demo.goalPath));
    await tester.runAsync(() => agent.butterfly!.refreshSessions());
    agent.showSection(AppSection.butterfly);
    await agent.butterfly!.setRunPanelOpen(true);
    await settle(8);
    await showConversationStart();
    await shot('03-chat-butterfly');
    await tester.tap(find.byKey(const ValueKey('plan-header')));
    await settle();
    await shot('04-plan-open');
    await checkPlanBounds(1500);

    agent.showSection(AppSection.tasks);
    await shot('05-attention');
    agent.showSection(AppSection.schedules);
    // Jump to the example date through the existing schedule navigation, then
    // select it in the calendar to show the day list without the task editor.
    scheduleNavigationRequest.value = 's_meet';
    await settle();
    await tester.tap(find.byKey(const ValueKey('schedule-day-14')));
    await shot('06-schedule');

    agent.showSection(AppSection.chat);
    await tester.runAsync(agent.newSession);
    await agent.setRunPanelOpen(false);
    await settle();
    expect(agent.models.map((m) => m.key), containsAll(['opencode-go/deepseek-v4.1-flash', 'dreamflutter/daily', 'dreamflutter/vision']));
    expect(agent.models.any((m) => m.key == agent.defaultModelKey), isTrue, reason: 'the settings example must select an available model after preference migration');
    final settings = ['通用', '蝶君', '记忆', '模型', '工作台', '外观', '窗口与通知', '数据与安全', '归档与回收', '关于与更新', '开发者选项'];
    for (final (i, group) in settings.indexed) {
      agent.openSettings(group);
      await shot('${(i + 7).toString().padLeft(2, '0')}-settings-${i + 1}');
      expect(agent.coreSettings['defaultModel'], 'opencode-go/deepseek-v4.1-flash', reason: '$group must retain the configured model after loading its settings');
      expect(agent.coreSettings['largeTaskModel'], 'dreamflutter/daily');
      expect(agent.coreSettings['visionModel'], 'dreamflutter/vision');
    }
    agent.showSection(AppSection.memory);
    await shot('18-memory');
    agent.showSection(AppSection.library);
    await shot('19-skills');
    agent.showSection(AppSection.spending);
    await shot('20-spending');

    await app(SetupWizard(key: const ValueKey('welcome'), status: {'dataRoot': root.path, 'userName': '小周'}, onComplete: () {}));
    await shot('21-wizard-welcome');
    await app(SetupWizard(key: const ValueKey('connect'), status: {'dataRoot': root.path, 'userName': '小周'}, initialStep: 3, onComplete: () {}));
    await shot('22-wizard-connect');

    agent.showSection(AppSection.chat);
    await tester.runAsync(agent.newSession);
    await app();
    if (wanted.any((name) => name.startsWith('home-butterfly'))) {
      await tester.runAsync(() => agent.openButterfly());
      await tester.runAsync(() => agent.butterfly!.newSession(forceNew: true));
      await agent.butterfly!.setRunPanelOpen(false);
      agent.showSection(AppSection.butterfly);
      await shot('home-butterfly');
      if (wanted.contains('home-butterfly-unfocused')) {
        FocusManager.instance.primaryFocus?.unfocus();
        await settle();
        await shot('home-butterfly-unfocused');
      }
      agent.showSection(AppSection.chat);
      await settle();
    }
    Future<void> captureCraftStates(String id) async {
      final prefix = 'craft-$id';
      await tester.runAsync(() => agent.newSession(forceNew: true));
      await settle(3);
      final pi = demo.backend.pis.firstWhere((pi) => pi.slotId == agent.active?.slotId);
      final input = find.byKey(const ValueKey('composer-input'));
      Future<void> setCraftDraft(String text) {
        // Tab or the previous shot can leave the same EditableText cached but unfocused.
        tester.binding.focusedEditable = null;
        return tester.enterText(input, text);
      }
      Finder button(String tooltip) => find.byWidgetPredicate((w) => w is IconButton && w.tooltip == tooltip);
      final send = button('发送');
      try {
        expect(tester.widget<IconButton>(send).onPressed, isNull);
        await shot('$prefix-empty');

        if (wanted.contains('$prefix-ready')) {
          await setCraftDraft('核对实验记录');
          await settle(3);
          final field = tester.widget<TextField>(input);
          expect(tester.widget<IconButton>(send).onPressed, isNotNull,
            reason: '$prefix-ready: agent.isReady=${agent.isReady}, isRunning=${agent.isRunning}, '
                'TextField.controller.text=${jsonEncode(field.controller?.text)}, enabled=${field.enabled}');
          final target = tester.element(send);
          bool sendHasFocus() {
            var found = false;
            FocusManager.instance.primaryFocus?.context?.visitAncestorElements((element) {
              found = element == target;
              return !found;
            });
            return found;
          }
          for (var tab = 0; tab < 12 && !sendHasFocus(); tab++) {
            await tester.sendKeyEvent(LogicalKeyboardKey.tab);
            await tester.pump();
          }
          expect(sendHasFocus(), isTrue, reason: 'Tab reaches the real send button');
          await shot('$prefix-ready');
        }

        if (wanted.contains('$prefix-running')) {
          await setCraftDraft('');
          FocusManager.instance.primaryFocus?.unfocus();
          pi.startRun('核对实验记录');
          await settle(3);
          expect(tester.widget<IconButton>(button('停止')).onPressed, isNotNull);
          await shot('$prefix-running');
        }
      } finally {
        if (pi.streaming) {
          pi.finishRun();
          await settle(3);
          await tester.runAsync(agent.newSession);
          await settle(3);
        }
        await setCraftDraft('');
        FocusManager.instance.primaryFocus?.unfocus();
        await tester.pump();
      }
    }
    final originalAppearance = agent.appearance.value;
    try {
      for (final theme in PaintingTheme.all) {
        await agent.setThemeMode(theme.isDark ? ThemeMode.dark : ThemeMode.light);
        await agent.setPaintingTheme(theme);
        await shot('theme-${theme.id}');
        if (theme.id == 'huandie' || theme.id == 'shiqing') await shot('home-${theme.id}');
        if (craftThemes.contains(theme.id) && craftStates.any((state) => wanted.contains('craft-${theme.id}-$state'))) {
          await captureCraftStates(theme.id);
        }
      }
    } finally {
      await agent.setPaintingTheme(PaintingTheme.byId(originalAppearance.lightTheme, Brightness.light));
      await agent.setPaintingTheme(PaintingTheme.byId(originalAppearance.darkTheme, Brightness.dark));
      await agent.setThemeMode(originalAppearance.themeMode);
    }

    await tester.runAsync(() => agent.openSession(demo.wbPath));
    await tester.runAsync(() => agent.openButterfly());
    await tester.runAsync(() => agent.butterfly!.openSession(demo.goalPath));
    agent.showSection(AppSection.butterfly);
    await agent.butterfly!.setRunPanelOpen(false);
    for (final width in [1600.0, 1000.0, 760.0]) {
      await tester.binding.setSurfaceSize(Size(width, 920));
      await settle();
      if (find.byKey(const ValueKey('plan-list')).evaluate().isEmpty) await tester.tap(find.byKey(const ValueKey('plan-header')));
      await settle();
      await checkPlanBounds(width);
      await shot('23-plan-${width.toInt()}');
    }
    agent.openSettings('外观');
    await shot('24-settings-760');
    agent.showSection(AppSection.memory);
    await shot('25-memory-760');
    agent.showSection(AppSection.library);
    await shot('26-skills-760');
    agent.showSection(AppSection.spending);
    await shot('27-spending-760');
    agent.showSection(AppSection.butterfly);
    await settle();
    await tester.tap(find.byTooltip('打开侧栏'));
    await settle();
    await shot('28-sidebar-760');
    expect(find.byType(Drawer), findsOneWidget);
    expect(tester.getRect(find.byType(Drawer)).right, lessThanOrEqualTo(760));
    expect(taken.length, wanted.length, reason: 'every V1_ONLY scene must produce a screenshot');
  } on _AllShot catch (_) {} });
}

class _AllShot implements Exception { const _AllShot(); }
