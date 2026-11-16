import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/home_quote.dart';
import 'package:dreamflutter/ui/shell_widgets.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('all painting themes use the quotation of their cultural source', () {
    final chinese = {'warmPaper', 'twilight', 'jiadie', 'moye', 'shiqing'};
    final foreign = {'caodie', 'yuhua', 'shensi', 'qiandie', 'youhua', 'liuguang', 'huandie'};
    expect(PaintingTheme.all.map((theme) => theme.id).toSet(), chinese.union(foreign));
    for (final theme in PaintingTheme.all) {
      final quote = HomeQuoteContent.forTheme(theme.id);
      expect(quote, chinese.contains(theme.id) ? HomeQuoteContent.chinese : HomeQuoteContent.foreign);
    }
    expect(HomeQuoteContent.chinese.source, '《庄子·逍遥游》');
    expect(HomeQuoteContent.foreign.translation, isNotEmpty);
  });

  testWidgets('foreign quote keeps the English italic and attribution below', (tester) async {
    await tester.pumpWidget(MaterialApp(
      theme: buildTheme(Brightness.light, painting: PaintingTheme.caodie),
      home: const Scaffold(body: Center(child: HomeQuote())),
    ));
    final quote = tester.widget<ShellQuoteLine>(find.byType(ShellQuoteLine));
    final original = find.text(quote.line);
    final translation = find.text(quote.translation!);
    final source = find.text(quote.source);
    expect(tester.widget<Text>(original).style?.fontStyle, FontStyle.italic);
    expect(tester.widget<Text>(translation).style?.fontFamily, AppTokens.kaiFamily);
    expect(tester.getTopLeft(translation).dy, greaterThan(tester.getBottomLeft(original).dy));
    expect(tester.getTopLeft(source).dy, greaterThan(tester.getBottomLeft(translation).dy));
    expect(tester.getSize(find.byType(ShellQuoteLine)).height, greaterThanOrEqualTo(100));
  });
}
