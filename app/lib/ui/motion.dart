import 'package:flutter/material.dart';

import '../theme.dart';

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

/// Shared switch timing, including a genuinely immediate reduced-motion pose.
/// Native Material Switch's private animation duration cannot be configured.
class MotionSwitch extends StatelessWidget {
  const MotionSwitch({super.key, required this.value, required this.onChanged, this.label});
  final bool value;
  final ValueChanged<bool>? onChanged;
  final String? label;
  @override
  Widget build(BuildContext context) {
    final enabled = onChanged != null;
    void toggle() => onChanged?.call(!value);
    final colors = context.colors;
    Widget track(double t) => Container(width: 52, height: 32, padding: const EdgeInsets.symmetric(horizontal: 4),
      decoration: BoxDecoration(color: Color.lerp(colors.sidebar, colors.accent, t)!.withValues(alpha: enabled ? 1 : .38), border: Border.all(color: enabled ? Color.lerp(colors.muted, colors.accent, t)! : colors.border, width: 2), borderRadius: BorderRadius.circular(20)),
      child: Align(alignment: AlignmentDirectional(-1 + 2 * t, 0), child: Container(width: 16 + 8 * t, height: 16 + 8 * t, decoration: BoxDecoration(color: Color.lerp(colors.muted, Theme.of(context).colorScheme.onPrimary, t)!.withValues(alpha: enabled ? 1 : .5), shape: BoxShape.circle))),
    );
    return Semantics(label: label, toggled: value, enabled: enabled, onTap: enabled ? toggle : null, child: ExcludeSemantics(child: Material(color: Colors.transparent, child: InkWell(
      onTap: enabled ? toggle : null, borderRadius: BorderRadius.circular(24),
      child: SizedBox(width: 60, height: 48, child: Center(child: MediaQuery.disableAnimationsOf(context) ? track(value ? 1 : 0) : TweenAnimationBuilder<double>(
        duration: AppTokens.motion(context, AppTokens.fast), curve: AppTokens.curve, tween: Tween(end: value ? 1 : 0),
        builder: (context, t, _) => track(t),
      ))),
    ))));
  }
}
class MotionSwitchTile extends StatelessWidget {
  const MotionSwitchTile({super.key, required this.title, required this.value, required this.onChanged});
  final Widget title;
  final bool value;
  final ValueChanged<bool>? onChanged;
  @override
  Widget build(BuildContext context) => MergeSemantics(child: ListTile(contentPadding: EdgeInsets.zero, title: title, trailing: MotionSwitch(value: value, onChanged: onChanged), onTap: onChanged == null ? null : () => onChanged!(!value)));
}
