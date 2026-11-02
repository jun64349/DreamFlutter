import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/message_widgets.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';

void main() {
  Widget host(ToolRun run) => MaterialApp(
    theme: buildTheme(Brightness.light),
    home: Scaffold(body: SizedBox(width: 700, child: ToolStep(run: run))),
  );

  testWidgets('a subagent shows its role and task, what it is doing, then its reply (v0.3 3.4)', (tester) async {
    final run = ToolRun('c1', 'agent')
      ..args = {'role': 'explore', 'description': '查甲', 'prompt': '找甲'}
      ..status = ToolStatus.running
      ..details = {'roleName': '调研员', 'description': '查甲', 'status': 'running', 'activity': 'grep: 甲', 'turns': 1};
    await tester.pumpWidget(host(run));
    expect(find.text('子 Agent · 调研员'), findsOneWidget);
    expect(find.text('查甲 · grep: 甲'), findsOneWidget);

    run
      ..status = ToolStatus.done
      ..output = const [TextBlock('甲在 **a.txt** 第 3 行')]
      ..details = {
        'roleName': '调研员',
        'description': '查甲',
        'status': 'done',
        'activity': null,
        'turns': 2,
        'toolCalls': 3,
        'inputTokens': 1200,
        'outputTokens': 80,
        'cost': 0,
        'model': 'df-x/deepseek-v4.1-flash',
      };
    await tester.pumpWidget(host(ToolRun('c1', 'agent')
      ..args = run.args
      ..status = run.status
      ..output = run.output
      ..details = run.details));
    expect(find.text('查甲'), findsOneWidget, reason: 'no activity once done');
    await tester.tap(find.text('子 Agent · 调研员'));
    await tester.pumpAndSettle();
    expect(find.textContaining('a.txt', findRichText: true), findsWidgets);
    expect(find.textContaining('deepseek-v4.1-flash · 2 轮 · 3 次工具 · 输入'), findsOneWidget);
  });

  test('the work summary counts subagents', () {
    expect(workSummary([ToolRun('a', 'agent'), ToolRun('b', 'agent')]), '派出 2 个子 Agent');
  });
}
