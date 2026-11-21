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
    expect(find.text('查甲 · 正在搜索 甲'), findsOneWidget);

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

  testWidgets('a child reports progress and distinguishes a partial result from no result', (tester) async {
    final run = ToolRun('c1', 'agent')
      ..status = ToolStatus.running
      ..details = {'roleName': '调研员', 'description': '查甲', 'status': 'running', 'turns': 29, 'maxTurns': 30};
    await tester.pumpWidget(host(run));
    expect(find.text('查甲 · 正在汇报'), findsOneWidget);
    expect(find.text('29/30 轮'), findsOneWidget);
    run
      ..status = ToolStatus.done
      ..output = const [TextBlock('子 Agent 达到 30 轮上限。以下是阶段记录，任务可能未完成。\n\n已核对甲文件。')]
      ..details = {...run.details, 'status': 'stopped', 'turns': 30, 'stoppedBy': 'maxTurns', 'resultKind': 'partial'};
    await tester.pumpWidget(host(run));
    expect(find.text('达到轮数上限'), findsOneWidget);
    await tester.tap(find.text('子 Agent · 调研员'));
    await tester.pumpAndSettle();
    expect(find.text('阶段记录'), findsOneWidget);
    expect(find.textContaining('已核对甲文件。', findRichText: true), findsWidgets);

    run
      ..output = const [TextBlock('(the subagent gave no final reply)\n\n[The subagent reached its limit of 30 turns and stopped; the reply above may be incomplete.]')]
      ..details = {'roleName': '调研员', 'description': '查甲', 'status': 'stopped', 'turns': 30, 'stoppedBy': 'maxTurns'};
    await tester.pumpWidget(host(run));
    expect(find.text('没有可交接的结果'), findsOneWidget);
    expect(find.textContaining('the subagent', findRichText: true), findsNothing);
  });

  test('the work summary counts subagents', () {
    expect(workSummary([ToolRun('a', 'agent'), ToolRun('b', 'agent')]), '派出 2 个子 Agent');
  });
}
