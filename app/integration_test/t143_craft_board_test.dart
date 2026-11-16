import 'dart:io';
import 'dart:ui' as ui;

import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/composer.dart';
import 'package:dreamflutter/ui/proto_icon.dart';
import 'package:dreamflutter/ui/settings_controls.dart';
import 'package:dreamflutter/ui/shell_widgets.dart';
import 'package:dreamflutter/ui/sidebar.dart';
import 'package:dreamflutter/ui/zoom.dart' show PaperSettings;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../test/fake_backend.dart';

const _icons = [
  ('chat', '对话'),
  ('memory', '记忆'),
  ('cal', '日程'),
  ('file', '文件'),
  ('search', '搜索'),
  ('gear', '设置'),
  ('send', '发送'),
  ('stop', '停止'),
];

typedef _ControlRow = (String, List<(String, ui.Image)>);

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('T-143 production craft controls side by side', (tester) async {
    const model = 'opencode-go/deepseek-v4.1-flash';
    final root = Directory.systemTemp.createTempSync('df_craft_board_');
    SharedPreferences.setMockInitialValues({
      'onboarded': true,
      'modelKey': model,
      'workspace': root.path,
    });
    final backend = FakeBackend()
      ..sessionsDir = root.path
      ..settings['defaultModel'] = model;
    backend.handlers['settings.get'] = (_) => backend.settings;
    final agent = AgentController(
      preferences: await Preferences.load(),
      sessionStore: SessionStore(sessionsDir: root.path),
      backend: backend,
    );
    final capture = GlobalKey();
    final images = <ui.Image>[];
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      agent.dispose();
      for (final image in images) {
        image.dispose();
      }
      await tester.binding.setSurfaceSize(null);
      // The test wrapper owns TEMP. This fixture creates no files here.
      if (root.listSync().isEmpty) root.deleteSync();
    });
    await tester.binding.setSurfaceSize(const Size(1500, 1280));

    Future<void> settle() async {
      for (var step = 0; step < 3; step++) {
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 35)),
        );
        await tester.pump(const Duration(milliseconds: 120));
      }
    }

    RenderRepaintBoundary boundary() =>
        capture.currentContext!.findRenderObject()! as RenderRepaintBoundary;

    Future<ui.Image> sample(Finder finder) async {
      final frame = boundary();
      final rect = tester
          .getRect(finder)
          .shift(-frame.localToGlobal(Offset.zero))
          .inflate(4);
      final image = await tester.runAsync(() async {
        final source = await frame.toImage();
        final recording = ui.PictureRecorder();
        final destination = Rect.fromLTWH(0, 0, rect.width, rect.height);
        Canvas(recording).drawImageRect(source, rect, destination, Paint());
        final picture = recording.endRecording();
        final crop = await picture.toImage(
          rect.width.ceil(),
          rect.height.ceil(),
        );
        picture.dispose();
        source.dispose();
        return crop;
      });
      images.add(image!);
      return image;
    }

    Future<void> focusWithTab(Finder finder, {required String reason}) async {
      final target = tester.element(finder);
      bool hasFocus() {
        final focused = FocusManager.instance.primaryFocus?.context;
        if (focused == target) return true;
        var found = false;
        focused?.visitAncestorElements((element) {
          found = element == target;
          return !found;
        });
        return found;
      }

      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pump();
      for (var tab = 0; tab < 40 && !hasFocus(); tab++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.tab);
        await tester.pump();
      }
      expect(hasFocus(), isTrue, reason: reason);
      await settle();
    }

    Future<(ui.Image, ui.Image)> pointerStates(Finder finder) async {
      final center = tester.getCenter(finder);
      final mouse = await tester.createGesture(kind: ui.PointerDeviceKind.mouse);
      await mouse.addPointer(location: center);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 140));
      final hover = await sample(finder);
      await mouse.down(center);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 140));
      final pressed = await sample(finder);
      await mouse.cancel();
      await mouse.removePointer();
      await settle();
      return (hover, pressed);
    }

    Finder button(String tooltip) => find.byWidgetPredicate(
      (widget) => widget is IconButton && widget.tooltip == tooltip,
    );
    final input = find.byKey(const ValueKey('composer-input'));
    Future<void> setDraft(String value) async {
      tester.binding.focusedEditable = null;
      await tester.enterText(input, value);
      await settle();
    }

    final columns = <Widget>[];
    await tester.runAsync(agent.init);
    for (final (theme, craft) in [
      (PaintingTheme.jiadie, '宋瓷圆润'),
      (PaintingTheme.shensi, '欧洲嵌木截角'),
    ]) {
      await agent.setDecorativeMotion(false);
      await agent.setPaperTexture('xuan');
      await agent.setPaperStrength(.04);
      await tester.pumpWidget(
        RepaintBoundary(
          key: capture,
          child: MaterialApp(
            theme: buildTheme(theme.brightness, painting: theme),
            home: AgentScope(
              controller: agent,
              child: Scaffold(
                body: Row(
                  children: [
                    const Sidebar(),
                    Expanded(
                      child: Center(
                        child: SizedBox(
                          width: 700,
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              Row(children: [
                                ShellButton('保存', kind: ShellButtonKind.primary, onPressed: () {}),
                                const SizedBox(width: 12),
                                const ShellButton('不可保存', kind: ShellButtonKind.primary, onPressed: null),
                              ]),
                              AutoSaveField(label: '称呼', value: '小周', compact: true, save: (_) async {}),
                              const PaperSettings(),
                              const SizedBox(height: 20),
                              Composer(key: ValueKey(theme.id), home: true, contained: true),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
      await tester.runAsync(() => agent.newSession(forceNew: true));
      await settle();
      expect(agent.isReady, isTrue);

      final selected = find.ancestor(
        of: find.text('工作台'),
        matching: find.byWidgetPredicate(
          (widget) => widget is Semantics && widget.properties.selected == true,
        ),
      );
      final selectedImage = await sample(selected);
      final send = button('发送');
      expect(tester.widget<IconButton>(send).onPressed, isNull);
      final disabledImage = await sample(send);
      await setDraft('核对实验记录');
      expect(tester.widget<IconButton>(send).onPressed, isNotNull);
      FocusManager.instance.primaryFocus?.unfocus();
      await settle();
      final sendImage = await sample(send);
      final (sendHover, sendPressed) = await pointerStates(send);
      await focusWithTab(
        send,
        reason: 'Tab focuses the production send button in ${theme.name}',
      );
      final focusImage = await sample(send);

      await setDraft('');
      FocusManager.instance.primaryFocus?.unfocus();
      final pi = backend.pis.firstWhere(
        (pi) => pi.slotId == agent.active?.slotId,
      );
      pi.startRun('核对实验记录');
      await settle();
      final stop = button('停止');
      expect(tester.widget<IconButton>(stop).onPressed, isNotNull);
      final stopImage = await sample(stop);
      pi.finishRun();
      await settle();

      final save = find.widgetWithText(TextButton, '保存');
      final disabledSave = find.widgetWithText(TextButton, '不可保存');
      expect(tester.widget<TextButton>(disabledSave).onPressed, isNull);
      final saveNormal = await sample(save);
      final saveDisabled = await sample(disabledSave);
      final (saveHover, savePressed) = await pointerStates(save);
      await focusWithTab(save, reason: 'Tab focuses the production text button in ${theme.name}');
      final saveFocus = await sample(save);

      final field = find.descendant(of: find.byType(AutoSaveField), matching: find.byType(TextField));
      final fieldNormal = await sample(field);
      await focusWithTab(field, reason: 'Tab focuses the settings input in ${theme.name}');
      final fieldFocus = await sample(field);
      FocusManager.instance.primaryFocus?.unfocus();
      await settle();

      Finder inPaper(Finder finder) => find.descendant(of: find.byType(PaperSettings), matching: finder);
      final toggle = inPaper(find.byType(V1Toggle));
      final toggleOff = await sample(toggle);
      await tester.tap(toggle);
      await settle();
      expect(tester.widget<V1Toggle>(toggle).value, isTrue);
      final toggleOn = await sample(toggle);
      final segmented = inPaper(find.byType(V1Seg<String>));
      final segmentBefore = await sample(segmented);
      await tester.tap(inPaper(find.text('棉纸')));
      await settle();
      expect(tester.widget<V1Seg<String>>(segmented).value, 'cotton');
      final segmentAfter = await sample(segmented);
      final slider = inPaper(find.byType(Slider));
      final sliderBefore = await sample(slider);
      final valueBefore = tester.widget<Slider>(slider).value;
      final sliderRect = tester.getRect(slider);
      await tester.tapAt(Offset(sliderRect.left + sliderRect.width * .8, sliderRect.center.dy));
      await settle();
      expect(tester.widget<Slider>(slider).value, greaterThan(valueBefore));
      final sliderAfter = await sample(slider);

      columns.add(
        Expanded(
          child: Theme(
            data: buildTheme(theme.brightness, painting: theme),
            child: _CraftColumn(
              theme: theme,
              craft: craft,
              controls: [
                ('文字按钮', [('常态', saveNormal), ('悬停', saveHover), ('按下', savePressed), ('键盘焦点', saveFocus), ('禁用', saveDisabled)]),
                ('图标按钮', [('常态', sendImage), ('悬停', sendHover), ('按下', sendPressed), ('键盘焦点', focusImage), ('禁用', disabledImage), ('运行中', stopImage)]),
                ('输入框', [('常态', fieldNormal), ('键盘焦点', fieldFocus)]),
                ('开关', [('关闭', toggleOff), ('开启', toggleOn)]),
                ('分段', [('默认选中', segmentBefore), ('切换选中', segmentAfter)]),
                ('滑块', [('初始值', sliderBefore), ('调整后', sliderAfter)]),
                ('侧栏模式', [('选中工作台', selectedImage)]),
              ],
            ),
          ),
        ),
      );
    }

    await tester.pumpWidget(
      RepaintBoundary(
        key: capture,
        child: MaterialApp(
          theme: buildTheme(Brightness.light),
          home: Scaffold(
            body: Padding(
              padding: const EdgeInsets.fromLTRB(42, 32, 42, 32),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'DreamFlutter 文物组件实装对照',
                    style: TextStyle(fontSize: 27, fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 8),
                  const Text('图标按三种尺寸并排。控件状态按原尺寸截取，来自工作台和外观设置使用的 Flutter 控件。'),
                  const SizedBox(height: 22),
                  Expanded(
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        columns.first,
                        const SizedBox(width: 20),
                        columns.last,
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
    await settle();
    expect(tester.takeException(), isNull);
    await tester.runAsync(() async {
      final image = await boundary().toImage();
      final png = await image.toByteData(format: ui.ImageByteFormat.png);
      File(p.join('build', 't143-review', 'craft-components.png'))
        ..createSync(recursive: true)
        ..writeAsBytesSync(png!.buffer.asUint8List(), flush: true);
      image.dispose();
    });
  });
}

class _CraftColumn extends StatelessWidget {
  const _CraftColumn({
    required this.theme,
    required this.craft,
    required this.controls,
  });

  final PaintingTheme theme;
  final String craft;
  final List<_ControlRow> controls;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Material(
      color: colors.card,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: colors.border),
      ),
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '$craft · ${theme.name}主题',
              style: TextStyle(
                fontSize: 22,
                color: colors.ink,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 14),
            Row(
              children: [
                const Expanded(child: SizedBox()),
                for (final label in ['16 px', '20 px', '32 px 放大样'])
                  Expanded(
                    child: Text(
                      label,
                      textAlign: TextAlign.center,
                      style: TextStyle(color: colors.ink2),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 5),
            for (final (icon, label) in _icons)
              Container(
                height: 45,
                decoration: BoxDecoration(
                  border: Border(
                    top: BorderSide(
                      color: colors.border.withValues(alpha: .35),
                    ),
                  ),
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(label, style: TextStyle(color: colors.ink)),
                    ),
                    for (final size in [16.0, 20.0, 32.0])
                      Expanded(
                        child: Center(
                          child: ProtoIcon(icon, size: size, color: colors.ink),
                        ),
                      ),
                  ],
                ),
              ),
            const SizedBox(height: 22),
            Text(
              '实际控件',
              style: TextStyle(
                fontSize: 16,
                color: colors.ink,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 12),
            for (final (control, states) in controls)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(width: 78, child: Text(control, style: TextStyle(color: colors.ink))),
                    Expanded(
                      child: Wrap(
                        spacing: 12,
                        runSpacing: 8,
                        children: [
                          for (final (label, image) in states)
                            Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                RawImage(
                                  image: image,
                                  width: image.width.toDouble(),
                                  height: image.height.toDouble(),
                                ),
                                const SizedBox(height: 4),
                                Text(label, style: TextStyle(color: colors.ink2)),
                              ],
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
