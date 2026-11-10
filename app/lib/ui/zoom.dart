import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../state/agent_controller.dart';
import '../state/preferences.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'keys.dart';

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

/// Zoom − 100% + controls, shared by the appearance popup and the settings.
class ZoomControl extends StatelessWidget {
  const ZoomControl({super.key});

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final zoom = agent.zoom;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        IconButton(
          tooltip: '缩小（Ctrl + -）',
          onPressed: zoom > Preferences.zoomLevels.first ? () => agent.stepZoom(-1) : null,
          icon: const Icon(Icons.remove, size: 18),
        ),
        // Grows with the text size instead of wrapping "100 %" onto two lines.
        ConstrainedBox(
          constraints: const BoxConstraints(minWidth: 64),
          child: TextButton(
            onPressed: zoom == 1.0 ? null : () => agent.stepZoom(0),
            child: Tooltip(message: '恢复 100%（Ctrl + 0）', child: Text(zoomPercent(zoom), maxLines: 1, softWrap: false)),
          ),
        ),
        IconButton(
          tooltip: '放大（Ctrl + +）',
          onPressed: zoom < Preferences.zoomLevels.last ? () => agent.stepZoom(1) : null,
          icon: const Icon(Icons.add, size: 18),
        ),
      ],
    );
  }
}

/// Text size choices, shared by the appearance popup and the settings.
class TextSizeControl extends StatelessWidget {
  const TextSizeControl({super.key});

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    return SegmentedButton<double>(
      segments: const [
        ButtonSegment(value: 0.9, label: Text('小')),
        ButtonSegment(value: 1.0, label: Text('标准')),
        ButtonSegment(value: 1.1, label: Text('大')),
        ButtonSegment(value: 1.25, label: Text('特大')),
      ],
      selected: {Preferences.textScales.contains(agent.textScale) ? agent.textScale : 1.0},
      onSelectionChanged: (s) => agent.setTextScale(s.first),
    );
  }
}

/// Theme choices, shared by the appearance popup and the settings.
class ThemeModeControl extends StatelessWidget {
  const ThemeModeControl({super.key});

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    return SegmentedButton<ThemeMode>(
      segments: const [
        ButtonSegment(value: ThemeMode.system, label: Text('跟随系统')),
        ButtonSegment(value: ThemeMode.light, label: Text('浅色')),
        ButtonSegment(value: ThemeMode.dark, label: Text('深色')),
      ],
      selected: {agent.themeMode},
      onSelectionChanged: (s) => agent.setThemeMode(s.first),
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

/// The painting themes of one side (daytime or night) as small previews;
/// tapping one makes it that side's theme.
class ThemePicker extends StatelessWidget {
  const ThemePicker({super.key, required this.brightness});

  final Brightness brightness;

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final appearance = agent.appearance.value;
    final current = PaintingTheme.byId(brightness == Brightness.dark ? appearance.darkTheme : appearance.lightTheme, brightness);
    return Wrap(
      spacing: 10,
      runSpacing: 10,
      children: [
        for (final t in PaintingTheme.all.where((t) => t.brightness == brightness))
          Theme(
            data: buildTheme(t.brightness, painting: t),
            child: _ThemeSwatch(theme: t, selected: t.id == current.id, onTap: () => agent.setPaintingTheme(t)),
          ),
      ],
    );
  }
}

class _ThemeSwatch extends StatelessWidget {
  const _ThemeSwatch({required this.theme, required this.selected, required this.onTap});

  final PaintingTheme theme;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    // Inside a Theme of [theme]: context.colors are the swatch's own.
    final c = context.colors;
    return Semantics(
      button: true,
      selected: selected,
      label: theme.work.isEmpty ? theme.name : '${theme.name}：${theme.work}',
      child: Tooltip(
        message: theme.work.isEmpty ? theme.name : theme.work,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(context.radiusLg),
          child: Container(
            width: 132,
            padding: const EdgeInsets.all(6),
            decoration: BoxDecoration(
              color: c.background,
              borderRadius: BorderRadius.circular(context.radiusLg),
              border: Border.all(color: selected ? c.accent : c.border, width: selected ? 2 : 1),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // A tiny window: rail, side panel, and a card with the butterfly.
                SizedBox(
                  height: 62,
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Container(width: 10, color: c.rail),
                      Container(
                        width: 26,
                        color: c.sidebar,
                        padding: const EdgeInsets.fromLTRB(4, 8, 4, 0),
                        child: Column(
                          children: [
                            for (final w in [1.0, 0.7, 0.85]) ...[
                              FractionallySizedBox(
                                widthFactor: w,
                                child: Container(height: 3, color: c.muted.withValues(alpha: 0.45)),
                              ),
                              const SizedBox(height: 4),
                            ],
                          ],
                        ),
                      ),
                      Expanded(
                        child: Padding(
                          padding: const EdgeInsets.all(6),
                          child: Container(
                            decoration: BoxDecoration(
                              color: c.card,
                              borderRadius: BorderRadius.circular(context.radiusSm),
                              border: Border.all(color: c.border),
                            ),
                            child: Stack(
                              children: [
                                const Center(child: ButterflyMark(size: 30)),
                                Positioned(
                                  left: 5,
                                  bottom: 5,
                                  child: Container(
                                    width: 18,
                                    height: 5,
                                    decoration: BoxDecoration(color: c.accent, borderRadius: BorderRadius.circular(2)),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 6),
                Row(
                  children: [
                    Text(
                      theme.name,
                      style: context.serif(context.text.bodyMedium).copyWith(color: c.ink, fontWeight: FontWeight.w600),
                    ),
                    const Spacer(),
                    if (selected) Icon(Icons.check, size: 14, color: c.accent),
                  ],
                ),
                if (theme.work.isNotEmpty) Text(
                  theme.work,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: context.text.labelSmall?.copyWith(color: c.muted, height: 1.35),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
