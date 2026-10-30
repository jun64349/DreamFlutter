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
  late final _controller = AnimationController(vsync: this, duration: const Duration(milliseconds: 1400))..repeat(reverse: true);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: Tween(begin: 0.35, end: 1.0).animate(CurvedAnimation(parent: _controller, curve: Curves.easeInOut)),
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
  void initState() {
    super.initState();
    if (widget.animate) _controller.forward();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final curve = CurvedAnimation(parent: _controller, curve: Curves.easeOutCubic);
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
  late final _controller = AnimationController(vsync: this, duration: const Duration(milliseconds: 900))..repeat(reverse: true);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      child: FadeTransition(
        opacity: CurvedAnimation(parent: _controller, curve: Curves.easeInOut),
        child: Container(width: 8, height: 16, margin: const EdgeInsets.only(top: 2), color: context.colors.accent.withValues(alpha: 0.7)),
      ),
    );
  }
}
