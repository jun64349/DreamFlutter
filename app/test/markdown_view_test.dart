import 'dart:io';

import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/markdown_view.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:path/path.dart' as p;

/// The math elements (display flag, TeX) the reply parser finds in [text].
List<(bool, String)> mathIn(String text) {
  final nodes = md.Document(inlineSyntaxes: mathSyntaxes, extensionSet: md.ExtensionSet.gitHubFlavored).parseLines(text.split('\n'));
  final found = <(bool, String)>[];
  void walk(List<md.Node>? nodes) {
    for (final node in nodes ?? const <md.Node>[]) {
      if (node is md.Element) {
        if (node.tag == 'math') found.add((node.attributes['display'] == 'true', node.textContent));
        walk(node.children);
      }
    }
  }

  walk(nodes);
  return found;
}

void main() {
  test('formulas are found in all four spellings', () {
    expect(mathIn(r'质能方程 $E=mc^2$，还有 \(a_i * b_j\)。'), [(false, 'E=mc^2'), (false, r'a_i * b_j')]);
    expect(mathIn('结果：\n\n\$\$\n\\int_0^1 x\\,dx = \\frac12\n\$\$'), [(true, r'\int_0^1 x\,dx = \frac12')]);
    expect(mathIn(r'\[ \sum_{k=1}^n k \]'), [(true, r'\sum_{k=1}^n k')]);
  });

  test('prices and stray dollars stay text', () {
    expect(mathIn(r'苹果 $5 和梨 $10，一共 $15。'), isEmpty);
    expect(mathIn(r'花费 $0.01'), isEmpty);
    expect(mathIn('`\$x\$` 在代码里'), isEmpty);
  });

  // 0.8.3 (user test: a 400 token/s model writing ten thousand characters left the window behind).
  test('a reply splits into blocks at blank lines, but not inside code, formulas or indented parts', () {
    expect(markdownBlocks('第一段\n\n第二段\n\n- 一\n- 二'), ['第一段', '第二段', '- 一\n- 二']);
    expect(markdownBlocks('前\n\n```python\na = 1\n\nb = 2\n```\n\n后'), ['前', '```python\na = 1\n\nb = 2\n```', '后'], reason: 'a code block keeps its blank lines');
    expect(markdownBlocks('1. 第一项\n\n   第一项的第二段\n\n2. 第二项'), ['1. 第一项\n\n   第一项的第二段', '2. 第二项'], reason: 'an indented paragraph belongs to its list item');
    expect(markdownBlocks('\$\$\na\n\nb\n\$\$\n\n后'), ['\$\$\na\n\nb\n\$\$', '后'], reason: 'a formula is one block');
    expect(markdownBlocks('正在写\n\n'), ['正在写\n\n'], reason: 'a blank line at the end waits for the next block');
    expect(markdownBlocks(''), isEmpty);
  });

  testWidgets('a growing reply rebuilds only its last block', (tester) async {
    Future<void> show(String text) => tester.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: Scaffold(body: SingleChildScrollView(child: ReplyMarkdown(text: text)))));
    const done = '# 标题\n\n第一段已经写完了。\n\n| 列 | 值 |\n|---|---|\n| a | 1 |';
    await show('$done\n\n最后一段正在');
    final before = tester.widgetList<MarkdownBody>(find.byType(MarkdownBody)).toList();
    expect(before, hasLength(4));
    await show('$done\n\n最后一段正在写，还在继续。');
    final after = tester.widgetList<MarkdownBody>(find.byType(MarkdownBody)).toList();
    for (var i = 0; i < 3; i++) {
      expect(identical(before[i], after[i]), isTrue, reason: 'finished block $i is handed back as is, so Flutter skips it');
    }
    expect(identical(before[3], after[3]), isFalse);
    expect(find.textContaining('还在继续', findRichText: true), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a reply draws its formulas', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: buildTheme(Brightness.light),
        home: const Scaffold(body: ReplyMarkdown(text: '面积是 \$\\pi r^2\$。\n\n\$\$x^2 + y^2 = 1\$\$\n\n坏公式 \$\\frac{\$ 照原样')),
      ),
    );
    expect(find.byType(Math), findsNWidgets(3));
    expect(tester.takeException(), isNull);
  });

  testWidgets('files named in a reply can be found in Explorer (extra test 9)', (tester) async {
    final dir = Directory.systemTemp.createTempSync('df_links_');
    File(p.join(dir.path, 'report.docx')).writeAsStringSync('x');
    final revealed = <String>[];
    final opened = <String>[];
    await tester.pumpWidget(
      MaterialApp(
        theme: buildTheme(Brightness.light),
        home: Scaffold(
          body: FileLinks(
            baseDir: dir.path,
            reveal: revealed.add,
            open: opened.add,
            child: ReplyMarkdown(text: '产物：`report.docx`，不存在的 `missing.pdf`，代码 `x = 1`，文件夹 `${dir.path}`。'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('report.docx'));
    expect(revealed, [p.join(dir.path, 'report.docx')]);
    await tester.tap(find.text(dir.path));
    expect(opened, [p.normalize(dir.path)], reason: 'a folder opens');
    expect(find.byType(FileLink), findsNWidgets(2), reason: 'missing files and code stay plain');
    expect(find.byType(Tooltip), findsNothing, reason: 'the hover says it is a link, no note (v0.3.3 test)');
    dir.deleteSync(recursive: true);
  });

  // v0.3.1 test 3, and again in v0.3.3 (「还是没法显示已选中」): a text ground
  // over inline code hides the selection. Taking it out of our style was not
  // enough: the Markdown package merges its own default code style, which has one.
  testWidgets('inline code and file links have no ground over the selection', (tester) async {
    final dir = Directory.systemTemp.createTempSync('df_links_');
    File(p.join(dir.path, 'notes.md')).writeAsStringSync('x');
    await tester.pumpWidget(
      MaterialApp(
        theme: buildTheme(Brightness.light),
        home: Scaffold(
          body: FileLinks(
            baseDir: dir.path,
            reveal: (_) {},
            open: (_) {},
            child: const ReplyMarkdown(text: '代码 `x = 1` 和文件 `notes.md` 在这里。'),
          ),
        ),
      ),
    );
    final grounds = <String, Color?>{};
    for (final text in tester.widgetList<RichText>(find.byType(RichText))) {
      text.text.visitChildren((span) {
        final words = span is TextSpan ? span.text : null;
        if (words != null && (words.contains('x = 1') || words.contains('notes.md'))) grounds[words] = span.style?.backgroundColor;
        return true;
      });
    }
    expect(grounds.keys, containsAll(['x = 1', 'notes.md']));
    for (final MapEntry(:key, :value) in grounds.entries) {
      expect(value == null || value.a == 0, isTrue, reason: '「$key」 has a ground: $value');
    }
    dir.deleteSync(recursive: true);
  });

  // v0.3.3 test: the link stood on a line of its own, and a selection over the
  // sentence left it unmarked.
  testWidgets('a file link sits inside its sentence and is selected and copied with it', (tester) async {
    final dir = Directory.systemTemp.createTempSync('df_links_');
    File(p.join(dir.path, 'workspace.md')).writeAsStringSync('x');
    String? copied;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') copied = (call.arguments as Map)['text'] as String?;
      return null;
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: buildTheme(Brightness.light),
        home: Scaffold(
          body: SelectionArea(
            child: FileLinks(
              baseDir: dir.path,
              reveal: (_) {},
              open: (_) {},
              child: const ReplyMarkdown(text: 'Before `workspace.md` after the link.'),
            ),
          ),
        ),
      ),
    );
    // One paragraph: the link is a placeholder in the same text, not a widget beside it.
    final paragraph = find.byWidgetPredicate((w) => w is RichText && w.text.toPlainText().startsWith('Before'));
    expect(paragraph, findsOneWidget);
    final link = tester.getRect(find.byType(FileLink));
    final text = tester.getRect(paragraph);
    expect(link.top, greaterThanOrEqualTo(text.top));
    expect(link.bottom, lessThanOrEqualTo(text.top + 40), reason: 'on the first line with the words around it');

    final gesture = await tester.startGesture(text.topLeft + const Offset(1, 8), kind: PointerDeviceKind.mouse);
    await tester.pump();
    await gesture.moveTo(text.bottomRight - const Offset(1, 4));
    await tester.pump();
    await gesture.up();
    await tester.pumpAndSettle();
    final linkText = tester.renderObject<RenderParagraph>(find.descendant(of: find.byType(FileLink), matching: find.byType(RichText)));
    expect(linkText.selections, isNotEmpty, reason: 'the link shows as selected');
    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyC);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pumpAndSettle();
    expect(copied, 'Before workspace.md after the link.');
    dir.deleteSync(recursive: true);
  });
}
