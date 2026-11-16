import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/context_usage_ring.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  Future<void> show(WidgetTester tester, double? value, {bool reduced = false, PaintingTheme? painting}) async {
    final theme = painting ?? PaintingTheme.jiadie;
    await tester.pumpWidget(MaterialApp(
      theme: buildTheme(theme.brightness, painting: theme), themeAnimationDuration: Duration.zero,
      home: MediaQuery(data: MediaQueryData(disableAnimations: reduced),
        child: Scaffold(body: Center(child: ContextUsageRing(value: value)))),
    ));
  }
  ContextUsagePainter painter(WidgetTester tester) => tester.widget<CustomPaint>(
    find.descendant(of: find.byType(ContextUsageRing), matching: find.byType(CustomPaint)),
  ).painter! as ContextUsagePainter;

  testWidgets('usage animates to its measured value, including falling after compaction', (tester) async {
    await show(tester, .2);
    expect(painter(tester).value, closeTo(.2, .001));
    await show(tester, .8);
    await tester.pump(const Duration(milliseconds: 120));
    expect(painter(tester).value, inExclusiveRange(.2, .8));
    await tester.pumpAndSettle();
    expect(painter(tester).value, closeTo(.8, .001));
    await show(tester, .1);
    await tester.pumpAndSettle();
    expect(painter(tester).value, closeTo(.1, .001));
    await show(tester, 0, reduced: true);
    expect(painter(tester).value, 0);
    await show(tester, null, reduced: true);
    expect(painter(tester).known, isFalse);
    expect(painter(tester).value, 0);
    expect(tester.binding.hasScheduledFrame, isFalse);
  });

  testWidgets('usage stays visible in all themes and reduced motion updates immediately', (tester) async {
    double contrast(Color a, Color b) {
      final x = a.computeLuminance(), y = b.computeLuminance();
      return x > y ? (x + .05) / (y + .05) : (y + .05) / (x + .05);
    }
    for (final theme in PaintingTheme.all) {
      for (final value in [.2, .7, .92]) {
        await show(tester, value, reduced: true, painting: theme);
        expect(painter(tester).value, closeTo(value, .001));
        expect(contrast(painter(tester).color, theme.colors.card), greaterThanOrEqualTo(3), reason: '${theme.id} $value');
      }
    }
  });
}
