import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:dreamflutter/butterfly_art.dart';
import 'package:dreamflutter/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

import 'themes_test.dart' show contrast;

/// Where a point of the 1024 grid lands in a mark of [size] (same fitting as ButterflyPainter.fit).
Offset _at(double x, double y, Size size) {
  const box = butterflyBox;
  final s = (size.width / box.width) < (size.height / box.height) ? size.width / box.width : size.height / box.height;
  return Offset((size.width - box.width * s) / 2 + (x - box.left) * s, (size.height - box.height * s) / 2 + (y - box.top) * s);
}

Future<(ByteData, Size)> _paint(WidgetTester tester, Widget mark, PaintingTheme theme, {String name = ''}) async {
  final key = GlobalKey();
  await tester.pumpWidget(
    MaterialApp(
      theme: buildTheme(theme.brightness, painting: theme),
      home: Center(child: RepaintBoundary(key: key, child: mark)),
    ),
  );
  await tester.pumpAndSettle(); // the theme fades in from the previous one
  final boundary = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  final image = (await tester.runAsync(() => boundary.toImage()))!;
  final bytes = (await tester.runAsync(() => image.toByteData()))!;
  final size = Size(image.width.toDouble(), image.height.toDouble());
  const dump = String.fromEnvironment('BUTTERFLY_DUMP');
  if (dump.isNotEmpty) {
    final png = (await tester.runAsync(() => image.toByteData(format: ui.ImageByteFormat.png)))!;
    File('$dump/${theme.id}$name.png').writeAsBytesSync(png.buffer.asUint8List());
  }
  return (bytes, size);
}

Color _pixel(ByteData rgba, Size size, Offset p) {
  final i = (p.dy.round() * size.width.round() + p.dx.round()) * 4;
  return Color.fromARGB(rgba.getUint8(i + 3), rgba.getUint8(i), rgba.getUint8(i + 1), rgba.getUint8(i + 2));
}

Matcher _near(Color c) => predicate<Color>(
  (p) => ((p.r - c.r).abs() + (p.g - c.g).abs() + (p.b - c.b).abs()) * 255 < 6 && p.a > 0.99,
  'within a few levels of $c',
);

void main() {
  // Points of the 1024 grid (docs/design/assets/butterfly.svg): the left forewing's band,
  // the left forewing's inner core, and the outline between them.
  const band = Offset(240, 330), core = Offset(400, 450), line = Offset(379, 330);

  testWidgets('the mark paints the traced butterfly in each theme\'s colors', (tester) async {
    for (final theme in PaintingTheme.all) {
      final c = theme.colors.butterfly;
      final (rgba, size) = await _paint(tester, const ButterflyMark(size: 400), theme);
      expect(size, const Size(400, 300));
      expect(_pixel(rgba, size, _at(band.dx, band.dy, size)), _near(c.wing), reason: '${theme.id}: band');
      expect(_pixel(rgba, size, _at(core.dx, core.dy, size)), _near(c.core), reason: '${theme.id}: core');
      expect(_pixel(rgba, size, _at(line.dx, line.dy, size)), _near(c.line), reason: '${theme.id}: line');
      // Outside the butterfly stays clear (the window draws it without the icon's square).
      expect(_pixel(rgba, size, const Offset(2, 2)).a, 0, reason: '${theme.id}: ground');
    }
  });

  test('light themes draw dark lines and dark themes white ones, apart from the cores', () {
    for (final theme in PaintingTheme.all) {
      final c = theme.colors.butterfly;
      expect(c.line.computeLuminance() > 0.5, theme.isDark, reason: theme.id);
      if (theme.isDark) expect(c.line, const Color(0xFFFFFFFF), reason: '${theme.id}: white outline (the user\'s call)');
      expect(contrast(c.line, c.core), greaterThanOrEqualTo(4.5), reason: '${theme.id}: line against core');
      expect(contrast(c.line, c.ground), greaterThanOrEqualTo(4.5), reason: '${theme.id}: line against ground');
    }
    // 「蛱蝶」 is the user's icon as it is.
    expect(PaintingTheme.jiadie.colors.butterfly.wing, const Color(0xFFCA704D));
    expect(PaintingTheme.jiadie.colors.butterfly.glow, const Color(0xFFE8CCB0));
  });

  testWidgets('the glyph is one solid silhouette', (tester) async {
    const ink = Color(0xFF123456);
    final (rgba, size) = await _paint(tester, const ButterflyGlyph(size: 400, color: ink), PaintingTheme.jiadie, name: '-glyph');
    for (final p in [band, core, line]) {
      expect(_pixel(rgba, size, _at(p.dx, p.dy, size)), _near(ink));
    }
  });
}
