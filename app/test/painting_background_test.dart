import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/painting_art.dart';
import 'package:dreamflutter/ui/painting_background.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('craft edges keep card controls clickable and out of semantics', (tester) async {
    var presses = 0;
    await tester.pumpWidget(MaterialApp(
      theme: buildTheme(Brightness.dark, painting: PaintingTheme.shensi),
      home: Center(child: CraftCardEdge(child: SizedBox(
        width: 200, height: 80,
        child: TextButton(onPressed: () => presses++, child: const Text('打开')),
      ))),
    ));
    final edge = find.descendant(of: find.byType(CraftCardEdge), matching: find.byType(CraftOrnament));
    expect(edge, findsOneWidget);
    expect(tester.getSize(find.byType(CraftCardEdge)), const Size(200, 80));
    expect(find.descendant(of: edge, matching: find.byType(ExcludeSemantics)), findsOneWidget);
    expect(tester.widget<IgnorePointer>(find.descendant(of: edge, matching: find.byType(IgnorePointer))).ignoring, isTrue);
    final rect = tester.getRect(find.byType(CraftCardEdge));
    await tester.tapAt(Offset(rect.right - 20, rect.top + 20));
    expect(presses, 1);
  });

  testWidgets('craft edge passes the parent minimum width to its card', (tester) async {
    await tester.pumpWidget(MaterialApp(home: Center(child: ConstrainedBox(
      constraints: const BoxConstraints(minWidth: 220, maxWidth: 320),
      child: const CraftCardEdge(child: SizedBox(width: 80, height: 60)),
    ))));
    expect(tester.getSize(find.byType(CraftCardEdge)), const Size(220, 60));
    expect(tester.getSize(find.descendant(of: find.byType(CraftCardEdge), matching: find.byType(SizedBox)).first), const Size(220, 60));
  });

  testWidgets('all painting backdrops paint at narrow size', (tester) async {
    for (final theme in PaintingTheme.all) {
      for (final surface in PaintingSurface.values) {
        await tester.pumpWidget(
          MaterialApp(
            theme: buildTheme(theme.brightness, painting: theme),
            themeAnimationDuration: Duration.zero,
            home: MediaQuery(
              data: const MediaQueryData(disableAnimations: true),
              child: Center(
                child: SizedBox(
                  width: 760,
                  height: 720,
                  child: PaintingBackdrop(surface: surface, child: const Text('内容')),
                ),
              ),
            ),
          ),
        );
        await tester.pump();
        expect(find.text('内容'), findsOneWidget, reason: '${theme.id} $surface');
        expect(find.byType(CraftOrnament), findsNWidgets(surface == PaintingSurface.home ? 0 : 1), reason: '${theme.id} $surface');
        if (surface == PaintingSurface.home) expect(find.byType(PaintingMotif), findsOneWidget, reason: 'craft detail belongs to the existing home motif');
        expect(tester.takeException(), isNull, reason: '${theme.id} $surface');
      }
    }
  });

  testWidgets('paper grain uses the cached repeatable asset and can be off', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: buildTheme(Brightness.light),
        home: const SizedBox(
          width: 400,
          height: 300,
          child: Stack(children: [PaintingBackdrop(surface: PaintingSurface.home), PaperGrain()]),
        ),
      ),
    );
    await tester.pump();
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
    await tester.pump();
    final image = tester.widget<Image>(find.byType(Image));
    expect(image.repeat, ImageRepeat.repeat);
    expect(image.gaplessPlayback, isTrue);
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(
      MaterialApp(theme: buildTheme(Brightness.light), home: const PaperGrain(strength: 0)),
    );
    expect(find.byType(Image), findsNothing);
  });
}
