import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/motion.dart';
import 'package:dreamflutter/ui/painting_art.dart';
import 'package:dreamflutter/ui/settings_controls.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  Widget host(Widget child, {PaintingTheme theme = PaintingTheme.warmPaper, bool reduced = false}) => MaterialApp(
        theme: buildTheme(theme.brightness, painting: theme),
        themeAnimationDuration: Duration.zero,
        home: MediaQuery(
          data: MediaQueryData(disableAnimations: reduced),
          child: Scaffold(body: Center(child: child)),
        ),
      );

  testWidgets('press feedback settles and reduced motion bypasses it', (tester) async {
    await tester.pumpWidget(host(const PressFeedback(child: SizedBox(width: 100, height: 40))));
    final gesture = await tester.startGesture(tester.getCenter(find.byType(PressFeedback)));
    await tester.pump();
    await tester.pump(AppTokens.press);
    final transforms = tester.widgetList<Transform>(find.descendant(of: find.byType(PressFeedback), matching: find.byType(Transform)));
    expect(transforms.any((item) => item.transform.storage[0] < .99), isTrue);
    await gesture.up();
    await tester.pumpAndSettle();
    expect(tester.binding.transientCallbackCount, 0);

    await tester.pumpWidget(host(const PressFeedback(child: SizedBox(width: 100, height: 40)), reduced: true));
    expect(find.descendant(of: find.byType(PressFeedback), matching: find.byType(AnimatedBuilder)), findsNothing);
    expect(find.descendant(of: find.byType(PressFeedback), matching: find.byType(Listener)), findsNothing);
  });

  testWidgets('the shared switch has a compact painting and a 48px target', (tester) async {
    var value = false;
    await tester.pumpWidget(host(MotionSwitch(label: '自动记忆', value: value, onChanged: (next) => value = next), theme: PaintingTheme.shiqing));
    expect(tester.getSize(find.byType(MotionSwitch)).height, 48);
    final tracks = tester.widgetList<Material>(find.descendant(of: find.byType(MotionSwitch), matching: find.byType(Material)));
    expect(tracks.any((item) => tester.getSize(find.byWidget(item)) == const Size(38, 22)), isTrue);
    await tester.tap(find.byType(MotionSwitch));
    expect(value, isTrue);
  });

  testWidgets('settings switches use the shared painting without changing saving', (tester) async {
    bool? saved;
    await tester.pumpWidget(host(SettingsSwitch('自动记忆', value: false, save: (next) async => saved = next)));
    expect(find.byType(V1Toggle), findsOneWidget);
    await tester.tap(find.text('自动记忆'));
    await tester.pump();
    expect(saved, isTrue);
  });

  testWidgets('all painting sliders paint with their custom thumbs', (tester) async {
    for (final theme in PaintingTheme.all) {
      await tester.pumpWidget(host(
        SliderTheme(
          data: paintingSliderTheme(theme),
          child: SizedBox(width: 200, child: Slider(value: .5, onChanged: (_) {})),
        ),
        theme: theme,
        reduced: true,
      ));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull, reason: theme.id);
      expect(paintingSliderTheme(theme).thumbShape, isA<PaintingSliderThumbShape>());
    }
  });
}
