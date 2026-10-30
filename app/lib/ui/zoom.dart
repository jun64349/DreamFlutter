import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../state/agent_controller.dart';
import '../state/preferences.dart';
import '../theme.dart';
import 'agent_scope.dart';

/// Applies the text size, and zooms the whole interface (layout, text,
/// dialogs and menus) like a browser: Ctrl + plus / minus / 0 anywhere in the
/// window. The app is laid out at size / zoom and painted scaled up by zoom.
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

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, constraints) => _zoomed(context, constraints.biggest));
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
                duration: const Duration(milliseconds: 150),
                child: _ZoomBadge(zoom: zoom),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _ZoomBadge extends StatelessWidget {
  const _ZoomBadge({required this.zoom});

  final double zoom;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
      decoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.72), borderRadius: BorderRadius.circular(AppTokens.radiusLg)),
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
        SizedBox(
          width: 64,
          child: TextButton(
            onPressed: zoom == 1.0 ? null : () => agent.stepZoom(0),
            child: Tooltip(message: '恢复 100%（Ctrl + 0）', child: Text(zoomPercent(zoom))),
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
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          row('界面缩放', const ZoomControl()),
          row('文字大小', const TextSizeControl()),
          row('主题', const ThemeModeControl()),
          const SizedBox(height: 8),
          Text('快捷键：Ctrl + 加号放大，Ctrl + 减号缩小，Ctrl + 0 恢复。', style: context.text.bodySmall?.copyWith(color: context.colors.muted)),
        ],
      ),
      actions: [TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('完成'))],
    );
  },
);
