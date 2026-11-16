import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/message_widgets.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';

/// 0.4 (roadmap 4.4, tests 32 and extra 7): the process of a reply is folded,
/// commands are one line like the other tools, pictures can be opened.
const _png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

var _ids = 0;

ToolRun tool(String name, Json args, {ToolStatus status = ToolStatus.done, String output = '', List<ContentBlock>? blocks}) => ToolRun('t${_ids++}', name)
  ..args = args
  ..status = status
  ..output = blocks ?? [if (output.isNotEmpty) TextBlock(output)];

Future<void> show(WidgetTester tester, Widget child, {Brightness brightness = Brightness.light}) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: buildTheme(brightness),
      home: Scaffold(body: SingleChildScrollView(padding: const EdgeInsets.all(16), child: child)),
    ),
  );
  await tester.pump(const Duration(milliseconds: 400)); // a running block keeps its spinner going
}

void main() {
  testWidgets('while it runs the block is one line and opens every step', (tester) async {
    final steps = <Object>[
      ThinkingPart('先看看数据\n再说'),
      tool('read', {'path': 'a.xlsx'}),
      tool('grep', {'pattern': 'todo'}),
      tool('bash', {'command': 'python make_chart.py'}, output: 'chart saved\nall good'),
      tool('read', {'path': 'report.md'}, status: ToolStatus.running),
    ];
    await show(tester, WorkBlock(steps: steps, active: true));
    expect(find.textContaining('正在读取'), findsOneWidget, reason: 'the header says what it is doing');
    expect(find.text('前面 4 步'), findsOneWidget);
    expect(find.text('python make_chart.py'), findsNothing, reason: 'all steps stay folded');
    expect(find.textContaining('chart saved'), findsNothing, reason: 'its output only when opened');
    expect(find.text('a.xlsx'), findsNothing, reason: 'older steps are behind 「前面」');

    // Opened, every step in full.
    await tester.tap(find.textContaining('正在读取'));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('a.xlsx'), findsOneWidget);
    expect(find.text('前面还有 2 步'), findsNothing);
    expect(find.text('先看看数据\n再说'), findsNothing);
    await tester.tap(find.text('思考'));
    await tester.pump(const Duration(milliseconds: 150));
    expect(find.text('先看看数据\n再说'), findsOneWidget);
  });

  testWidgets('a finished block is one line until opened', (tester) async {
    await show(tester, WorkBlock(steps: [tool('read', {'path': 'a.xlsx'}), tool('bash', {'command': 'dir'})], active: false));
    expect(find.text('读取 1 个文件 · 运行 1 条命令'), findsOneWidget);
    expect(find.text('a.xlsx'), findsNothing);
  });

  testWidgets('work background follows each theme and only thinking text is italic', (tester) async {
    for (final painting in PaintingTheme.all) {
      await tester.pumpWidget(const SizedBox());
      final steps = <Object>[
        ThinkingPart('先核对数据', durationMs: 2000),
        tool('bash', {'command': 'python report.py'}),
      ];
      await tester.pumpWidget(MaterialApp(
        theme: buildTheme(painting.brightness, painting: painting),
        home: Scaffold(body: WorkBlock(steps: steps, active: false)),
      ));
      await tester.pump(const Duration(milliseconds: 400));
      final colors = painting.colors;
      final expected = Color.alphaBlend(colors.accent.withValues(alpha: .08), colors.background);
      final boxes = tester.widgetList<Container>(find.descendant(of: find.byType(WorkBlock), matching: find.byType(Container)));
      expect(boxes.any((box) => switch (box.decoration) {
        BoxDecoration(:final color) || ShapeDecoration(:final color) => color == expected,
        _ => false,
      }), isTrue, reason: painting.id);
      final header = tester.widget<Text>(find.text('思考了 2 秒 · 运行 1 条命令'));
      final spans = (header.textSpan! as TextSpan).children!;
      expect((spans.first as TextSpan).style?.fontStyle, FontStyle.italic);
      expect((spans.last as TextSpan).style?.fontStyle, isNot(FontStyle.italic));
      await tester.tap(find.text('思考了 2 秒 · 运行 1 条命令'));
      await tester.pump(const Duration(milliseconds: 400));
      expect(tester.widget<Text>(find.text('思考 · 2 秒')).style?.fontStyle, FontStyle.italic);
      expect(tester.widget<Text>(find.text('python report.py')).style?.fontStyle, isNot(FontStyle.italic));
      await tester.tap(find.text('思考 · 2 秒'));
      await tester.pump(const Duration(milliseconds: 400));
      expect(tester.widget<Text>(find.text('先核对数据')).style?.fontStyle, FontStyle.italic);
    }
  });

  testWidgets('a command is one line that opens to the terminal; a failed one is open', (tester) async {
    await show(tester, Column(children: [
      ToolStep(run: tool('bash', {'command': 'python ok.py', 'description': '画图'}, output: 'chart saved')),
      ToolStep(run: tool('bash', {'command': 'python bad.py'}, status: ToolStatus.error, output: 'Traceback: boom')),
    ]));
    expect(find.text('画图'), findsOneWidget, reason: 'the purpose names the line');
    expect(find.textContaining('chart saved'), findsNothing);
    expect(find.textContaining('Traceback: boom'), findsOneWidget, reason: 'errors are shown without asking');

    await tester.tap(find.text('画图'));
    await tester.pumpAndSettle();
    expect(find.textContaining('chart saved'), findsOneWidget);
  });

  testWidgets('the terminal takes the page\'s colours by day and its own at night', (tester) async {
    Color groundOf() => (tester.widget<Container>(find.ancestor(of: find.textContaining('python ok.py', findRichText: true), matching: find.byType(Container)).first).decoration! as BoxDecoration).color!;
    final run = tool('bash', {'command': 'python ok.py'}, status: ToolStatus.error, output: 'x');
    await show(tester, ToolStep(run: run));
    expect(groundOf(), AppColors.warmPaper.codeBackground);
    await show(tester, ToolStep(run: run), brightness: Brightness.dark);
    expect(groundOf(), AppColors.twilight.terminal);
  });

  testWidgets('a picture the agent looked at shows small and opens in full', (tester) async {
    await show(tester, ToolStep(run: tool('read_image', {'path': 'chart.png'}, blocks: [const ImageBlock(data: _png, mimeType: 'image/png')])));
    expect(find.byTooltip('点击查看大图'), findsOneWidget);
    await tester.tap(find.byTooltip('点击查看大图'));
    await tester.pumpAndSettle();
    expect(find.byType(InteractiveViewer), findsOneWidget);
    await tester.tap(find.byTooltip('关闭'));
    await tester.pumpAndSettle();
    expect(find.byType(InteractiveViewer), findsNothing);
  });

  testWidgets('an MCP tool says which server and tool', (tester) async {
    await show(tester, ToolStep(run: tool('mcp__github__create_issue', {'title': 'x'})));
    expect(find.text('连接的服务 · github · create_issue'), findsOneWidget);
  });
}
