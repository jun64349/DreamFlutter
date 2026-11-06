// Native-font screenshots for T-11's 1000x800 / 150% composer regression.
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import '../test/composer_layout_fixture.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('composer narrow window in light and dark', (tester) async {
    final h = await startComposerLayout(tester);
    final output = Directory('build/t11_composer_shots')..createSync(recursive: true);
    for (final theme in [ThemeMode.light, ThemeMode.dark]) {
      await tester.runAsync(() => h.agent.setThemeMode(theme));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.byKey(const ValueKey('composer-model')), findsOneWidget);
      expect(find.byKey(const ValueKey('composer-thinking')).hitTestable(), findsOneWidget);
      await tester.runAsync(() async {
        final boundary = h.capture.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        final image = await boundary.toImage(pixelRatio: 1);
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        File('${output.path}/${theme.name}-1000x800-150.png').writeAsBytesSync(bytes!.buffer.asUint8List());
        image.dispose();
      });
    }
  });
}
