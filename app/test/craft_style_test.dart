import 'package:dreamflutter/craft_style.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/settings_controls.dart';
import 'package:dreamflutter/ui/shell_widgets.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('count labels and unknown context affordance stay legible in every painting', (tester) async {
    double contrast(Color a, Color b) {
      final x = a.computeLuminance(), y = b.computeLuminance();
      return x > y ? (x + .05) / (y + .05) : (y + .05) / (x + .05);
    }
    for (final painting in PaintingTheme.all) {
      await tester.pumpWidget(MaterialApp(
        theme: buildTheme(painting.brightness, painting: painting), themeAnimationDuration: Duration.zero,
        home: const Scaffold(body: Center(child: ShellCount(count: '4'))),
      ));
      final foreground = tester.widget<Text>(find.text('4')).style!.color!;
      expect(contrast(foreground, painting.colors.seal), greaterThanOrEqualTo(4.5), reason: painting.id);
      expect(contrast(painting.colors.muted, painting.colors.card), greaterThanOrEqualTo(3), reason: '${painting.id} context outline');
    }
  });

  test('the two silhouettes differ in one color and keep the outline when focused', () {
    const bounds = Rect.fromLTWH(0, 0, 100, 34);
    const curved = CraftSurfaceBorder(geometry: CraftGeometry.curved, radius: 10);
    const angular = CraftSurfaceBorder(geometry: CraftGeometry.angular, radius: 10);
    const corner = Offset(2, 2);
    expect(curved.getOuterPath(bounds).contains(corner), isFalse);
    expect(angular.getOuterPath(bounds).contains(corner), isTrue);

    final focused = angular.copyWith(side: const BorderSide(width: 2));
    expect(focused.getOuterPath(bounds).contains(corner), isTrue);
    expect(focused.getInnerPath(bounds).contains(corner), isFalse);
    expect(focused.getInnerPath(bounds).contains(bounds.center), isTrue);
    expect(craftInputBorder(CraftGeometry.angular).isOutline, isTrue);
    expect((craftInputBorder(CraftGeometry.angular).shape as CraftSurfaceBorder).geometry, CraftGeometry.angular);
  });

  testWidgets('settings control states share the shape without forcing motion', (tester) async {
    final focus = FocusManager.instance;
    final previous = focus.highlightStrategy;
    focus.highlightStrategy = FocusHighlightStrategy.alwaysTraditional;
    addTearDown(() => focus.highlightStrategy = previous);
    await tester.pumpWidget(MaterialApp(
      theme: buildTheme(Brightness.dark, painting: PaintingTheme.shensi),
      home: MediaQuery(
        data: const MediaQueryData(disableAnimations: true),
        child: Scaffold(body: Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
          V1Seg<int>(value: 2, options: const [(1, '全部'), (2, '文档')], onChanged: (_) {}),
          const V1Toggle(value: true),
        ]))),
      ),
    ));

    final segment = tester.widget<TextButton>(find.widgetWithText(TextButton, '文档'));
    final style = segment.style!;
    expect((style.shape!.resolve({}) as CraftSurfaceBorder).geometry, CraftGeometry.angular);
    expect(style.side!.resolve({WidgetState.focused})?.width, 2);
    expect(style.overlayColor!.resolve({WidgetState.pressed})!.a, greaterThan(style.overlayColor!.resolve({WidgetState.hovered})!.a));
    expect(style.overlayColor!.resolve({WidgetState.disabled, WidgetState.focused}), Colors.transparent);
    expect(style.animationDuration, Duration.zero);
    expect(tester.getSize(find.byType(V1Toggle)), const Size(38, 22));
    final disabled = tester.widget<TextButton>(find.descendant(of: find.byType(V1Toggle), matching: find.byType(TextButton)));
    expect(disabled.onPressed, isNull);
  });
}
