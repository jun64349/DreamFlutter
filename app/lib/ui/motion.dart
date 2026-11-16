import 'package:flutter/material.dart';

import '../theme.dart';
import 'settings_controls.dart' show V1Toggle;

/// Restrained motion shared by the pages: a breathing dot for running work,
/// a fade-and-rise for new content, and the streaming caret.

/// A small accent dot that slowly fades in and out while something runs.
class BreathingDot extends StatefulWidget {
  const BreathingDot({super.key, this.size = 7, this.color});

  final double size;
  final Color? color;

  @override
  State<BreathingDot> createState() => _BreathingDotState();
}

class _BreathingDotState extends State<BreathingDot> with SingleTickerProviderStateMixin {
  late final _controller = AnimationController(vsync: this, duration: AppTokens.slow * 4);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context) || !TickerMode.valuesOf(context).enabled) {
      _controller.stop();
      _controller.value = 1;
    } else if (!_controller.isAnimating) {
      _controller.repeat(reverse: true);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: Tween(begin: 0.35, end: 1.0).animate(CurvedAnimation(parent: _controller, curve: AppTokens.curve)),
      child: Container(
        width: widget.size,
        height: widget.size,
        decoration: BoxDecoration(color: widget.color ?? context.colors.accent, shape: BoxShape.circle),
      ),
    );
  }
}

/// Fades [child] in while it rises a few pixels, once, when first built with
/// [animate] set (content arriving live; history appears at once).
class FadeSlideIn extends StatefulWidget {
  const FadeSlideIn({super.key, required this.child, this.animate = true});

  final Widget child;
  final bool animate;

  @override
  State<FadeSlideIn> createState() => _FadeSlideInState();
}

/// A plain 120–150ms fade, no slide (prototype: expanding lists and work
/// blocks only fade in their contents).
class FadeIn extends StatelessWidget {
  const FadeIn({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (MediaQuery.disableAnimationsOf(context)) return child;
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: AppTokens.motion(context, AppTokens.fast),
      curve: AppTokens.curve,
      builder: (_, value, child) => Opacity(opacity: value, child: child),
      child: child,
    );
  }
}

class _FadeSlideInState extends State<FadeSlideIn> with SingleTickerProviderStateMixin {
  late final _controller = AnimationController(vsync: this, duration: AppTokens.medium, value: widget.animate ? 0 : 1);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context) || !TickerMode.valuesOf(context).enabled || !widget.animate) {
      _controller.stop(); _controller.value = 1;
    } else if (_controller.value < 1 && !_controller.isAnimating) { _controller.forward(); }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (MediaQuery.disableAnimationsOf(context)) return widget.child;
    final curve = CurvedAnimation(parent: _controller, curve: AppTokens.curve);
    return FadeTransition(
      opacity: curve,
      child: SlideTransition(position: Tween(begin: const Offset(0, 0.04), end: Offset.zero).animate(curve), child: widget.child),
    );
  }
}

/// The blinking caret at the end of a reply that is still being written.
class StreamingCaret extends StatefulWidget {
  const StreamingCaret({super.key});

  @override
  State<StreamingCaret> createState() => _StreamingCaretState();
}

class _StreamingCaretState extends State<StreamingCaret> with SingleTickerProviderStateMixin {
  late final _controller = AnimationController(vsync: this, duration: AppTokens.medium * 4);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context) || !TickerMode.valuesOf(context).enabled) {
      _controller.stop();
      _controller.value = 1;
    } else if (!_controller.isAnimating) {
      _controller.repeat(reverse: true);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      child: FadeTransition(
        opacity: CurvedAnimation(parent: _controller, curve: AppTokens.curve),
        child: Container(width: 8, height: 16, margin: const EdgeInsets.only(top: 2), color: context.colors.accent.withValues(alpha: 0.7)),
      ),
    );
  }
}

/// Non-scrolling keyed rows. A quick undo reverses the same row's exit instead
/// of building a second editor with the same GlobalKey.
class MotionRows extends StatefulWidget {
  const MotionRows({super.key, required this.children});
  final List<Widget> children;
  @override
  State<MotionRows> createState() => _MotionRowsState();
}
class _MotionRow {
  _MotionRow(this.child, this.controller) : animation = CurvedAnimation(parent: controller, curve: AppTokens.curve);
  Widget child;
  final AnimationController controller;
  final CurvedAnimation animation;
  bool removing = false;
  void dispose() { animation.dispose(); controller.dispose(); }
}
class _MotionRowsState extends State<MotionRows> with TickerProviderStateMixin {
  final _rows = <_MotionRow>[];
  bool get _still => MediaQuery.disableAnimationsOf(context) || !TickerMode.valuesOf(context).enabled;
  _MotionRow _create(Widget child) {
    assert(child.key != null, 'MotionRows children need stable keys');
    final row = _MotionRow(child, AnimationController(vsync: this, duration: AppTokens.medium));
    row.controller.addStatusListener((status) {
      if (status != AnimationStatus.dismissed || !row.removing) return;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && row.removing && _rows.contains(row) && row.controller.isDismissed) setState(() { _rows.remove(row); row.dispose(); });
      });
    });
    return row;
  }
  @override
  void initState() { super.initState(); _rows.addAll(widget.children.map(_create)); }
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    for (final row in _rows.toList()) {
      if (_still) {
        if (row.removing) { _rows.remove(row); row.dispose(); }
        else { row.controller.stop(); row.controller.value = 1; }
      } else if (!row.removing && !row.controller.isAnimating) { row.controller.forward(); }
    }
  }
  @override
  void didUpdateWidget(MotionRows old) {
    super.didUpdateWidget(old);
    final keys = widget.children.map((child) => child.key).toSet();
    for (final row in _rows.toList()) {
      if (keys.contains(row.child.key)) continue;
      row.removing = true;
      if (_still) { _rows.remove(row); row.dispose(); } else { row.controller.reverse(); }
    }
    var index = 0;
    for (final child in widget.children) {
      final existing = _rows.where((row) => row.child.key == child.key).firstOrNull;
      final row = existing ?? _create(child);
      row.child = child; row.removing = false;
      while (index < _rows.length && _rows[index].removing) { index++; }
      if (existing != null) _rows.remove(row);
      _rows.insert(index.clamp(0, _rows.length), row); index++;
      if (_still) { row.controller.stop(); row.controller.value = 1; } else { row.controller.forward(); }
    }
  }
  @override
  void dispose() { for (final row in _rows) { row.dispose(); } super.dispose(); }
  @override
  Widget build(BuildContext context) => Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    for (final row in _rows) KeyedSubtree(key: row.child.key, child: IgnorePointer(ignoring: row.removing, child: ExcludeSemantics(excluding: row.removing, child: SizeTransition(sizeFactor: row.animation, alignment: Alignment.topCenter, child: FadeTransition(opacity: row.animation, child: row.child))))),
  ]);
}

class PressFeedback extends StatefulWidget {
  const PressFeedback({super.key, required this.child, this.enabled = true});
  final Widget child;
  final bool enabled;
  @override
  State<PressFeedback> createState() => _PressFeedbackState();
}

class _PressFeedbackState extends State<PressFeedback> with SingleTickerProviderStateMixin {
  late final _controller = AnimationController(vsync: this, duration: AppTokens.press);
  late final _curve = CurvedAnimation(parent: _controller, curve: Curves.easeOutCubic, reverseCurve: Curves.easeOutQuad);

  bool get _still => MediaQuery.disableAnimationsOf(context) || !TickerMode.valuesOf(context).enabled;
  void _down(PointerDownEvent event) { if (widget.enabled && !_still) _controller.forward(); }
  void _up(PointerUpEvent event) => _controller.reverse();
  void _cancel(PointerCancelEvent event) => _controller.reverse();

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _controller.reverseDuration = Duration(milliseconds: context.painting.craftGeometry.name == 'curved' ? 140 : 110);
    if (_still) { _controller.stop(); _controller.value = 0; }
  }

  @override
  void dispose() { _curve.dispose(); _controller.dispose(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    if (!widget.enabled || _still) return widget.child;
    final theme = context.painting;
    final pose = _pressPose(theme.id);
    return Listener(
      behavior: HitTestBehavior.opaque,
      onPointerDown: _down,
      onPointerUp: _up,
      onPointerCancel: _cancel,
      child: AnimatedBuilder(
        animation: _curve,
        child: widget.child,
        builder: (context, child) {
          final amount = _curve.value;
          return Transform.translate(
            offset: Offset(pose.$1 * amount, pose.$2 * amount),
            child: Transform.scale(
              scaleX: 1 - pose.$3 * amount,
              scaleY: 1 - pose.$4 * amount,
              alignment: Alignment.center,
              child: CustomPaint(
                foregroundPainter: _CraftPressPainter(theme.id, context.colors.accent, amount),
                child: child,
              ),
            ),
          );
        },
      ),
    );
  }
}

// A press leaves a brief material-specific mark; resting controls never loop.
// (horizontal travel, vertical travel, horizontal compression, vertical compression)
(double, double, double, double) _pressPose(String id) => switch (id) {
  'yuhua' => (0, 1.8, .012, .012), // specimen pin seats vertically
  'shiqing' => (.8, .8, .018, .018), // stone inlay seats diagonally
  'liuguang' || 'huandie' => (0, .5, .012, .012), // glass changes light, barely moves
  'caodie' || 'shensi' || 'qiandie' || 'youhua' => (1.1, .3, .018, .008),
  _ => (0, 1.3, .025, .04), // seal pressed into paper
};

class _CraftPressPainter extends CustomPainter {
  const _CraftPressPainter(this.id, this.color, this.amount);
  final String id;
  final Color color;
  final double amount;

  @override
  void paint(Canvas canvas, Size size) {
    if (amount <= 0 || size.width < 24 || size.height < 22) return;
    final ink = Paint()..color = color.withValues(alpha: .65 * amount)
      ..style = PaintingStyle.stroke..strokeWidth = 1.3..strokeCap = StrokeCap.round;
    final x = size.width / 2, y = size.height - 3;
    final span = (size.width * .2).clamp(4.0, 11.0) * amount;
    switch (id) {
      case 'yuhua':
        canvas.drawLine(Offset(x - span, y), Offset(x + span, y), ink);
        canvas.drawLine(Offset(x, y - 3), Offset(x, y + 1), ink);
      case 'shiqing':
        canvas.drawPath(Path()..moveTo(x - span, y - 2)..lineTo(x, y + 1)..lineTo(x + span, y - 2), ink);
      case 'liuguang' || 'huandie':
        for (var i = 0; i < 3; i++) {
          final from = x - span + i * span * .75;
          canvas.drawLine(Offset(from, y), Offset(from + span * .5, y), ink);
        }
      case 'caodie' || 'shensi' || 'qiandie' || 'youhua':
        canvas.drawPath(Path()..moveTo(x - span, y - 2)..lineTo(x - span, y)..lineTo(x + span, y)..lineTo(x + span, y - 2), ink);
      default:
        canvas.drawPath(Path()..moveTo(x - span, y - 2)..quadraticBezierTo(x, y + 2, x + span, y - 2), ink);
    }
  }

  @override
  bool hitTest(Offset position) => false;
  @override
  bool shouldRepaint(_CraftPressPainter oldDelegate) => oldDelegate.id != id || oldDelegate.color != color || oldDelegate.amount != amount;
}

/// Shared switch timing, including a genuinely immediate reduced-motion pose.
/// Native Material Switch's private animation duration cannot be configured.
class MotionSwitch extends StatelessWidget {
  const MotionSwitch({super.key, required this.value, required this.onChanged, this.label});
  final bool value;
  final ValueChanged<bool>? onChanged;
  final String? label;
  @override
  Widget build(BuildContext context) => PressFeedback(
    enabled: onChanged != null,
    child: V1Toggle(value: value, onChanged: onChanged, label: label, padded: true),
  );
}
class MotionSwitchTile extends StatelessWidget {
  const MotionSwitchTile({super.key, required this.title, required this.value, required this.onChanged, this.subtitle, this.dense = false, this.contentPadding = EdgeInsets.zero});
  final Widget title;
  final Widget? subtitle;
  final bool value;
  final ValueChanged<bool>? onChanged;
  final bool dense;
  final EdgeInsetsGeometry contentPadding;
  @override
  Widget build(BuildContext context) => MergeSemantics(child: ListTile(contentPadding: contentPadding, dense: dense, title: title, subtitle: subtitle, trailing: MotionSwitch(value: value, onChanged: onChanged), onTap: onChanged == null ? null : () => onChanged!(!value)));
}
