import 'package:dreamflutter/ui/message_widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';

ToolRun tool(String name, Json args, {int? ms, ToolStatus status = ToolStatus.done, Json details = const {}}) => ToolRun('id-$name-${args.hashCode}', name)
  ..args = args
  ..durationMs = ms
  ..status = status
  ..details = details;

void main() {
  test('a run of work is summed up in one line', () {
    final steps = <Object>[
      ThinkingPart('先看看数据', durationMs: 12400),
      tool('read', {'path': 'a.xlsx'}),
      tool('read', {'path': 'b.csv'}),
      tool('read', {'path': 'a.xlsx'}),
      tool('bash', {'command': 'python x.py'}),
      tool('edit', {'path': 'r.md'}),
      tool('edit', {'path': 'r.md'}),
      tool('grep', {'pattern': 'todo'}),
      tool('memory_propose', {'text': 'x'}),
    ];
    expect(workSummary(steps), '思考了 12 秒 · 读取 2 个文件 · 搜索 1 次 · 运行 1 条命令 · 修改 1 个文件 · 调用 1 次工具');
    expect(workSummary([ThinkingPart('x')]), '思考过', reason: 'no timing from history');
  });

  test('an edit shows the patch Pi returned, else the requested replacement', () {
    final done = tool('edit', {'path': 'a.txt'}, details: {
      'patch': 'Index: a.txt\n===\n--- a.txt\n+++ a.txt\n@@ -1,3 +1,3 @@\n keep\n-old line\n+new line\n@@ -9,1 +9,2 @@\n tail\n+added',
    });
    final lines = editDiff(done);
    expect(lines.map((l) => (l.kind, l.text)), [
      (DiffKind.context, 'keep'),
      (DiffKind.removed, 'old line'),
      (DiffKind.added, 'new line'),
      (DiffKind.gap, '⋯'),
      (DiffKind.context, 'tail'),
      (DiffKind.added, 'added'),
    ]);

    final running = tool('edit', {
      'path': 'a.txt',
      'edits': [
        {'oldText': 'a\nb', 'newText': 'c'},
      ],
    }, status: ToolStatus.running);
    expect(editDiff(running).map((l) => (l.kind, l.text)), [(DiffKind.removed, 'a'), (DiffKind.removed, 'b'), (DiffKind.added, 'c')]);
  });

  test('a reply lists its model, tokens, speed, time and cost', () {
    final start = DateTime(2026, 10, 30, 14, 32);
    final first = AssistantItem('a1')
      ..model = 'deepseek-flash'
      ..timestamp = start.millisecondsSinceEpoch
      ..usage = const Usage(input: 6000, output: 100, cacheRead: 3000, costTotal: 0.004)
      ..requestedAt = start
      ..firstTokenAt = start.add(const Duration(milliseconds: 700))
      ..endedAt = start.add(const Duration(seconds: 2, milliseconds: 700));
    final second = AssistantItem('a2')
      ..model = 'deepseek-flash'
      ..usage = const Usage(input: 400, output: 1000, costTotal: 0.008)
      ..requestedAt = start.add(const Duration(seconds: 5))
      ..firstTokenAt = start.add(const Duration(seconds: 6))
      ..endedAt = start.add(const Duration(seconds: 24));
    final facts = replyFacts([first, second], modelName: (id) => id == 'deepseek-flash' ? 'DeepSeek V4.1 Flash' : id, now: start);
    expect(facts, 'DeepSeek V4.1 Flash · 输入 6.4K · 输出 1.1K · 缓存 3.0K · 首字 0.7 秒 · 55 token/秒 · 耗时 24 秒 · \$0.01 · 14:32');
    expect(replyFactsShort([first, second], modelName: (id) => 'DeepSeek V4.1 Flash'), 'DeepSeek V4.1 Flash · 24 秒 · \$0.01', reason: 'what stays under the reply (0.4)');

    final history = AssistantItem('h')
      ..model = 'm'
      ..timestamp = DateTime(2026, 10, 1, 9, 5).millisecondsSinceEpoch
      ..usage = const Usage(output: 10);
    expect(replyFacts([history], modelName: (id) => id, now: start), 'm · 输出 10 · 10月1日 09:05', reason: 'no live timing for history');
  });
}
