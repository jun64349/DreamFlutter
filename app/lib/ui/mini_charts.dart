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
    dark ? const Color(0xFF8FB0E8) : const Color(0xFF3F6CA8),
    dark ? const Color(0xFF8FD1A5) : const Color(0xFF3E8A5A),
    dark ? const Color(0xFFD9BE6A) : const Color(0xFFB38A1E),
    dark ? const Color(0xFFC39BE3) : const Color(0xFF8E5BB5),
    dark ? const Color(0xFF8BC4C8) : const Color(0xFF3D7F84),
    dark ? const Color(0xFFEF8C80) : const Color(0xFFC0392B),
    c.muted,
  ];
}

/// One bar per day; hovering a bar shows its label and value.
class DayBarChart extends StatefulWidget {
  const DayBarChart({super.key, required this.labels, required this.values, required this.format, this.height = 150});
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
    final label = context.text.bodySmall?.copyWith(fontSize: 11, color: colors.muted);
    return LayoutBuilder(builder: (context, c) {
      final slot = n == 0 ? 0.0 : c.maxWidth / n;
      final hover = _hover;
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        SizedBox(
          height: 18,
          child: hover == null || hover >= n
              ? Text(max == 0 ? '' : '最高 ${widget.format(max)}', style: label)
              : Text('${widget.labels[hover]} · ${widget.format(widget.values[hover])}', style: label?.copyWith(color: colors.ink)),
        ),
        const SizedBox(height: 6),
        MouseRegion(
          onHover: (e) => setState(() => _hover = slot <= 0 ? null : (e.localPosition.dx / slot).floor().clamp(0, n - 1)),
          onExit: (_) => setState(() => _hover = null),
          child: TweenAnimationBuilder<double>(
            tween: Tween(begin: 0, end: 1),
            duration: AppTokens.motion(context, AppTokens.slow),
            curve: AppTokens.curve,
            builder: (context, t, _) => CustomPaint(
              size: Size(c.maxWidth, widget.height),
              painter: _BarsPainter(values: widget.values, max: max, grow: t, hover: hover, bar: colors.accent, faint: colors.accent.withValues(alpha: 0.35), grid: colors.border),
            ),
          ),
        ),
        const SizedBox(height: 4),
        Row(children: [
          if (n > 0) Text(widget.labels.first, style: label),
          const Spacer(),
          if (n > 1) Text(widget.labels.last, style: label),
        ]),
      ]);
    });
  }
}

class _BarsPainter extends CustomPainter {
  _BarsPainter({required this.values, required this.max, required this.grow, required this.hover, required this.bar, required this.faint, required this.grid});
  final List<double> values;
  final double max, grow;
  final int? hover;
  final Color bar, faint, grid;

  @override
  void paint(Canvas canvas, Size size) {
    final line = Paint()..color = grid..strokeWidth = 0.6;
    for (final f in [0.0, 0.5, 1.0]) {
      final y = size.height * (1 - f);
      canvas.drawLine(Offset(0, y), Offset(size.width, y), line);
    }
    if (values.isEmpty) return;
    final slot = size.width / values.length;
    final w = math.max(2.0, slot * 0.62);
    for (var i = 0; i < values.length; i++) {
      final v = values[i];
      if (v <= 0 || max <= 0) continue;
      final h = math.max(2.0, size.height * (v / max) * grow);
      final x = slot * i + (slot - w) / 2;
      final paint = Paint()..color = hover == null || hover == i ? bar : faint;
      canvas.drawRRect(RRect.fromRectAndCorners(Rect.fromLTWH(x, size.height - h, w, h), topLeft: const Radius.circular(3), topRight: const Radius.circular(3)), paint);
    }
  }

  @override
  bool shouldRepaint(_BarsPainter old) => old.values != values || old.grow != grow || old.hover != hover || old.bar != bar;
}

/// A ring of shares with its legend beside it (below on a narrow width).
class DonutChart extends StatefulWidget {
  const DonutChart({super.key, required this.names, required this.values, required this.details, required this.center, this.size = 132});
  final List<String> names;
  final List<double> values;

  /// Shown at the end of each legend row ("12 次 · $0.40").
  final List<String> details;

  /// The ring's middle (the total).
  final String center;
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
          child: Center(child: Padding(
            padding: const EdgeInsets.all(24),
            child: FittedBox(child: Text(
              _hover == null || total <= 0 ? widget.center : '${(widget.values[_hover!] * 100 / total).round()}%',
              style: context.serif(context.text.titleMedium).copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
            )),
          )),
        ),
      ),
    );
    final legend = Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
      for (var i = 0; i < widget.names.length; i++)
        MouseRegion(
          onEnter: (_) => setState(() => _hover = i),
          onExit: (_) => setState(() => _hover = null),
          child: AnimatedContainer(
            duration: AppTokens.motion(context, AppTokens.fast),
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
            decoration: BoxDecoration(color: _hover == i ? colors.accentSoft.withValues(alpha: 0.5) : Colors.transparent, borderRadius: BorderRadius.circular(6)),
            child: Row(children: [
              Container(width: 10, height: 10, decoration: BoxDecoration(color: colorOf(i), borderRadius: BorderRadius.circular(3))),
              const SizedBox(width: 10),
              Expanded(child: Text(widget.names[i], maxLines: 1, overflow: TextOverflow.ellipsis, style: context.text.bodyMedium)),
              const SizedBox(width: 10),
              Text(widget.details[i], style: context.text.bodySmall?.copyWith(color: colors.muted, fontFeatures: const [FontFeature.tabularFigures()])),
            ]),
          ),
        ),
    ]);
    return LayoutBuilder(builder: (context, c) => c.maxWidth < 380
        ? Column(children: [ring, const SizedBox(height: 12), legend])
        : Row(children: [ring, const SizedBox(width: 22), Expanded(child: legend)]));
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
    final stroke = size.width * 0.15;
    final rect = Rect.fromCircle(center: size.center(Offset.zero), radius: size.width / 2 - stroke / 2 - 3);
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
        ..strokeWidth = hover == i ? stroke + 5 : stroke;
      // A hair of space between slices keeps them apart.
      canvas.drawArc(rect, start, math.max(0.001, angle - (values.length > 1 ? 0.025 : 0)), false, paint);
      start += angle;
    }
  }

  @override
  bool shouldRepaint(_DonutPainter old) => old.values != values || old.sweep != sweep || old.hover != hover;
}
