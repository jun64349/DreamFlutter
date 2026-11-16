import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../state/agent_controller.dart';
import '../state/preferences.dart';
import '../theme.dart';
import '../craft_style.dart';
import 'agent_scope.dart';
import 'keys.dart';
import 'motion.dart';
import 'painting_art.dart';
import 'settings_controls.dart' show SettingRow, V1Seg, V1Toggle;

/// Applies the text size, and zooms the whole interface (layout, text,
/// dialogs and menus) like a browser: Ctrl + wheel or Ctrl + plus / minus / 0
/// anywhere in the window. The app is laid out at size / zoom and painted scaled up by zoom.
class AppZoom extends StatefulWidget {
  const AppZoom({super.key, required this.controller, required this.zoom, required this.textScale, required this.child});

  final AgentController controller;
  final double zoom;
  final double textScale;
  final Widget child;

  @override
  State<AppZoom> createState() => _AppZoomState();
}

class _AppZoomState extends State<AppZoom> {
  var _showLevel = false;
  Timer? _hideLevel;

  @override
  void initState() {
    super.initState();
    HardwareKeyboard.instance.addHandler(_onKey);
  }

  @override
  void didUpdateWidget(AppZoom old) {
    super.didUpdateWidget(old);
    if (old.zoom != widget.zoom) {
      _hideLevel?.cancel();
      _showLevel = true;
      _hideLevel = Timer(const Duration(milliseconds: 1200), () {
        if (mounted) setState(() => _showLevel = false);
      });
    }
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_onKey);
    _hideLevel?.cancel();
    super.dispose();
  }

  bool _onKey(KeyEvent event) {
    if (event is KeyUpEvent || !HardwareKeyboard.instance.isControlPressed) return false;
    if (HardwareKeyboard.instance.isAltPressed || HardwareKeyboard.instance.isMetaPressed) return false;
    final step = switch (event.logicalKey) {
      LogicalKeyboardKey.equal || LogicalKeyboardKey.add || LogicalKeyboardKey.numpadAdd => 1,
      LogicalKeyboardKey.minus || LogicalKeyboardKey.numpadSubtract => -1,
      LogicalKeyboardKey.digit0 || LogicalKeyboardKey.numpad0 => 0,
      _ => null,
    };
    if (step == null) return false;
    widget.controller.stepZoom(step);
    return true;
  }

  DateTime _lastWheelStep = DateTime(0);

  /// Ctrl + mouse wheel zooms, one step per notch (a touchpad's stream of small
  /// scrolls is spaced out so one swipe does not jump to the end).
  void _onPointerSignal(PointerSignalEvent event) {
    if (event is! PointerScrollEvent || !HeldKeys.control || event.scrollDelta.dy == 0) return;
    final now = DateTime.now();
    if (now.difference(_lastWheelStep) < const Duration(milliseconds: 90)) return;
    _lastWheelStep = now;
    widget.controller.stepZoom(event.scrollDelta.dy < 0 ? 1 : -1);
  }

  @override
  Widget build(BuildContext context) {
    return Listener(
      onPointerSignal: _onPointerSignal,
      child: ScrollConfiguration(
        behavior: ScrollConfiguration.of(context).copyWith(physics: const _StillWhileZooming(parent: ClampingScrollPhysics(parent: RangeMaintainingScrollPhysics()))),
        child: LayoutBuilder(builder: (context, constraints) => _zoomed(context, constraints.biggest)),
      ),
    );
  }

  Widget _zoomed(BuildContext context, Size available) {
    final zoom = widget.zoom;
    final media = MediaQuery.of(context);
    final size = available / zoom;
    Widget child = MediaQuery(
      data: media.copyWith(
        textScaler: TextScaler.linear(widget.textScale),
        size: size,
        devicePixelRatio: media.devicePixelRatio * zoom,
        padding: media.padding / zoom,
        viewPadding: media.viewPadding / zoom,
        viewInsets: media.viewInsets / zoom,
      ),
      child: widget.child,
    );
    if (zoom != 1.0) {
      child = OverflowBox(
        alignment: Alignment.topLeft,
        minWidth: size.width,
        maxWidth: size.width,
        minHeight: size.height,
        maxHeight: size.height,
        child: Transform.scale(scale: zoom, alignment: Alignment.topLeft, child: child),
      );
    }
    return Stack(
      children: [
        Positioned.fill(child: ClipRect(child: child)),
        Positioned(
          top: 12,
          left: 0,
          right: 0,
          child: IgnorePointer(
            child: Center(
              child: AnimatedOpacity(
                opacity: _showLevel ? 1 : 0,
                duration: AppTokens.motion(context, AppTokens.fast), curve: AppTokens.curve,
                child: _ZoomBadge(zoom: zoom),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// Lists do not scroll while Ctrl is held, so Ctrl + wheel only zooms (as in a browser).
class _StillWhileZooming extends ScrollPhysics {
  const _StillWhileZooming({super.parent});

  @override
  _StillWhileZooming applyTo(ScrollPhysics? ancestor) => _StillWhileZooming(parent: buildParent(ancestor));

  @override
  bool shouldAcceptUserOffset(ScrollMetrics position) => !HeldKeys.control && super.shouldAcceptUserOffset(position);
}

class _ZoomBadge extends StatelessWidget {
  const _ZoomBadge({required this.zoom});

  final double zoom;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
      decoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.72), borderRadius: BorderRadius.circular(context.radiusLg)),
      child: Text(
        '缩放 ${zoomPercent(zoom)}',
        textDirection: TextDirection.ltr,
        style: const TextStyle(color: Colors.white, fontSize: 13, decoration: TextDecoration.none, fontWeight: FontWeight.normal),
      ),
    );
  }
}

String zoomPercent(double zoom) => '${(zoom * 100).round()}%';

/// Zoom choices as the prototype's four-step .seg (90 / 100 / 110 / 125 %);
/// a zoom outside the four (set with Ctrl + wheel) shows up as its own step.
class ZoomControl extends StatelessWidget {
  const ZoomControl({super.key});

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final zoom = agent.zoom;
    final levels = {0.9, 1.0, 1.1, 1.25, zoom}.toList()..sort();
    return V1Seg<double>(
      value: zoom,
      options: [for (final level in levels) (level, zoomPercent(level))],
      onChanged: agent.setZoom,
    );
  }
}

/// Text size choices, shared by the appearance popup and the settings.
class TextSizeControl extends StatelessWidget {
  const TextSizeControl({super.key});

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final current = Preferences.textScales.contains(agent.textScale) ? agent.textScale : 1.0;
    return V1Seg<double>(
      value: current,
      options: const [(0.9, '−2'), (0.95, '−1'), (1.0, '标准'), (1.1, '+1'), (1.25, '+2')],
      onChanged: agent.setTextScale,
    );
  }
}

/// Theme choices, shared by the appearance popup and the settings.
class ThemeModeControl extends StatelessWidget {
  const ThemeModeControl({super.key});

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    return V1Seg<ThemeMode>(
      value: agent.themeMode,
      options: const [(ThemeMode.light, '浅色'), (ThemeMode.dark, '深色'), (ThemeMode.system, '跟随系统')],
      onChanged: agent.setThemeMode,
    );
  }
}

/// The quick appearance popup from the navigation rail.
Future<void> showAppearanceDialog(BuildContext context) => showDialog<void>(
  context: context,
  builder: (context) {
    Widget row(String label, Widget control) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          SizedBox(width: 76, child: Text(label)),
          control,
        ],
      ),
    );
    return AlertDialog(
      title: const Text('外观'),
      content: SingleChildScrollView(
        child: SizedBox(
          // Room for the four daytime themes in one row.
          width: 570,
          child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          row('界面缩放', const ZoomControl()),
          row('文字大小', const TextSizeControl()),
          row('明暗', const ThemeModeControl()),
          const SizedBox(height: 12),
          Text('日间主题', style: context.label),
          const SizedBox(height: 6),
          const ThemePicker(brightness: Brightness.light),
          const SizedBox(height: 12),
          Text('夜间主题', style: context.label),
          const SizedBox(height: 6),
          const ThemePicker(brightness: Brightness.dark),
          const SizedBox(height: 12),
          Text('快捷键：Ctrl + 滚轮或 Ctrl + 加号 / 减号缩放，Ctrl + 0 恢复。', style: context.text.bodySmall?.copyWith(color: context.colors.muted)),
        ],
          ),
        ),
      ),
      actions: [TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('完成'))],
    );
  },
);

/// The painting themes of one side (daytime or night) as the prototype's
/// .tgrid: three columns of cards, each in the theme's own colours; tapping
/// one makes it that side's theme at once.
class ThemePicker extends StatelessWidget {
  const ThemePicker({super.key, required this.brightness});

  final Brightness brightness;

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final appearance = agent.appearance.value;
    final current = PaintingTheme.byId(brightness == Brightness.dark ? appearance.darkTheme : appearance.lightTheme, brightness);
    final themes = PaintingTheme.all.where((t) => t.brightness == brightness).toList();
    return Padding(padding:const EdgeInsets.only(top:4,bottom:12),child:LayoutBuilder(builder: (context, box) {
      final columns = box.maxWidth < 460 ? 2 : 3;
      final width = (box.maxWidth - 10 * (columns - 1)) / columns;
      return Wrap(
        spacing: 10,
        runSpacing: 10,
        children: [
          for (final t in themes)
            Theme(
              data: buildTheme(t.brightness, painting: t),
              child: SizedBox(width: width, child: _ThemeSwatch(theme: t, selected: t.id == current.id, onTap: () => agent.setPaintingTheme(t))),
            ),
        ],
      );
    }));
  }
}

class _ThemeSwatch extends StatelessWidget {
  const _ThemeSwatch({required this.theme, required this.selected, required this.onTap});

  final PaintingTheme theme;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final isNew = const {'qiandie', 'huandie', 'shiqing'}.contains(theme.id);
    return Semantics(
      button: true,
      selected: selected,
      label: theme.work.isEmpty ? theme.name : '${theme.name}：${theme.work}',
      child: PressFeedback(
        child: Material(
          color: c.background,
          shape: CraftSurfaceBorder(geometry: theme.craftGeometry, radius: 12, side: BorderSide(color: selected ? c.accent : c.ink.withValues(alpha: .07), width: selected ? 2 : 1)),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal:10,vertical:12),
              child: Column(children: [
                ClipRRect(
                  borderRadius:BorderRadius.circular(7),
                  child:Container(
                    height:28,width:double.infinity,
                    decoration:BoxDecoration(
                      color:paintingArtAccentFor(theme).withValues(alpha:.06),
                      border:Border(bottom:BorderSide(color:paintingArtAccentFor(theme).withValues(alpha:.14))),
                    ),
                    child:Stack(children:[
                      Positioned(top:-20,left:0,right:0,child:Center(child:PaintingMotif(theme:theme,width:120,height:70,opacity:.52))),
                    ]),
                  ),
                ),
                const SizedBox(height: 8),
                Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                  Flexible(child: Text(theme.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: context.serif(context.text.bodyMedium).copyWith(fontSize:15,color:c.ink,fontWeight:FontWeight.w600))),
                  if (isNew) Padding(padding: const EdgeInsets.only(left: 5), child: Text('新', style: context.text.labelSmall?.copyWith(fontSize: 10, color: c.accent))),
                ]),
                if (theme.work.isNotEmpty) Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Text(theme.work, maxLines: 1, overflow: TextOverflow.ellipsis, textAlign: TextAlign.center, style: context.text.labelSmall?.copyWith(fontSize:11.5,color:c.accent,height:1.45)),
                ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

class PaperSettings extends StatelessWidget {
  const PaperSettings({super.key});
  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    return ValueListenableBuilder(valueListenable: agent.appearance, builder: (context, appearance, _) {
      final colors = context.colors;
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(padding:const EdgeInsets.symmetric(vertical:14),child:Text('昔者庄周梦为胡蝶，栩栩然胡蝶也。',textAlign:TextAlign.center,style:context.serif(context.text.bodyMedium).copyWith(fontSize:16,color:colors.ink))),
        SettingRow('纸质纹理', desc: '给背景和卡片加一点纸的质感', child: V1Seg<String>(
          value: appearance.paperTexture,
          options: const [('off', '关'), ('xuan', '宣纸'), ('cotton', '棉纸'), ('grain', '细颗粒')],
          onChanged: agent.setPaperTexture,
        )),
        SettingRow('纹理强度', indented:true, child: SizedBox(width: 180, child: SliderTheme(data: paintingSliderTheme(context.painting), child: Slider(value: (appearance.paperStrength * 100).clamp(0, 10), min: 0, max: 10, divisions: 10, onChanged: (value) => agent.setPaperStrength(value / 100))))),
        SettingRow('蝴蝶动起来', desc: '等回复时扇翅、呼吸。关掉后装饰和蝴蝶都静止', child: V1Toggle(value: appearance.decorativeMotion, onChanged: agent.setDecorativeMotion)),
      ]);
    });
  }
}

/// The theme as one row of names (1.0 prototype's 「主题」 row): day themes, or night ones for [brightness].
class ThemeChoiceRow extends StatelessWidget {
  const ThemeChoiceRow({super.key, required this.brightness});

  final Brightness brightness;

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final appearance = agent.appearance.value;
    final current = PaintingTheme.byId(brightness == Brightness.dark ? appearance.darkTheme : appearance.lightTheme, brightness);
    return SegmentedButton<String>(
      showSelectedIcon: false,
      style: SegmentedButton.styleFrom(visualDensity: VisualDensity.compact, textStyle: const TextStyle(fontSize: 13)),
      segments: [for (final t in PaintingTheme.all.where((t) => t.brightness == brightness)) ButtonSegment(value: t.id, label: Text(t.name), tooltip: t.work.isEmpty ? null : t.work)],
      selected: {current.id},
      onSelectionChanged: (ids) => agent.setPaintingTheme(PaintingTheme.byId(ids.first, brightness)),
    );
  }
}
