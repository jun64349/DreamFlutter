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

华东区本周销售 **412.6 万元**，环比增长 8.3%，是唯一超额完成目标的区域。增长主要来自上海和杭州的两家新门店。

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
    SharedPreferences.setMockInitialValues({'workspace': sessions.path});
    final backend = FakeBackend();
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

    // Open the work block to see the terminal and the diff.
    await tester.tap(find.textContaining('读取 1 个文件'));
    await shot('02_work_open_light');

    await agent.setThemeMode(ThemeMode.dark);
    await shot('03_work_open_dark');
    await tester.drag(find.descendant(of: find.byType(SelectionArea), matching: find.byType(Scrollable)).first, const Offset(0, -600));
    await shot('04_reply_dark');

    await agent.newSession();
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
    await shot('05_empty_dark');
    await tester.tap(find.text('设置').first);
    await shot('06_settings_dark');
  });
}
