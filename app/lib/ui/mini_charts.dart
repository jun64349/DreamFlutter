import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme.dart';

/// Small hand-drawn charts for the 花费 page (0.8.2, user test: "做成可视化图表").
/// Colours come from the theme so every painting theme keeps them in key.

/// Series colours: the theme's own accents first, then calm fixed hues.
List<Color> chartPalette(BuildContext context) {
  final c = context.colors;
  final dark = Theme.of(context).brightness == Brightness.dark;
  // The theme's accent leads; the rest are far apart in hue so neighbouring slices never blur.
  return [
    c.accent,
    dark ? const Color(0xFFD9A066) : const Color(0xFFB5793F),
    c.success,
    c.muted,
    dark ? const Color(0xFFC39BE3) : const Color(0xFF8E5BB5),
    dark ? const Color(0xFF8BC4C8) : const Color(0xFF3D7F84),
    dark ? const Color(0xFFEF8C80) : const Color(0xFFC0392B),
  ];
}

/// One bar per day; hovering a bar shows its label and value.
class DayBarChart extends StatefulWidget {
  const DayBarChart({super.key, required this.labels, required this.values, required this.format, this.height = 120});
  final List<String> labels;
  final List<double> values;
  final String Function(double) format;
  final double height;
  @override
  State<DayBarChart> createState() => _DayBarChartState();
}

class _DayBarChartState extends State<DayBarChart> {
  int? _hover;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final n = widget.values.length;
    final max = widget.values.fold<double>(0, math.max);
    final label = context.text.bodySmall?.copyWith(fontSize: 12, height: 1.6, color: colors.muted);
    return LayoutBuilder(builder: (context, c) {
      final gap = n == 0 ? 0.0 : math.min(4.0, c.maxWidth / n * .45);
      final slot = n == 0 ? 0.0 : (c.maxWidth + gap) / n;
      final hover = _hover;
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          Text('近 30 天', style: context.text.bodyMedium?.copyWith(fontWeight: FontWeight.w600, height: 1.6)),
          const SizedBox(width: 8),
          Expanded(child: Text(hover == null || hover >= n
              ? '悬停看当天明细'
              : '${widget.labels[hover]} · ${widget.format(widget.values[hover])}',
            style: label, textAlign: TextAlign.right, maxLines: 1, overflow: TextOverflow.ellipsis,
          )),
        ]),
        Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: MouseRegion(
          onHover: (e) => setState(() => _hover = slot <= 0 ? null : (e.localPosition.dx / slot).floor().clamp(0, n - 1)),
          onExit: (_) => setState(() => _hover = null),
          child: TweenAnimationBuilder<double>(
            tween: Tween(begin: 0, end: 1),
            duration: AppTokens.motion(context, AppTokens.slow),
            curve: AppTokens.curve,
            builder: (context, t, _) => CustomPaint(
              size: Size(c.maxWidth, widget.height - 16),
              painter: _BarsPainter(values: widget.values, max: max, grow: t, hover: hover, bar: colors.accent, gap: gap),
            ),
          ),
        )),
      ]);
    });
  }
}

class _BarsPainter extends CustomPainter {
  _BarsPainter({required this.values, required this.max, required this.grow, required this.hover, required this.bar, required this.gap});
  final List<double> values;
  final double max, grow, gap;
  final int? hover;
  final Color bar;

  @override
  void paint(Canvas canvas, Size size) {
    if (values.isEmpty) return;
    final slot = (size.width + gap) / values.length;
    final w = slot - gap;
    for (var i = 0; i < values.length; i++) {
      final v = values[i];
      if (v <= 0 || max <= 0) continue;
      final h = math.max(2.0, size.height * .9 * (v / max) * grow);
      final x = slot * i;
      final paint = Paint()..color = hover == i ? bar : bar.withValues(alpha: .75);
      canvas.drawRRect(RRect.fromRectAndCorners(Rect.fromLTWH(x, size.height - h, w, h), topLeft: const Radius.circular(3), topRight: const Radius.circular(3)), paint);
    }
  }

  @override
  bool shouldRepaint(_BarsPainter old) => old.values != values || old.grow != grow || old.hover != hover || old.bar != bar;
}

/// A ring of shares with its legend beside it (below on a narrow width).
class DonutChart extends StatefulWidget {
  const DonutChart({super.key, required this.title, required this.names, required this.values, required this.details, this.size = 120});
  final String title;
  final List<String> names;
  final List<double> values;

  /// Shown at the end of each legend row ("12 次 · $0.40").
  final List<String> details;

  final double size;
  @override
  State<DonutChart> createState() => _DonutChartState();
}

class _DonutChartState extends State<DonutChart> {
  int? _hover;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final palette = chartPalette(context);
    final total = widget.values.fold<double>(0, (a, b) => a + b);
    Color colorOf(int i) => palette[i % palette.length];
    final ring = SizedBox.square(
      dimension: widget.size,
      child: TweenAnimationBuilder<double>(
        tween: Tween(begin: 0, end: 1),
        duration: AppTokens.motion(context, AppTokens.slow),
        curve: AppTokens.curve,
        builder: (context, t, _) => CustomPaint(
          painter: _DonutPainter(values: widget.values, colors: [for (var i = 0; i < widget.values.length; i++) colorOf(i)], sweep: t, hover: _hover, empty: colors.border),
        ),
      ),
    );
    final legend = Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
      Text(widget.title, style: context.text.bodyMedium?.copyWith(fontWeight: FontWeight.w600, height: 1.6)),
      const SizedBox(height: 8),
      for (var i = 0; i < widget.names.length; i++) ...[
        if (i > 0) const SizedBox(height: 6),
        MouseRegion(
          onEnter: (_) => setState(() => _hover = i),
          onExit: (_) => setState(() => _hover = null),
          child: Tooltip(
            message: '${widget.names[i]} · ${widget.details[i]}',
            child: Row(children: [
              Container(width: 9, height: 9, decoration: BoxDecoration(color: colorOf(i), borderRadius: BorderRadius.circular(3))),
              const SizedBox(width: 8),
              Expanded(child: Text(widget.names[i], maxLines: 1, overflow: TextOverflow.ellipsis, style: context.text.bodySmall?.copyWith(fontSize: 12.5, height: 1.6))),
              const SizedBox(width: 8),
              if (total > 0) Text(
                '${(widget.values[i] * 100 / total).round()}%',
                style: context.text.bodySmall?.copyWith(fontSize: 12.5, height: 1.6, color: colors.muted, fontFeatures: const [FontFeature.tabularFigures()]),
              ),
            ]),
          ),
        ),
      ],
    ]);
    return LayoutBuilder(builder: (context, c) => c.maxWidth < 275
        ? Column(children: [ring, const SizedBox(height: 12), legend])
        : Row(children: [ring, const SizedBox(width: 18), Expanded(child: legend)]));
  }
}

class _DonutPainter extends CustomPainter {
  _DonutPainter({required this.values, required this.colors, required this.sweep, required this.hover, required this.empty});
  final List<double> values;
  final List<Color> colors;
  final double sweep;
  final int? hover;
  final Color empty;

  @override
  void paint(Canvas canvas, Size size) {
    final total = values.fold<double>(0, (a, b) => a + b);
    final stroke = size.width * .114;
    final rect = Rect.fromCircle(center: size.center(Offset.zero), radius: size.width / 2 - stroke / 2);
    if (total <= 0) {
      canvas.drawArc(rect, 0, math.pi * 2, false, Paint()..color = empty..style = PaintingStyle.stroke..strokeWidth = stroke);
      return;
    }
    var start = -math.pi / 2;
    for (var i = 0; i < values.length; i++) {
      final angle = math.pi * 2 * values[i] / total * sweep;
      if (angle <= 0) continue;
      final paint = Paint()
        ..color = colors[i].withValues(alpha: hover == null || hover == i ? 1 : 0.35)
        ..style = PaintingStyle.stroke
        ..strokeWidth = stroke;
      canvas.drawArc(rect, start, angle, false, paint);
      start += angle;
    }
  }

  @override
  bool shouldRepaint(_DonutPainter old) => old.values != values || old.colors != colors || old.sweep != sweep || old.hover != hover || old.empty != empty;
}
