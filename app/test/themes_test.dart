import 'dart:math' as math;

import 'package:dreamflutter/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// WCAG 2 contrast ratio of two opaque colors.
double contrast(Color a, Color b) {
  double lum(Color c) {
    double ch(double v) => v <= 0.03928 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  }

  final (x, y) = (lum(a), lum(b));
  return (math.max(x, y) + 0.05) / (math.min(x, y) + 0.05);
}

void main() {
  test('themes are found by id and side, with the first theme of each side as the default', () {
    expect({for (final t in PaintingTheme.all) t.id}.length, PaintingTheme.all.length);
    expect(PaintingTheme.byId('caodie', Brightness.light), PaintingTheme.caodie);
    expect(PaintingTheme.byId('youhua', Brightness.dark), PaintingTheme.youhua);
    expect(PaintingTheme.byId('youhua', Brightness.light), PaintingTheme.jiadie, reason: 'a night theme is never used by day');
    expect(PaintingTheme.byId(null, Brightness.dark), PaintingTheme.moye);
    expect(PaintingTheme.byId('gone', Brightness.light), PaintingTheme.jiadie);
  });

  test('every theme keeps its text readable', () {
    for (final t in PaintingTheme.all) {
      final c = t.colors;
      expect(t.colors.background.computeLuminance() < 0.5, t.isDark, reason: '${t.id} brightness');
      for (final ground in [c.background, c.sidebar, c.card]) {
        for (final (name, text) in [('ink', c.ink), ('ink2', c.ink2), ('muted', c.muted)]) {
          expect(contrast(text, ground), greaterThanOrEqualTo(4.5), reason: '${t.id}: $name');
        }
      }
      expect(contrast(c.onAccent, c.accent), greaterThanOrEqualTo(4.5), reason: '${t.id}: button text');
      expect(contrast(c.onTerminal, c.terminal), greaterThanOrEqualTo(4.5), reason: '${t.id}: terminal');
      // The original 「蛱蝶」 colors were chosen before this check; the new themes
      // also keep accent and status colors readable as text.
      if (t == PaintingTheme.jiadie || t == PaintingTheme.moye) continue;
      for (final ground in [c.background, c.sidebar, c.card]) {
        for (final (name, text) in [('accent', c.accent), ('ochre', c.ochre), ('success', c.success), ('warning', c.warning), ('danger', c.danger)]) {
          expect(contrast(text, ground), greaterThanOrEqualTo(4.5), reason: '${t.id}: $name');
        }
      }
    }
  });

  testWidgets('the Material theme carries the painting: radii, heading face, mark', (tester) async {
    late BuildContext captured;
    await tester.pumpWidget(
      MaterialApp(
        theme: buildTheme(Brightness.light, painting: PaintingTheme.yuhua),
        home: Builder(
          builder: (context) {
            captured = context;
            return const Scaffold(body: ThemeMark());
          },
        ),
      ),
    );
    expect(captured.painting, PaintingTheme.yuhua);
    expect(captured.radius, 2);
    expect(captured.serif(null).fontFamily, 'Sitka Heading');
    expect(captured.colors.accent, PaintingTheme.yuhua.colors.accent);
    expect(find.text('Tab. LVIII'), findsOneWidget);

    await tester.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: const Scaffold(body: ThemeMark())));
    await tester.pumpAndSettle(); // the theme change animates
    expect(find.text('梦'), findsOneWidget);
    expect(find.text('蝶'), findsOneWidget);
  });
}
