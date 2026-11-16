import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/painting_art.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('twelve paintings include the three new themes on their proper sides', () {
    expect(PaintingTheme.all, hasLength(12));
    expect(PaintingTheme.all.where((theme) => !theme.isDark), hasLength(6));
    expect(PaintingTheme.all.where((theme) => theme.isDark), hasLength(6));
    expect(PaintingTheme.byId('qiandie', Brightness.light), PaintingTheme.qiandie);
    expect(PaintingTheme.byId('huandie', Brightness.dark), PaintingTheme.huandie);
    expect(PaintingTheme.byId('shiqing', Brightness.dark), PaintingTheme.shiqing);
    expect(PaintingTheme.byId('shiqing', Brightness.light), PaintingTheme.warmPaper);
  });

  testWidgets('every motif paints and reduced motion leaves no running ticker', (tester) async {
    for (final theme in PaintingTheme.all) {
      await tester.pumpWidget(
        MaterialApp(
          themeAnimationDuration: Duration.zero,
          theme: buildTheme(theme.brightness, painting: theme),
          home: MediaQuery(
            data: const MediaQueryData(disableAnimations: true),
            child: const Center(child: PaintingMotif(animate: true)),
          ),
        ),
      );
      await tester.pump();
      expect(find.byType(PaintingMotif), findsOneWidget, reason: theme.id);
      expect(find.descendant(of: find.byType(PaintingMotif), matching: find.byType(AnimatedBuilder)), findsNothing, reason: theme.id);
      expect(tester.takeException(), isNull, reason: theme.id);
      expect(tester.binding.transientCallbackCount, 0, reason: theme.id);
    }
  });

  testWidgets('an ambient motif stops when reduced motion is enabled', (tester) async {
    Widget host(bool reduced) => MaterialApp(
          themeAnimationDuration: Duration.zero,
          theme: buildTheme(Brightness.dark, painting: PaintingTheme.shiqing),
          home: MediaQuery(
            data: MediaQueryData(disableAnimations: reduced),
            child: const Center(child: PaintingMotif(animate: true)),
          ),
        );
    await tester.pumpWidget(host(false));
    await tester.pump(const Duration(milliseconds: 100));
    expect(tester.binding.transientCallbackCount, greaterThan(0));
    await tester.pumpWidget(host(true));
    await tester.pump();
    expect(tester.binding.transientCallbackCount, 0);
  });
}
