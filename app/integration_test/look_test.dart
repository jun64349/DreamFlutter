// Visual check of the chat page with the real fonts, in light and dark:
// a scripted conversation (thinking, read / command / edit tool calls, a
// table, code and a formula) against the fake backend, no model needed.
//   flutter test integration_test/look_test.dart -d windows
// Screenshots go to build/look_shots/.

import 'dart:io';
import 'dart:ui' as ui;

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/library_page.dart' show LibraryPage;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../test/fake_backend.dart';

const _reply = '''
### 华东区本周概况

华东区本周销售 **412.6 万元**，环比增长 8.3%，是唯一超额完成目标的区域。增长主要来自上海和杭州的两家新门店，明细写在 `周报.md` 里，可以对照着看。

| 区域 | 本周（万元） | 环比 | 目标完成率 |
|---|---|---|---|
| 华东 | 412.6 | +8.3% | 103.4% |
| 华南 | 301.2 | −2.1% | 94.0% |

完成率按 \$r = \\frac{\\text{实际}}{\\text{目标}}\$ 计算。

```python
def growth(this_week, last_week):
    return (this_week - last_week) / last_week  # 环比
```

> 下周重点：把上海新店的会员活动复制到南京和苏州。
''';

const Json _todos = {
  'todos': [
    {'content': '读取销售表', 'status': 'completed'},
    {'content': '汇总华东区', 'status': 'in_progress'},
    {'content': '写周报和建议', 'status': 'pending'},
  ],
};
const Json _command = {'description': 'Summarize sales for the east region', 'command': 'python scripts/summary.py --region 华东'};
const Json _edit = {'file_path': 'reports/周报-W44.md', 'old_string': '华东：待补充', 'new_string': '华东：412.6 万，环比 +8.3%'};
const Json _plan = {'plan': '# 周报计划\n\n1. 汇总华东区数据\n2. 写进 reports/周报-W44.md\n3. 给出三条建议'};

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('the chat page in light and dark', (tester) async {
    final shots = Directory(p.join(Directory.current.path, 'build', 'look_shots'))..createSync(recursive: true);
    final key = GlobalKey();
    Future<void> shot(String name) async {
      // The input caret blinks forever, so pump a while instead of settling.
      for (var i = 0; i < 6; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      await tester.runAsync(() async {
        final boundary = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        final image = await boundary.toImage(pixelRatio: 1);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        File(p.join(shots.path, '$name.png')).writeAsBytesSync(png!.buffer.asUint8List());
      });
    }

    final sessions = Directory.systemTemp.createTempSync('df_look_');
    // The reply names this file: it shows as a link inside its sentence.
    File(p.join(sessions.path, '周报.md')).writeAsStringSync('# 周报');
    SharedPreferences.setMockInitialValues({'workspace': sessions.path});
    final backend = FakeBackend()..butterflyHome = p.join(Directory.systemTemp.path, 'df_look_butterfly');
    final agent = AgentController(
      preferences: await Preferences.load(),
      sessionStore: SessionStore(sessionsDir: sessions.path),
      backend: backend,
    );
    addTearDown(() {
      agent.dispose();
      sessions.deleteSync(recursive: true);
    });
    // With the window's own title strip, as the real app runs.
    await tester.pumpWidget(RepaintBoundary(key: key, child: DreamFlutterApp(controller: agent, ownTitleBar: true)));
    await tester.runAsync(agent.init);
    await tester.pump();
    await shot('00_empty_light');

    final pi = backend.pis.single..startRun('把 data/ 里这周的销售表整理成周报，重点看华东区，最后给三条建议。');
    void message(Json message) => pi.emit({'type': 'message_end', 'message': {'role': 'assistant', 'model': 'deepseek-flash', 'provider': 'p', 'stopReason': 'toolUse', 'timestamp': 1793350000000, ...message}});
    void tool(String id, String name, Json args, String output, {Json details = const {}, int ms = 400}) {
      pi
        ..emit({'type': 'tool_execution_start', 'toolCallId': id, 'toolName': name, 'args': args})
        ..emit({
          'type': 'tool_execution_end',
          'toolCallId': id,
          'toolName': name,
          'result': {
            'content': [
              {'type': 'text', 'text': output},
            ],
            'details': details,
          },
          'isError': false,
          'durationMs': ms,
        });
    }

    message({
      'content': [
        {'type': 'thinking', 'thinking': '先读销售表和目标表，再用脚本汇总华东区，最后写周报。'},
        {'type': 'toolCall', 'id': 't0', 'name': 'todo_write', 'arguments': _todos},
        {'type': 'toolCall', 'id': 't1', 'name': 'read', 'arguments': {'file_path': 'data/sales_w44.csv'}},
        {'type': 'toolCall', 'id': 't2', 'name': 'pwsh', 'arguments': _command},
      ],
    });
    tool('t0', 'todo_write', _todos, 'Updated todo list: 1 pending, 1 in progress, 1 completed.');
    pi.emit({'type': 'df_agent_state', 'planMode': false, 'todos': _todos['todos']});
    tool('t1', 'read', {'file_path': 'data/sales_w44.csv'}, '<path>data/sales_w44.csv</path>\n<type>file</type>\n<content>\n1: 区域,本周,上周\n2: 华东,412.6,381.0\n\n(End of file - total 2 lines)\n</content>');
    tool('t2', 'pwsh', _command, '华东  本周 412.6 万  环比 +8.3%  完成率 103.4%\n华南  本周 301.2 万  环比 -2.1%  完成率 94.0%', ms: 3100);
    message({
      'content': [
        {'type': 'toolCall', 'id': 't3', 'name': 'edit', 'arguments': _edit},
        {'type': 'toolCall', 'id': 't4', 'name': 'exit_plan_mode', 'arguments': _plan},
      ],
    });
    tool('t3', 'edit', _edit, 'ok', details: {'patch': '--- a\n+++ b\n@@ -1,3 +1,3 @@\n # 周报\n-华东：待补充\n+华东：412.6 万，环比 +8.3%\n 华南：301.2 万'});
    tool('t4', 'exit_plan_mode', _plan, 'Plan approved', details: {'approved': true});
    message({
      'stopReason': 'stop',
      'usage': {'input': 6400, 'output': 1100, 'cacheRead': 3200, 'totalTokens': 10700, 'cost': {'total': 0.012}},
      'content': [
        {'type': 'text', 'text': _reply},
      ],
    });
    pi.finishRun();
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
    await shot('01_chat_light');

    // The details panel (0.4): opened from the title bar, closed again for the shots below.
    await tester.tap(find.byTooltip(RegExp('^详情')));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 300)));
    await shot('01b_details_light');
    await tester.tap(find.byTooltip('收起详情').first);
    await tester.pumpAndSettle();

    // Open the work block to see the terminal and the diff.
    // In a low window the summary line is above the top of the list: bring it into view first.
    await tester.ensureVisible(find.textContaining('读取 1 个文件'));
    await tester.pump();
    await tester.tap(find.textContaining('读取 1 个文件'));
    await shot('02_work_open_light');

    await agent.setThemeMode(ThemeMode.dark);
    await shot('03_work_open_dark');
    await tester.drag(find.descendant(of: find.byType(SelectionArea), matching: find.byType(Scrollable)).first, const Offset(0, -600));
    await shot('04_reply_dark');

    await agent.newSession();
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
    await shot('05_empty_dark');
    await tester.tap(find.byTooltip(RegExp('^设置')));
    await shot('06_settings_dark');
  });

  testWidgets('the work pages in light and dark', (tester) async {
    final shots = Directory(p.join(Directory.current.path, 'build', 'look_shots'))..createSync(recursive: true);
    final key = GlobalKey();
    Future<void> shot(String name) async {
      for (var i = 0; i < 6; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      await tester.runAsync(() async {
        final boundary = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        final image = await boundary.toImage(pixelRatio: 1);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        File(p.join(shots.path, '$name.png')).writeAsBytesSync(png!.buffer.asUint8List());
      });
    }

    final sessions = Directory.systemTemp.createTempSync('df_look_');
    SharedPreferences.setMockInitialValues({'workspace': sessions.path});
    final backend = FakeBackend()..butterflyHome = p.join(Directory.systemTemp.path, 'df_look_butterfly');
    final now = DateTime.now().millisecondsSinceEpoch;
    final cwd = sessions.path;
    backend.handlers.addAll(_workPages(cwd, now));
    final agent = AgentController(
      preferences: await Preferences.load(),
      sessionStore: SessionStore(sessionsDir: sessions.path),
      backend: backend,
    );
    addTearDown(() {
      agent.dispose();
      sessions.deleteSync(recursive: true);
    });
    await tester.pumpWidget(RepaintBoundary(key: key, child: DreamFlutterApp(controller: agent)));
    await tester.runAsync(agent.init);
    await tester.pump();

    for (final dark in [false, true]) {
      final suffix = dark ? 'dark' : 'light';
      await agent.setThemeMode(dark ? ThemeMode.dark : ThemeMode.light);
      agent.showSection(AppSection.butterfly);
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
      await shot('10_desk_$suffix');
      agent.showSection(AppSection.tasks);
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
      await shot('11_inbox_$suffix');
      await tester.tap(find.text('全部任务'));
      await shot('12_tasks_$suffix');
      await tester.tap(find.text('定时'));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
      await shot('13_schedules_$suffix');
      await tester.tap(find.text('待处理'));
      agent.showSection(AppSection.memory);
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
      await shot('14_memory_candidates_$suffix');
      await tester.tap(find.text('记忆库'));
      await shot('15_memory_library_$suffix');
      await tester.tap(find.text('常驻记忆块'));
      await shot('16_memory_blocks_$suffix');
      await tester.tap(find.text('待确认'));
      agent.showSection(AppSection.library);
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
      Finder onLibrary(String text) => find.descendant(of: find.byType(LibraryPage), matching: find.text(text));
      await tester.tap(onLibrary('技能'));
      await shot('17_skills_$suffix');
      await tester.tap(onLibrary('任务模板'));
      await shot('18_templates_$suffix');
      await tester.tap(onLibrary('待确认'));
      await shot('19_skill_proposals_$suffix');
    }

    // Every painting theme on the desk and the chat page.
    for (final t in PaintingTheme.all.where((t) => t != PaintingTheme.jiadie && t != PaintingTheme.moye)) {
      await agent.setPaintingTheme(t);
      await agent.setThemeMode(t.isDark ? ThemeMode.dark : ThemeMode.light);
      agent.showSection(AppSection.butterfly);
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
      await shot('20_${t.id}_desk');
      agent.showSection(AppSection.chat);
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
      await shot('21_${t.id}_chat');
    }
    await tester.tap(find.byTooltip(RegExp('^外观')));
    await shot('22_appearance');
    await tester.tap(find.text('完成'));
  });
}

/// Fake core answers for the desk, tasks, memory and skills pages.
Map<String, Object? Function(Json)> _workPages(String cwd, int now) {
  const hour = 3600 * 1000;
  final notes = [
    {
      'id': 'w1',
      'cwd': cwd,
      'title': '下周产品发布清单',
      'content': '写给 Agent：按这份清单准备材料，缺的东西列出来问我。\n\n## 发布前\n- [x] 确认发布日期和渠道\n- [ ] 更新官网产品页的截图和价格\n- [ ] 准备三条社交媒体文案（参考品牌规范.pdf）\n\n## 发布当天\n- [ ] 上午 10 点发邮件给老客户\n- [ ] 下午看一次数据，晚上写一份简短复盘',
      'updatedAt': now - hour,
    },
    {'id': 'w2', 'cwd': cwd, 'title': '读书笔记：《置身事内》', 'content': '第三章讲土地财政和地方债。', 'updatedAt': now - 26 * hour},
    {'id': 'w3', 'cwd': cwd, 'title': '周末去杭州', 'content': '订周六上午的高铁，住西湖边。', 'updatedAt': now - 50 * hour},
  ];
  final tasks = [
    {'id': 't1', 'title': '整理下周发布清单', 'goal': '', 'cwd': cwd, 'source': 'note', 'status': 'running', 'noteId': 'w1', 'currentStep': '起草社交媒体文案', 'updatedAt': now},
    {'id': 't2', 'title': '华东区本周销售周报', 'goal': '', 'cwd': cwd, 'source': 'schedule', 'status': 'done', 'runs': 1, 'durationMs': 95000, 'cost': 0.012, 'updatedAt': now - 2 * hour},
    {'id': 't3', 'title': '竞品调研', 'goal': '', 'cwd': cwd, 'source': 'chat', 'status': 'failed', 'runs': 2, 'durationMs': 240000, 'updatedAt': now - 30 * hour},
  ];
  return {
    'sandbox.status': (_) => {'state': 'ready', 'online': true},
    'butterfly.outbox': (_) => [
      {'name': '发布清单.md', 'path': r'\\wsl.localhost\DreamFlutterSandbox\workspace\outbox\发布清单.md', 'size': 3400, 'modifiedAt': now - 600000},
      {'name': '图/销量对比.png', 'path': r'\\wsl.localhost\DreamFlutterSandbox\workspace\outbox\图\销量对比.png', 'size': 84000, 'modifiedAt': now - 900000},
    ],
    'desk.get': (_) => {
      'notes': notes,
      'materials': [
        {'id': 'r1', 'kind': 'file', 'title': '去年发布数据.xlsx', 'path': r'C:\work\去年发布数据.xlsx'},
        {'id': 'r2', 'kind': 'file', 'title': '品牌规范.pdf', 'path': r'C:\work\品牌规范.pdf'},
        {'id': 'r3', 'kind': 'folder', 'title': '官网截图', 'path': r'C:\work\官网截图'},
        {'id': 'r4', 'kind': 'text', 'title': '周一会议纪要', 'content': '决定下周一上线新版首页。'},
      ],
      'tasks': tasks,
      'artifacts': [
        {'id': 'a1', 'path': r'C:\work\reports\周报-W44.md', 'taskId': 't2', 'exists': true, 'updatedAt': now - 2 * hour},
        {'id': 'a2', 'path': r'C:\work\发布文案-草稿.docx', 'taskId': 't1', 'exists': true, 'updatedAt': now - 3 * hour},
        {'id': 'a3', 'path': r'C:\work\竞品价格对比.xlsx', 'taskId': 't3', 'exists': true, 'updatedAt': now - 30 * hour},
      ],
    },
    'cards.list': (_) => const [],
    'tasks.list': (p) => p['noteId'] == 'w1' ? [tasks.first] : tasks,
    'artifacts.list': (_) => const [],
    'memory.list': (p) => p['status'] == 'candidate'
        ? [
            {'id': 'c1', 'scope': 'global', 'kind': 'preference', 'content': '写周报时先给结论，再给表格。', 'source': 'agent', 'status': 'candidate', 'action': 'add', 'reason': '用户在两次周报任务里都要求先写结论。', 'updatedAt': now - hour},
            {'id': 'c2', 'scope': 'global', 'kind': 'background', 'content': '在杭州做产品经理，负责华东区。', 'source': 'agent', 'status': 'candidate', 'action': 'update', 'targetId': 'm2', 'updatedAt': now - 2 * hour},
          ]
        : [
            {'id': 'm1', 'scope': 'global', 'kind': 'preference', 'content': '回答用中文，先给结论；表格比长段落好。', 'source': 'user', 'updatedAt': now - 26 * hour},
            {'id': 'm3', 'scope': 'workspace', 'cwd': cwd, 'kind': 'preference', 'content': '这个项目的文档都放在 docs/ 下，用 Markdown。', 'source': 'manual', 'updatedAt': now - 50 * hour},
            {'id': 'm2', 'scope': 'global', 'kind': 'background', 'content': '在杭州做产品经理。', 'source': 'user', 'updatedAt': now - 80 * hour},
            {'id': 'm4', 'scope': 'global', 'kind': 'experience', 'content': '读销售表时先确认表头那一行，去年的表有合并单元格。', 'source': 'agent', 'updatedAt': now - 120 * hour},
          ],
    'skills.list': (_) => [
      {'name': 'weekly-report', 'description': '把销售表整理成周报：先给结论，再给分区域的表格和三条建议。', 'filePath': r'C:\skills\weekly-report\SKILL.md', 'scope': 'user'},
      {'name': 'pdf-tools', 'description': '读取、合并、拆分 PDF，提取表格和图片。', 'filePath': r'C:\skills\pdf-tools\SKILL.md', 'scope': 'user'},
      {'name': 'release-checklist', 'description': '这个项目的发布清单：版本号、更新日志、打包和上传。', 'filePath': r'C:\work\.pi\skills\release-checklist\SKILL.md', 'scope': 'project', 'enabled': false},
    ],
    'templates.list': (_) => [
      {'name': '周报', 'description': '读取销售表写周报', 'body': '读取 {{文件}}，写成周报。', 'params': [{'name': '文件'}]},
      {'name': '翻译', 'description': '把文件翻译成中文，保留格式', 'body': '把 {{文件}} 翻译成 {{语言}}。', 'params': [{'name': '文件'}, {'name': '语言', 'default': '中文'}]},
    ],
    'proposals.list': (_) => [
      {
        'id': 'p1',
        'title': 'sales-table-check',
        'createdAt': now - hour,
        'payload': {
          'name': 'sales-table-check',
          'description': '读销售表前先检查表头和合并单元格。',
          'content': '---\nname: sales-table-check\ndescription: 读销售表前先检查表头和合并单元格。\n---\n\n1. 先读前 5 行，确认表头在哪一行。\n2. 有合并单元格时先展开再汇总。',
          'scope': 'user',
          'reason': '这次任务里两次因为表头错位重算。',
        },
      },
    ],
    'memory.blocks': (_) => [
      {'key': 'about_me', 'title': '关于我', 'content': '我叫小周，在杭州做产品经理，平时用 Windows。', 'locked': false},
      {'key': 'preferences', 'title': '偏好与习惯', 'content': '回答用中文，先给结论；代码注释用英文。', 'locked': true},
      {'key': 'agreements', 'title': '当前约定', 'content': '', 'locked': false},
    ],
    'inbox.list': (_) => [
      {
        'kind': 'approval',
        'id': 'ui-1',
        'title': 'Agent 请求执行操作\n\n执行命令：\nnpm publish --access public',
        'createdAt': now - 60000,
        'cwd': cwd,
        'sessionFile': r'C:\s\a.jsonl',
        'data': {
          'method': 'select',
          'options': ['允许', '拒绝'],
        },
      },
      {'kind': 'limit', 'id': 'n1', 'title': '已达到单次运行的最大轮数（60 轮）', 'body': '任务「竞品调研」已暂停，可以继续或到此为止。', 'createdAt': now - 3600000, 'cwd': cwd},
      {'kind': 'memory', 'id': 'm1', 'title': '用户写周报时喜欢先给结论，再给表格。', 'createdAt': now - 7200000},
    ],
    'schedules.list': (_) => [
      {'id': 's1', 'name': '华东区周报', 'prompt': '读取 data/ 里这周的销售表，写成周报存到 reports/，最后给三条建议。', 'cwd': cwd, 'kind': 'report', 'trigger': {'type': 'cron', 'cron': '0 9 * * 1'}, 'status': 'active', 'describe': '每周一 9:00', 'nextRunAt': now + 3 * 24 * hour, 'lastRun': {'id': 'r1', 'status': 'done', 'deliveries': [{'channel': 'window', 'status': 'delivered'}]}},
      {'id': 's2', 'name': '接着写读书笔记', 'prompt': '接着上次读到的地方，整理下一章的要点。', 'cwd': cwd, 'kind': 'task', 'trigger': {'type': 'cron', 'cron': '0 21 * * *'}, 'status': 'active', 'describe': '每天 21:00', 'sessionMode': 'bound', 'sessionFile': r'C:\s\b.jsonl', 'nextRunAt': now + 5 * hour},
      {'id': 's3', 'name': '比特币价格', 'prompt': '价格跌破 6 万时提醒我。', 'cwd': cwd, 'kind': 'monitor', 'trigger': {'type': 'interval', 'everyMs': hour}, 'status': 'pending_approval', 'describe': '每 1 小时', 'createdBy': 'agent'},
    ],
  };
}
