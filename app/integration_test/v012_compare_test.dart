// 0.12 visual acceptance: the real window filled with the same demo data as
// docs/design/prototype/v0.12-additions.html, captured at the prototype's size
// (1500 x 856, the prototype screenshots minus their 44 px demo bar) so each
// scene can be laid next to docs/design/prototype/v0.12-shots/*.png.
import 'dart:io';
import 'dart:ui' as ui;

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/goal_conversation.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../test/fake_backend.dart';
import '../test/fake_pi.dart';

int at(int day, int h, [int m = 0]) => DateTime(2026, 11, day, h, m).millisecondsSinceEpoch;

class Demo {
  Demo(this.root) : home = p.join(root.path, 'butterfly'), project = p.join(root.path, '毕设-传感器数据');
  final Directory root;
  final String home, project;
  late final goalPath = p.join(root.path, 'goal.jsonl');
  late final wbPath = p.join(root.path, 'weekly.jsonl');
  final backend = FakeBackend();
  String? goalSlot;
  final sessionsStatus = <String, String>{};

  List<Json> butterflyRows() {
    final now = DateTime.now().millisecondsSinceEpoch;
    return [
      {'path': p.join(root.path, 'meds.jsonl'), 'title': '每天提醒吃药', 'cwd': home, 'modifiedAt': now - 1000},
      {'path': goalPath, 'title': '整理三款温湿度传感器对比', 'cwd': home, 'modifiedAt': now - 2000},
      {'path': p.join(root.path, 'silero.jsonl'), 'title': '学 Silero 语音检测', 'cwd': home, 'modifiedAt': now - 3000},
      {'path': p.join(root.path, 'minutes.jsonl'), 'title': '整理组会纪要模板', 'cwd': home, 'modifiedAt': now - 4000},
    ];
  }

  List<Json> workbenchRows() {
    final now = DateTime.now().millisecondsSinceEpoch;
    return [
      {'path': wbPath, 'title': '整理本周温湿度数据成周报', 'cwd': project, 'modifiedAt': now - 1000},
      {'path': p.join(root.path, 'side.jsonl'), 'title': '问一下：露点温度怎么算', 'cwd': project, 'parentSession': wbPath, 'sessionType': 'side', 'modifiedAt': now - 1500},
      {'path': p.join(root.path, 'fork.jsonl'), 'title': '分支：换成 pandas 实现', 'cwd': project, 'parentSession': wbPath, 'modifiedAt': now - 1600},
      {'path': p.join(root.path, 'esp.jsonl'), 'title': 'ESP32 MQTT 断线重连', 'cwd': project, 'modifiedAt': now - 2000},
      {'path': p.join(root.path, 'ch3.jsonl'), 'title': '第三章 文献综述润色', 'cwd': project, 'modifiedAt': now - 3000},
    ];
  }

  static const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=';
  List<Json> goalMessages() => [
    {'role': 'assistant', 'timestamp': at(13, 9, 12), 'dfProactiveRef': 'demo', 'model': 'deepseek-v4.1-flash', 'provider': 'opencode-go', 'stopReason': 'stop', 'content': [
      {'type': 'text', 'text': '早上好。昨晚空闲的时候我把 SHT40 的数据手册读完了，它的湿度精度比 DHT22 高一截，正好能用在你的传感器对比里。要我顺手把它加进去吗？'}]},
    {'role': 'user', 'timestamp': at(13, 9, 40), 'content': '加进去吧，三款一起对比，下午之前给我一份报告'},
    {'role': 'assistant', 'timestamp': at(13, 10, 4), 'model': 'deepseek-v4.1-flash', 'provider': 'opencode-go', 'stopReason': 'toolUse', 'content': [
      {'type': 'toolCall', 'id': 'r1', 'name': 'read', 'arguments': {'path': 'docs/SHT40.pdf'}},
      {'type': 'toolCall', 'id': 'r2', 'name': 'read', 'arguments': {'path': 'docs/DHT22.pdf'}},
      {'type': 'toolCall', 'id': 'r3', 'name': 'read', 'arguments': {'path': 'docs/BME280.pdf'}},
      {'type': 'toolCall', 'id': 'b1', 'name': 'bash', 'arguments': {'command': 'python crawl_prices.py --once'}},
      {'type': 'toolCall', 'id': 'plot', 'name': 'bash', 'arguments': {'command': 'python scripts/plot.py'}}]},
    for (final id in ['r1', 'r2', 'r3']) {'role': 'toolResult', 'toolCallId': id, 'toolName': 'read', 'isError': false, 'content': [{'type': 'text', 'text': 'ok'}]},
    {'role': 'toolResult', 'toolCallId': 'b1', 'toolName': 'bash', 'isError': false, 'content': [{'type': 'text', 'text': 'ok'}]},
    {'role': 'toolResult', 'toolCallId': 'plot', 'toolName': 'bash', 'isError': false, 'details': {'path': 'price.png'}, 'content': [{'type': 'image', 'mimeType': 'image/png', 'data': png}]},
    {'role': 'assistant', 'timestamp': at(13, 10, 5), 'model': 'deepseek-v4.1-flash', 'provider': 'opencode-go', 'stopReason': 'toolUse', 'content': [
      {'type': 'text', 'text': '好，这件事我按目标来推进，做完会核对交付再告诉你。先抓了一轮价格，画了张对比图：'},
      {'type': 'toolCall', 'id': 'sc', 'name': 'schedule_create', 'arguments': {'name': '下午 3 点交传感器报告'}}]},
    {'role': 'toolResult', 'toolCallId': 'sc', 'toolName': 'schedule_create', 'isError': false, 'details': {'action': 'created', 'scheduleId': 's_report'}, 'content': [{'type': 'text', 'text': 'created'}]},
    {'role': 'assistant', 'timestamp': at(13, 10, 5), 'model': 'deepseek-v4.1-flash', 'provider': 'opencode-go', 'stopReason': 'stop', 'content': [{'type': 'text', 'text': '三款里有一款只在海外卖，等你定一下要不要算进去。'}]},
  ];

  Json schedule(String id) => switch (id) {
    's_med' => {'id': 's_med', 'name': '提醒吃药', 'kind': 'reminder', 'owner': 'butterfly', 'createdBy': 'user', 'version': 3, 'status': 'active', 'describe': '每天 08:00、12:00、18:00、22:00', 'timeText': '每天 08:00、12:00、18:00、22:00', 'everyDay': {'times': ['08:00', '12:00', '18:00', '22:00']}, 'trigger': {'type': 'cron', 'crons': ['0 8 * * *', '0 12 * * *', '0 18 * * *', '0 22 * * *']}, 'nextRunAt': at(13, 18)},
    's_weekly' => {'id': 's_weekly', 'name': '周一组会纪要', 'kind': 'task', 'prompt': '整理组会纪要', 'cwd': home, 'owner': 'butterfly', 'createdBy': 'butterfly', 'version': 1, 'status': 'active', 'describe': '每周一 09:00', 'everyDay': null, 'trigger': {'type': 'cron', 'crons': ['0 9 * * 1']}, 'nextRunAt': at(17, 9)},
    's_cmp' => {'id': 's_cmp', 'name': '交传感器对比', 'kind': 'task', 'prompt': '把三款传感器的精度、量程、价格做成对比表，放进交付', 'cwd': home, 'owner': 'butterfly', 'createdBy': 'butterfly', 'version': 1, 'status': 'active', 'describe': '一次性：2026/11/12 09:00', 'timeText': '11月12日 09:00', 'everyDay': null, 'trigger': {'type': 'once', 'at': at(12, 9)}, 'lastRunAt': at(12, 9)},
    's_meet' => {'id': 's_meet', 'name': '导师见面', 'kind': 'reminder', 'owner': 'butterfly', 'createdBy': 'user', 'version': 1, 'status': 'active', 'describe': '一次性：2026/11/14 14:00', 'timeText': '11月14日 14:00', 'everyDay': null, 'trigger': {'type': 'once', 'at': at(14, 14)}, 'nextRunAt': at(14, 14)},
    's_report' => {'id': 's_report', 'name': '下午 3 点交传感器报告', 'kind': 'task', 'prompt': '交报告', 'cwd': home, 'owner': 'butterfly', 'createdBy': 'butterfly', 'version': 1, 'status': 'active', 'describe': '一次性：2026/11/13 15:00', 'everyDay': null, 'trigger': {'type': 'once', 'at': at(13, 15)}, 'nextRunAt': at(13, 15)},
    _ => {'id': 's_week', 'name': '交周报', 'kind': 'reminder', 'owner': 'butterfly', 'createdBy': 'user', 'version': 1, 'status': 'active', 'describe': '一次性：2026/11/20 17:00', 'everyDay': null, 'trigger': {'type': 'once', 'at': at(20, 17)}, 'nextRunAt': at(20, 17)},
  };

  Json occurrences() {
    final items = <Json>[];
    for (var d = 1; d <= 30; d++) {
      for (final h in [8, 12, 18, 22]) {
        final done = d < 13 || (d == 13 && h < 15);
        items.add({'scheduleId': 's_med', 'at': at(d, h), 'status': done ? 'done' : 'upcoming'});
      }
    }
    for (final d in [3, 10, 17, 24]) { items.add({'scheduleId': 's_weekly', 'at': at(d, 9), 'status': d < 13 ? 'done' : 'upcoming'}); }
    items.add({'scheduleId': 's_cmp', 'at': at(12, 9), 'status': 'failed', 'error': '没做成：网页打不开'});
    items.add({'scheduleId': 's_meet', 'at': at(14, 14), 'status': 'upcoming'});
    items.add({'scheduleId': 's_report', 'at': at(13, 15), 'status': 'upcoming'});
    items.add({'scheduleId': 's_week', 'at': at(20, 17), 'status': 'upcoming'});
    return {'items': items, 'schedules': [for (final id in ['s_med', 's_weekly', 's_cmp', 's_meet', 's_report', 's_week']) schedule(id)]};
  }

  void install() {
    backend.butterflyHome = home;
    backend.handlers.addAll({
      'sessions.list': (params) => params['cwd'] == home ? butterflyRows() : params['cwd'] == project ? workbenchRows() : <Json>[],
      'sandbox.status': (_) => {'state': 'ready', 'online': true, 'distro': 'DreamFlutterSandbox'},
      'goals.list': (_) => [
        {'id': 'g1', 'title': '整理三款温湿度传感器对比', 'status': 'running', 'kind': 'goal', 'sessionFile': goalPath, 'createdAt': at(13, 9, 41), 'partition': 'butterfly'},
        {'id': 'g2', 'title': '学 Silero 语音检测', 'status': 'paused', 'kind': 'goal', 'sessionFile': p.join(root.path, 'silero.jsonl'), 'createdAt': at(12, 9)},
        {'id': 'g3', 'title': '整理组会纪要模板', 'status': 'blocked', 'kind': 'goal', 'sessionFile': p.join(root.path, 'minutes.jsonl'), 'createdAt': at(11, 9)},
      ],
      'goals.get': (_) => {
        'id': 'g1', 'title': '整理对比表', 'status': 'running', 'sessionFile': goalPath, 'stage': '第 2 轮 · 执行中', 'next': '等你回答海外那款算不算',
        'spec': {'objective': '三款温湿度传感器的规格和价格对比，写成 report.md'},
        'budgetStatus': {'limits': {'maxCostUsd': .5}, 'used': {'costUsd': .06, 'activeMs': 14 * 60000}}, 'emergency': false,
      },
      'jobs.list': (_) => [
        {'id': 'j1', 'kind': 'process', 'command': 'python crawl_prices.py', 'status': 'running', 'started_at': DateTime.now().millisecondsSinceEpoch - 192000},
        {'id': 'j2', 'kind': 'subagent', 'label': '子任务：读 BME280 规格书', 'status': 'running', 'started_at': DateTime.now().millisecondsSinceEpoch - 100000},
        {'id': 'j3', 'kind': 'process', 'command': 'pip install pandas', 'status': 'exited', 'started_at': DateTime.now().millisecondsSinceEpoch - 28000, 'ended_at': DateTime.now().millisecondsSinceEpoch - 10000},
      ],
      'jobs.output': (_) => {'text': '[jd] SHT40 ¥23.8\n[jd] DHT22 ¥12.5\n[tb] BME280 ¥31.0\n[tb] 第 4 页…', 'next': 60},
      'goals.proposals': (_) => <Json>[],
      'confirm.list': (_) => [
        {'id': 'q1', 'slotId': goalSlot, 'method': 'select', 'kind': 'input', 'status': 'pending', 'createdAt': DateTime.now().millisecondsSinceEpoch - 2000, 'title': 'Agent 需要你补充信息：\n\n三款里有一款只在海外卖，要算进对比吗？',
          'request': {'options': ['算进去 — 运费按 60 元估', '先不算 (Recommended)', '换一款国内的 — 我来挑', '自己回答…', '跳过这个问题'], 'timeout': 120000}},
      ],
      'schedules.occurrences': (_) => occurrences(),
      'schedules.list': (_) => occurrences()['schedules'],
      'schedules.get': (params) => schedule('${params['id']}'),
      'schedules.history': (_) => [{'id': 'h1', 'summary': '11月11日 蝶君把 21:00 改成 22:00（你同意的）', 'undoneAt': null}],
      'schedules.defaults': (_) => {'timezone': 'Asia/Shanghai'},
      'patrol.status': (_) => {'enabled': true, 'intervalMin': 30, 'nextAt': at(13, 15), 'running': false, 'lastRun': {'endedAt': at(13, 14, 30), 'status': 'ok', 'note': '无需行动'}, 'cooldownUntil': null},
      'patrol.log': (_) => [
        {'startedAt': at(13, 14, 30), 'note': '无需行动'},
        {'startedAt': at(13, 14), 'note': '发现「整理组会纪要模板」卡住 2 小时，已通知你'},
        {'startedAt': at(13, 13, 30), 'note': '无需行动'},
        {'startedAt': at(13, 13), 'note': '夜间不打扰时段结束，补看了 1 条未读交付'},
      ],
      'attention.list': (_) => attention(),
      'attention.prioritized': (_) => [
        {'id': 'question:q1', 'category': 'decision'}, {'id': 'confirm:rule', 'category': 'decision'},
        {'id': 'goal_blocked:g3', 'category': 'blocked'}, {'id': 'goal_acceptance:g2', 'category': 'review'},
      ],
      'persona.presets': (_) => [
        {'id': 'quiet', 'name': '静', 'description': '安静可靠，话少', 'example': '嗯，资料都整理好了。还差一项，明天你确认就行。'},
        {'id': 'warm', 'name': '暖', 'description': '亲切，关心你', 'example': '辛苦啦！两份资料都整理好了，还差一项明天等你看看，不急哦～'},
        {'id': 'brisk', 'name': '利落', 'description': '只说结论和下一步', 'example': '两份已完成，1 项待你明天确认。'},
        {'id': 'lively', 'name': '灵动', 'description': '活泼，爱用比喻', 'example': '两份资料已经乖乖排好队啦，只剩一位等你明天点名～'},
      ],
      'selfwork.longGoals.list': (_) => [
        {'id': 'l1', 'title': '把传感器选型的门道摸清楚', 'instruction': '空闲时自己学', 'revision': 1, 'enabled': true, 'noteCount': null,
          'lastStudiedAt': () { final y = DateTime.now().subtract(const Duration(days: 1)); return DateTime(y.year, y.month, y.day, 23, 10).millisecondsSinceEpoch; }()},
        {'id': 'l2', 'title': '熟悉 GB/T 7714 的细节', 'instruction': '空闲时自己学', 'revision': 2, 'enabled': false, 'lastStudiedAt': null, 'noteCount': null},
      ],
      'selfwork.history': (_) => <Json>[],
      'autonomy.rules.list': (_) => [
        {'id': 'r1', 'name': '工作日 9 点整理新纪要', 'mode': 'observe', 'revision': 1},
        {'id': 'r2', 'name': '「资料/论文」有新 PDF 时做摘要', 'mode': 'auto', 'revision': 1},
        {'id': 'r3', 'name': '每周五提醒备份', 'mode': 'off', 'revision': 1},
      ],
      'selfwork.skills.list': (_) => [
        {'id': 'k1', 'name': '规格书要点提取', 'active_version': 1, 'adopted_version': null, 'versions': [{'version': 1, 'description': '从传感器规格书里抽精度、量程、接口、价格 · 测过 6 份样例'}]},
        {'id': 'k2', 'name': '组会纪要整理', 'active_version': 1, 'adopted_version': 1, 'versions': [{'version': 1, 'description': '按模板把录音转写整理成要点 · 测过 3 份样例'}]},
      ],
      'voice.keyStatus': (_) => {'configured': false},
      'uninstall.preservedData': (_) => {'candidates': <Json>[]},
      'slot.list': (_) => <Json>[],
    });
    backend.settings = {...backend.settings, 'butterflyPersona': 'quiet', 'butterflyProactivity': 'high', 'butterflyDailyBudget': .5, 'patrolEnabled': true, 'patrolIntervalMin': 30};
    backend.onLaunch = (FakePi pi) {
      void goal() {
        pi.messages = goalMessages();
        goalSlot = pi.slotId;
        pi.extraResponses['df_agent_state'] = {'agentMode': 'standard', 'planMode': false, 'todos': [
          {'content': '读三款的规格书', 'status': 'completed'}, {'content': '抓京东、淘宝的价格', 'status': 'completed'}, {'content': '整理成对比表', 'status': 'in_progress'},
          {'content': '写推荐结论', 'status': 'pending'}, {'content': '交付 report.md', 'status': 'pending'}]};
      }
      if (pi.target.sessionPath == goalPath) goal();
      pi.onCommand = (c) { if (c['type'] == 'switch_session' && c['sessionPath'] == goalPath) goal(); };
    };
  }

  Json attention() {
    Json origin(String name, String file) => {'role': 'butterfly', 'sessionName': name, 'sessionFile': p.join(root.path, file)};
    return {
      'counts': {'total': 4, 'now': 4, 'later': 0},
      'now': [
        {'id': 'question:q1', 'kind': 'question', 'group': 'now', 'title': 'Agent 需要你补充信息：', 'reason': '不算的话 14:20 后按「先不算」继续', 'origin': origin('整理三款温湿度传感器对比', 'goal.jsonl'), 'target': {'page': 'butterfly'}, 'actions': ['answer', 'reject'],
          'data': {'method': 'select', 'title': 'Agent 需要你补充信息：\n\n海外那款要算进对比吗？', 'options': ['算进去', '先不算']}},
        {'id': 'confirm:rule', 'kind': 'confirm', 'group': 'now', 'title': '确认蝶君起草的主动规则', 'reason': '工作日早上 9 点，把「资料/组会」文件夹里的新纪要整理成要点，只读原件，结果放进交付，不对外发送。', 'origin': {'role': 'butterfly'}, 'target': {'page': 'butterfly'}, 'actions': ['allow', 'reject'],
          'data': {'kind': 'rule_draft', 'version': 1, 'draft': {'name': '工作日 9 点整理新纪要', 'source': 'schedule', 'task': '工作日早上 9 点，把「资料/组会」文件夹里的新纪要整理成要点，只读原件，结果放进交付，不对外发送。', 'scope': {'kind': 'sandbox'}, 'actions': ['read', 'write'], 'delivery': '/workspace/outbox', 'assess': false, 'filter': {}}}},
        {'id': 'goal_blocked:g3', 'kind': 'goal_blocked', 'group': 'now', 'title': '找不到「资料/组会」文件夹', 'reason': '你上周把它挪走了？给我新位置就能接着做', 'origin': origin('整理组会纪要模板', 'minutes.jsonl'), 'target': {'page': 'butterfly'}, 'actions': ['open'], 'data': {}},
        {'id': 'goal_acceptance:g2', 'kind': 'goal_acceptance', 'group': 'now', 'title': '学习笔记写好了，程序核对过 3 项证据', 'reason': 'silero-notes.md · 4.2 KB · 附 2 段可运行的示例', 'origin': origin('学 Silero 语音检测', 'silero.jsonl'), 'target': {'page': 'butterfly'}, 'actions': ['open', 'accept', 'reject'], 'data': {}},
      ],
      'later': <Json>[],
      'pending': <Json>[],
    };
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('v0.12 scenes with prototype demo data', (tester) async {
    final root = Directory.systemTemp.createTempSync('df_v012_cmp_');
    final demo = Demo(root);
    Directory(demo.home).createSync();
    Directory(demo.project).createSync();
    SharedPreferences.setMockInitialValues({'workspace': demo.project, 'onboarded': true, 'runPanelOpen': false});
    demo.install();
    final agent = AgentController(preferences: await Preferences.load(), sessionStore: SessionStore(sessionsDir: root.path), backend: demo.backend);
    final key = GlobalKey();
    final dark = Platform.environment['V012_DARK'] == '1';
    final shots = Directory(p.join(Directory.current.path, 'build', 'v012_compare'))..createSync(recursive: true);
    addTearDown(() async { await tester.pumpWidget(const SizedBox()); agent.dispose(); try { root.deleteSync(recursive: true); } catch (_) {} });
    Future<void> settle([int rounds = 8]) async {
      for (var i = 0; i < rounds; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 40)));
        await tester.pump(const Duration(milliseconds: 120));
      }
    }
    Future<void> shot(String name) async {
      await settle();
      final error = tester.takeException();
      if (error != null) debugPrint('[$name] exception: $error');
      await tester.runAsync(() async {
        final boundary = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        final image = await boundary.toImage(pixelRatio: 1);
        final data = await image.toByteData(format: ui.ImageByteFormat.png);
        File(p.join(shots.path, '$name-${dark ? 'dark' : 'light'}.png')).writeAsBytesSync(data!.buffer.asUint8List());
        image.dispose();
      });
    }
    await tester.binding.setSurfaceSize(const Size(1500, 856));
    await agent.setThemeMode(dark ? ThemeMode.dark : ThemeMode.light);
    await tester.pumpWidget(RepaintBoundary(key: key, child: DreamFlutterApp(controller: agent)));
    await tester.runAsync(agent.init);
    await tester.runAsync(agent.refreshSessions);
    await settle();

    // 01/02 schedule: 14th selected, 提醒吃药 open.
    await tester.runAsync(() => agent.openButterfly());
    await tester.runAsync(() async { await agent.butterfly!.refreshSessions(); });
    agent.showSection(AppSection.schedules);
    await settle();
    await shot('01-schedule');
    scheduleNavigationRequest.value = 's_meet';
    await settle();
    await shot('02-schedule-detail');
    // 02b: the prototype's e3 (蝶君去做, with 要做的事); 02c: 新建 with 蝶君去做 picked.
    scheduleNavigationRequest.value = 's_cmp';
    await settle();
    await shot('02b-schedule-butterfly-task');
    await tester.tap(find.text('新建'));
    await settle(4);
    await tester.tap(find.text('到点提醒我').last);
    await settle(3);
    await tester.tap(find.text('蝶君去做').last);
    await shot('02c-schedule-new');

    // 04 goal conversation with the right panel.
    await tester.runAsync(() => agent.butterfly!.openSession(demo.goalPath));
    agent.showSection(AppSection.butterfly);
    agent.butterfly!.setRunPanelOpen(true);
    await settle(14);
    await shot('04-goal');

    // 08 inbox.
    agent.butterfly!.setRunPanelOpen(false);
    await tester.runAsync(agent.refreshPendingCounts);
    agent.showSection(AppSection.tasks);
    await shot('08-inbox');
    await tester.tap(find.text('改一改'));
    await shot('08b-inbox-rule-edit');

    // 11/13/15 settings.
    agent.openSettings('蝶君');
    await shot('11-settings-butterfly');
    // A first-time user: no long goals and no rules yet.
    demo.backend.handlers['autonomy.rules.list'] = (_) => <Json>[];
    demo.backend.handlers['selfwork.longGoals.list'] = (_) => <Json>[];
    agent.openSettings('通用');
    await settle(2);
    agent.openSettings('蝶君');
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
    await settle(4);
    await tester.drag(find.byKey(const ValueKey('settings-蝶君')), const Offset(0, -300));
    await shot('11b-settings-butterfly-empty');
    agent.openSettings('通用');
    await shot('13-settings-general-voice');
    agent.openSettings('数据与安全');
    await shot('15-settings-data-uninstall');

    // 17 skills.
    agent.showSection(AppSection.library);
    await shot('17-skills');

    // 22 workbench.
    agent.showSection(AppSection.chat);
    await tester.runAsync(() => agent.openSession(demo.wbPath));
    await settle();
    await shot('22-workbench');
  });
}
