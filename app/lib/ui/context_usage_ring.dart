import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme.dart';

/// The occupied arc follows actual usage. Only a change in usage animates;
/// idle and unknown context never pretend to be loading.
class ContextUsageRing extends StatelessWidget {
  const ContextUsageRing({super.key, required this.value});
  final double? value;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final fraction = (value ?? 0).clamp(0.0, 1.0);
    final requested = fraction >= .85 ? colors.danger : fraction >= .6 ? colors.warning : colors.accent;
    var progress = requested;
    double contrast(Color a, Color b) {
      final x = a.computeLuminance(), y = b.computeLuminance();
      return (math.max(x, y) + .05) / (math.min(x, y) + .05);
    }
    for (var step = 1; step <= 10 && contrast(progress, colors.card) < 3; step++) {
      progress = Color.lerp(requested, colors.ink, step / 10)!;
    }
    final still = MediaQuery.disableAnimationsOf(context) || !TickerMode.valuesOf(context).enabled;
    return SizedBox.square(dimension: 18,
      child: TweenAnimationBuilder<double>(
        tween: Tween<double>(begin: fraction, end: fraction),
        duration: still ? Duration.zero : const Duration(milliseconds: 420),
        curve: Curves.easeOutCubic,
        builder: (context, shown, _) => CustomPaint(painter: ContextUsagePainter(
          value: shown, known: value != null, color: progress,
          track: colors.muted.withValues(alpha: .44),
        )),
      ),
    );
  }
}

class ContextUsagePainter extends CustomPainter {
  const ContextUsagePainter({required this.value, required this.known, required this.color, required this.track});
  final double value;
  final bool known;
  final Color color, track;

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final radius = (size.shortestSide - 3.6) / 2;
    final rect = Rect.fromCircle(center: center, radius: radius);
    canvas.drawCircle(center, radius, Paint()..color = track..style = PaintingStyle.stroke..strokeWidth = 1.5);
    if (!known || value <= 0) return;
    final angle = 2 * math.pi * value;
    canvas.drawArc(rect, -math.pi / 2, angle, false,
      Paint()..color = color.withValues(alpha: .16)..style = PaintingStyle.stroke..strokeWidth = 4.4);
    canvas.drawArc(rect, -math.pi / 2, angle, false,
      Paint()..color = color..style = PaintingStyle.stroke..strokeWidth = 2.4..strokeCap = StrokeCap.round);
    final head = center + Offset(math.sin(angle), -math.cos(angle)) * radius;
    canvas.drawCircle(head, 2.5, Paint()..color = color.withValues(alpha: .18));
    canvas.drawCircle(head, 1.45, Paint()..color = color);
  }

  @override
  bool shouldRepaint(ContextUsagePainter old) => old.value != value || old.known != known || old.color != color || old.track != track;
}
