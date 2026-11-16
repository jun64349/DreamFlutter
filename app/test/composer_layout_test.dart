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
    final modelText = find.descendant(of: model, matching: find.text(composerChipLabel));
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
    expect(find.text(composerModelName), findsOneWidget, reason: 'full model menu remains available');
    await tester.tapAt(const Offset(5, 5));
    await tester.pumpAndSettle();

    await tester.binding.setSurfaceSize(const Size(1800, 1000));
    await tester.runAsync(() => h.agent.setZoom(1));
    await tester.pumpAndSettle();
    expect(tester.getSize(find.byTooltip('发送')), smallSend);
    expect(tester.getSize(find.byTooltip('添加图片')), smallImage);
    expect(tester.getSize(find.byKey(const ValueKey('composer-body'))).width, 900, reason: 'the user narrowed the home composer while keeping its three input lines');
    expect(tester.getSize(find.byKey(const ValueKey('composer-body'))).height, greaterThanOrEqualTo(125), reason: 'the home composer reserves three input lines above its toolbar');
    final wideLabel = tester.renderObject<RenderParagraph>(find.descendant(of: model, matching: find.text(composerChipLabel)));
    expect(wideLabel.didExceedMaxLines, isFalse, reason: 'a long model and provider label use the available home width: text ${wideLabel.size}, model ${tester.getSize(model)}, composer ${tester.getSize(find.byKey(const ValueKey('composer-body')))}, natural ${wideLabel.getMaxIntrinsicWidth(double.infinity)}');
    // 原型 .pill「💡 中」：思考档写档位；很窄时只剩灯泡（档位字消失）。
    expect(find.descendant(of: thinking, matching: find.text('中')), findsOneWidget);
    expect(tester.getTopLeft(find.byKey(const ValueKey('context-ring'))).dx - tester.getTopRight(thinking).dx, lessThanOrEqualTo(8), reason: 'model and thinking stay beside the voice and send controls, with free space on their left');

    // Sweep only the composer width, so font differences cannot skip either
    // stage. The production window/zoom combination above is tested intact.
    bool sawTruncatedModel = false;
    bool sawTwoRows = false;
    for (final width in [700.0, 600.0, 500.0, 450.0, 400.0, 360.0]) {
      await tester.pumpWidget(AgentScope(controller: h.agent, child: MaterialApp(theme: buildTheme(Brightness.light), home: Scaffold(body: Center(child: SizedBox(width: width, child: const Composer()))))));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull, reason: 'composer width $width');
      final compact = find.descendant(of: thinking, matching: find.text('中')).evaluate().isEmpty;
      if (tester.getTopLeft(thinking).dy < tester.getTopLeft(find.byTooltip('发送')).dy) sawTwoRows = true;
      if (!compact && tester.renderObject<RenderParagraph>(find.descendant(of: model, matching: find.text(composerChipLabel))).didExceedMaxLines) sawTruncatedModel = true;
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

  testWidgets('filled input stays in the narrow-bottom rectangle at zoom', (tester) async {
    final h = await startComposerLayout(tester);
    final input = find.byKey(const ValueKey('composer-input'));
    final body = find.byKey(const ValueKey('composer-body'));
    final text = List.generate(12, (i) => '第 ${i + 1} 行：中文文字与 English words，检查选区和光标。${'long_filename_without_spaces_' * 4}').join('\n');
    await tester.binding.setSurfaceSize(const Size(1500, 920));
    for (final painting in [PaintingTheme.jiadie, PaintingTheme.shensi]) {
      await h.agent.setPaintingTheme(painting);
      for (final zoom in [1.0, 1.25, 1.5]) {
        await h.agent.setZoom(zoom);
        await tester.pumpAndSettle();
        await tester.enterText(input, text);
        await tester.pumpAndSettle();
        final field = tester.widget<TextField>(input);
        field.controller!.selection = TextSelection(baseOffset: text.length - 40, extentOffset: text.length);
        await tester.pump();
        final bodyRect = tester.getRect(body);
        final editorRect = tester.getRect(find.descendant(of: input, matching: find.byType(EditableText)));
        // Convert from the zoomed window into the composer's own coordinates.
        final localEditor = Rect.fromLTRB(
          (editorRect.left - bodyRect.left) / zoom, (editorRect.top - bodyRect.top) / zoom,
          (editorRect.right - bodyRect.left) / zoom, (editorRect.bottom - bodyRect.top) / zoom,
        );
        final shape = (tester.widget<AnimatedContainer>(body).decoration! as ShapeDecoration).shape;
        final path = shape.getInnerPath(Rect.fromLTWH(0, 0, bodyRect.width / zoom, bodyRect.height / zoom));
        for (final point in [localEditor.topLeft, localEditor.topRight, localEditor.bottomLeft, localEditor.bottomRight]) {
          expect(path.contains(point), isTrue, reason: '${painting.id} at $zoom: edit corner $point must remain inside the narrow-bottom outline');
        }
        expect(field.minLines, 3);
        expect(field.maxLines, 8);
        expect(field.controller!.text, text);
        expect(tester.takeException(), isNull);
      }
    }
  });
}
