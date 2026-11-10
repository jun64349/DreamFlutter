import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/composer.dart';
import 'package:dreamflutter/theme.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'composer_layout_fixture.dart';

void main() {
  testWidgets('composer at 1000x800 / 150% wraps controls and keeps fixed buttons and menus', (tester) async {
    final h = await startComposerLayout(tester);
    final model = find.byKey(const ValueKey('composer-model'));
    final thinking = find.byKey(const ValueKey('composer-thinking'));
    expect(tester.takeException(), isNull);
    expect(model, findsOneWidget);
    expect(thinking, findsOneWidget);
    final modelText = find.descendant(of: model, matching: find.text(composerModelName));
    expect(tester.renderObject<RenderParagraph>(modelText).didExceedMaxLines, isTrue);
    final smallSend = tester.getSize(find.byTooltip('发送'));
    final smallImage = tester.getSize(find.byTooltip('添加图片'));
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(tester.getCenter(model));
    await tester.pumpAndSettle(const Duration(milliseconds: 700));
    expect(find.textContaining('模型：$composerModelName'), findsOneWidget, reason: 'hover keeps the full name');
    await mouse.removePointer();
    await tester.pumpAndSettle();
    await tester.tap(model);
    await tester.pumpAndSettle();
    expect(find.text(composerModelName), findsNWidgets(2), reason: 'full model menu remains available');
    await tester.tapAt(const Offset(5, 5));
    await tester.pumpAndSettle();

    await tester.binding.setSurfaceSize(const Size(1800, 1000));
    await tester.runAsync(() => h.agent.setZoom(1));
    await tester.pumpAndSettle();
    expect(tester.getSize(find.byTooltip('发送')), smallSend);
    expect(tester.getSize(find.byTooltip('添加图片')), smallImage);
    expect(find.descendant(of: thinking, matching: find.text('思考 · 中')), findsOneWidget);
    expect(find.descendant(of: thinking, matching: find.byIcon(Icons.psychology_outlined)), findsNothing);

    // Sweep only the composer width, so font differences cannot skip either
    // stage. The production window/zoom combination above is tested intact.
    bool sawTruncatedModel = false;
    bool sawTwoRows = false;
    for (final width in [700.0, 600.0, 500.0, 450.0, 400.0, 360.0]) {
      await tester.pumpWidget(AgentScope(controller: h.agent, child: MaterialApp(theme: buildTheme(Brightness.light), home: Scaffold(body: Center(child: SizedBox(width: width, child: const Composer()))))));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull, reason: 'composer width $width');
      final compact = find.descendant(of: thinking, matching: find.byIcon(Icons.psychology_outlined)).evaluate().isNotEmpty;
      if (tester.getTopLeft(thinking).dy < tester.getTopLeft(find.byTooltip('发送')).dy) sawTwoRows = true;
      if (!compact && tester.renderObject<RenderParagraph>(find.descendant(of: model, matching: find.text(composerModelName))).didExceedMaxLines) sawTruncatedModel = true;
      if (compact) {
        expect(sawTruncatedModel, isTrue, reason: 'truncate model before hiding thinking text');
        await tester.tap(thinking);
        await tester.pumpAndSettle();
        await tester.tap(find.text('高').last);
        await tester.runAsync(() async => Future<void>.delayed(const Duration(milliseconds: 30)));
        await tester.pumpAndSettle();
        expect(h.backend.pis.single.commands.any((c) => c['type'] == 'set_thinking_level' && c['level'] == 'high'), isTrue);
        break;
      }
    }
    // With fewer toolbar buttons (1.0 prototype) the sweep can stop before the two-row layout; check it directly.
    await tester.pumpWidget(AgentScope(controller: h.agent, child: MaterialApp(theme: buildTheme(Brightness.light), home: Scaffold(body: Center(child: SizedBox(width: 360, child: const Composer()))))));
    await tester.pumpAndSettle();
    if (tester.getTopLeft(thinking).dy < tester.getTopLeft(find.byTooltip('发送')).dy) sawTwoRows = true;
    expect(sawTruncatedModel, isTrue);
    expect(sawTwoRows, isTrue);
    await tester.tap(thinking); await tester.pumpAndSettle();
    await tester.tap(find.text('高').last); await tester.pumpAndSettle();
    expect(h.backend.pis.single.commands.any((c) => c['type'] == 'set_thinking_level' && c['level'] == 'high'), isTrue);
  });
}
