import 'dart:io';

import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/markdown_view.dart';
import 'package:flutter/material.dart';
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
    expect(find.byType(GestureDetector).evaluate().where((e) => (e.widget as GestureDetector).child is Text), hasLength(2), reason: 'missing files and code stay plain');
    dir.deleteSync(recursive: true);
  });
}
