import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../theme.dart';
import 'painting_art.dart';

enum PaintingSurface { home, sidebar, card }

class PaintingBackdrop extends StatelessWidget {
  const PaintingBackdrop({super.key, required this.surface, this.child, this.animate = false, this.showMotif = true});

  final PaintingSurface surface;
  final Widget? child;
  final bool animate;
  final bool showMotif;

  @override
  Widget build(BuildContext context) {
    final theme = context.painting;
    final colors = theme.colors;
    final ground = switch (surface) { PaintingSurface.home => colors.background, PaintingSurface.sidebar => colors.sidebar, PaintingSurface.card => colors.card };
    return ClipRect(
      child: LayoutBuilder(
        builder: (context, constraints) {
          final motifWidth = math.min(400.0, constraints.maxWidth * .35);
          return Stack(
            fit: StackFit.expand,
            children: [
              ColoredBox(color: ground),
              if (surface == PaintingSurface.home)
                CustomPaint(painter: _PaintingWashPainter(theme)),
              if (surface == PaintingSurface.sidebar)
                Positioned.fill(top: 80, bottom: 52, child: CustomPaint(painter: _PaintingWashPainter(theme, sidebar: true))),
              CustomPaint(painter: PaintingPatternPainter(theme, surface)),
              if (surface == PaintingSurface.sidebar && constraints.maxHeight > 220)
                Positioned(left: 0, bottom: 52, width: 104, height: 72, child: CraftOrnament(theme: theme, opacity: .18)),
              if (surface == PaintingSurface.card)
                Positioned(right: 0, top: 0, width: 54, height: 34, child: CraftOrnament(theme: theme, opacity: .13)),
              if (surface == PaintingSurface.home && showMotif && constraints.maxWidth.isFinite && motifWidth > 0)
                Positioned(
                  right: constraints.maxWidth * .03,
                  bottom: constraints.maxHeight * .03,
                  // Keep the moving motif's paint inside this small area.
                  child: RepaintBoundary(
                    child: PaintingMotif(width: motifWidth, height: motifWidth * 2 / 3, animate: animate),
                  ),
                ),
              if (surface == PaintingSurface.sidebar && constraints.maxHeight > 220)
                Positioned(right: 8, bottom: 64, child: PaintingInscription(theme)),
              ?child,
            ],
          );
        },
      ),
    );
  }
}

/// An optional decorative corner for existing card surfaces. It does not
/// change the card's size, hit testing, semantics, or background.
class CraftCardEdge extends StatelessWidget {
  const CraftCardEdge({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => Stack(
    fit: StackFit.passthrough,
    clipBehavior: Clip.hardEdge,
    children: [
      child,
      Positioned(right: 0, top: 0, width: 54, height: 34,
        child: CraftOrnament(theme: context.painting, opacity: .13)),
    ],
  );
}

/// v1-art.css 的透明椭圆晕染。半径分别按宽高取值，不用短边半径画圆，
/// 也不把已混好的不透明 accentSoft 当作整页底色再次铺上去。
class _PaintingWashPainter extends CustomPainter {
  const _PaintingWashPainter(this.theme, {this.sidebar = false});
  final PaintingTheme theme;
  final bool sidebar;
  @override void paint(Canvas canvas, Size size) {
    if (size.isEmpty) return;
    final c = theme.colors, art = paintingArtAccentFor(theme);
    final soft = switch (theme.id) { 'jiadie' || 'caodie' => .11, 'liuguang' => .15, _ => theme.isDark ? .14 : .10 };
    final opacity = sidebar ? .72 : .8;
    void ellipse(double x, double y, double rx, double ry, Color color, double alpha, double end) {
      canvas.save();
      canvas.translate(size.width * x, size.height * y);
      canvas.scale(size.width * rx, size.height * ry);
      final paint = Paint()..shader = ui.Gradient.radial(Offset.zero, 1,
        [color.withValues(alpha: alpha * opacity), color.withValues(alpha: 0)], [0, end]);
      canvas.drawRect(Rect.fromLTRB(-x / rx, -y / ry, (1 - x) / rx, (1 - y) / ry), paint);
      canvas.restore();
    }
    void band(Alignment begin, Alignment end, Color color, double alpha, List<double> stops) {
      canvas.drawRect(Offset.zero & size, Paint()..shader = LinearGradient(begin: begin, end: end,
        colors: [color.withValues(alpha: 0), color.withValues(alpha: alpha * opacity), color.withValues(alpha: 0)], stops: stops).createShader(Offset.zero & size));
    }
    if (sidebar) {
      switch (theme.id) {
        case 'warmPaper' || 'twilight':
          band(const Alignment(-.259, -.966), const Alignment(.259, .966), c.accent, .06, [.52, .525, .53]);
          ellipse(.9, .94, .9, .94, c.accent, soft, .52);
        case 'jiadie' || 'moye': ellipse(.9, .9, .9, .9, c.accent, soft, .48);
        case 'youhua': ellipse(1, 1, 1, 1, c.accent, .08, .58);
        case 'huandie': ellipse(.9, .88, .9, .88, art, .13, .58);
        case 'shiqing': ellipse(1, .94, 1, .94, c.accent, .11, .54);
      }
      return;
    }
    switch (theme.id) {
      case 'warmPaper' || 'twilight':
        band(const Alignment(-.927, -.375), const Alignment(.927, .375), c.ochre, .04, [.36, .5, .64]);
        ellipse(.5, .04, .52, .42, c.accent, soft, .72);
      case 'jiadie' || 'moye':
        ellipse(.12, .9, .32, .18, art, .07, .72);
        ellipse(.5, .04, .707, 1.358, c.accent, soft, .64);
      case 'caodie': ellipse(.5, 0, .64, .46, c.accent, soft, .70);
      case 'yuhua': ellipse(.5, 0, .58, .40, c.accent, soft, .72);
      case 'shensi':
        band(Alignment.centerLeft, Alignment.centerRight, c.accent, .03, [.12, .5, .88]);
        ellipse(.5, 0, .56, .44, art, .12, .68);
      case 'qiandie': ellipse(.5, 0, .58, .42, art, .13, .70);
      case 'youhua': ellipse(.5, 0, .46, .38, art, .09, .70);
      case 'liuguang': ellipse(.5, 0, .58, .44, c.accent, .13, .70);
      case 'huandie':
        ellipse(.72, .16, .38, .32, art, .11, .72);
        ellipse(.44, 0, .52, .44, c.accent, .14, .70);
      case 'shiqing': ellipse(.5, 0, .54, .42, c.accent, .12, .70);
    }
  }
  @override bool shouldRepaint(_PaintingWashPainter old) => old.theme.id != theme.id || old.sidebar != sidebar;
}

class PaintingInscription extends StatelessWidget {
  const PaintingInscription(this.theme, {super.key});
  final PaintingTheme theme;

  @override
  Widget build(BuildContext context) {
    final text = theme.verticalInscription
        ? Text(theme.inscription.characters.join('\n'), textAlign: TextAlign.center, style: context.handwriting(const TextStyle()).copyWith(fontSize: 15, height: 1.2))
        : RotatedBox(quarterTurns: 3, child: Text(theme.inscription, maxLines: 1, style: context.serif(const TextStyle()).copyWith(fontSize: 12, fontStyle: FontStyle.italic)));
    return ExcludeSemantics(child: IgnorePointer(child: Opacity(opacity: .13, child: text)));
  }
}

class PaintingPatternPainter extends CustomPainter {
  const PaintingPatternPainter(this.theme, this.surface);
  final PaintingTheme theme;
  final PaintingSurface surface;

  @override
  void paint(Canvas canvas, Size size) {
    final accent = paintingArtAccentFor(theme);
    final line = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1
      ..color = accent.withValues(alpha: surface == PaintingSurface.sidebar ? .08 : .035);
    final w = size.width, h = size.height;
    if (w <= 0 || h <= 0) return;
    switch (theme.id) {
      case 'warmPaper' || 'twilight':
        break;
      case 'jiadie' || 'moye':
        if (surface == PaintingSurface.sidebar) {
          canvas.drawLine(Offset(w - 90, h - 52), Offset(w, h - 192), line..color = accent.withValues(alpha: .09));
        }
      case 'caodie':
        if (surface == PaintingSurface.card) break;
        final spacing = surface == PaintingSurface.sidebar ? 38.0 : 56.0;
        for (var x = -h; x < w + h; x += spacing) {
          canvas.drawLine(Offset(x, h), Offset(x + h * .36, 0), line);
        }
      case 'yuhua':
        if (surface == PaintingSurface.home) {
          for (var x = 80.0; x < w; x += 80) { canvas.drawLine(Offset(x, 0), Offset(x, h), line..color = accent.withValues(alpha: .03)); }
        } else if (surface == PaintingSurface.sidebar) {
          for (var y = h - 96; y < h - 52; y += 12) { canvas.drawLine(Offset(w - 42, y), Offset(w - 30, y), line..color = accent.withValues(alpha: .06)); }
        }
      case 'shensi':
        if (surface == PaintingSurface.sidebar) {
          canvas.drawLine(Offset(w * .94, 0), Offset(w * .94, h), line..color = accent.withValues(alpha: .14));
          canvas.drawLine(Offset(0, h * .92), Offset(w, h * .92), line..color = accent.withValues(alpha: .12));
        }
      case 'qiandie':
        if (surface == PaintingSurface.home) {
          canvas.drawLine(Offset(w * .38, h), Offset(w * .7, 0), line..color = accent.withValues(alpha: .03));
        } else if (surface == PaintingSurface.sidebar) {
          canvas.drawLine(Offset(w - 72, h - 52), Offset(w, h - 160), line);
          canvas.drawLine(Offset(w - 72, h - 160), Offset(w, h - 52), line..color = accent.withValues(alpha: .07));
        }
      case 'youhua':
        if (surface == PaintingSurface.sidebar) {
          canvas.drawCircle(Offset(w * .82, h * .8), 1.2, Paint()..color = Colors.white.withValues(alpha: .11));
        }
      case 'liuguang':
        if (surface == PaintingSurface.home) {
          for (var i = -2; i <= 2; i++) {
            canvas.drawLine(Offset(w / 2, 0), Offset(w / 2 + i * w * .16, h * .7), line..color = (i.isEven ? theme.colors.accent : accent).withValues(alpha: .035));
          }
        } else if (surface == PaintingSurface.sidebar) {
          canvas.drawLine(Offset(w / 2, h - 150), Offset(w / 2 - 60, h), line..color = theme.colors.accent.withValues(alpha: .14));
          canvas.drawLine(Offset(w / 2, h - 150), Offset(w / 2 + 60, h), line..color = accent.withValues(alpha: .1));
        }
      case 'huandie':
        if (surface == PaintingSurface.sidebar) {
          canvas.drawCircle(Offset(w * .82, h * .68), 1.2, Paint()..color = theme.colors.accent.withValues(alpha: .2));
        }
      case 'shiqing':
        if (surface == PaintingSurface.home) {
          for (var x = -h; x < w + h; x += 26) { canvas.drawLine(Offset(x, h), Offset(x + h, 0), line..color = theme.colors.accent.withValues(alpha: .02)); }
        } else if (surface == PaintingSurface.sidebar) {
          canvas.drawLine(Offset(w - 72, h - 52), Offset(w, h - 124), line..color = accent.withValues(alpha: .08));
        }
    }
  }

  @override
  bool shouldRepaint(PaintingPatternPainter old) => old.theme.id != theme.id || old.surface != surface;
}

class PaperGrain extends StatelessWidget {
  const PaperGrain({super.key, this.strength = .05});
  final double strength;
  static const _noise = AssetImage('assets/paper_noise.png');

  @override
  Widget build(BuildContext context) {
    if (strength <= 0) return const SizedBox.shrink();
    final dark = context.painting.isDark;
    return ExcludeSemantics(
      child: IgnorePointer(
        child: RepaintBoundary(
          // Blend each tile at the chosen strength without a full-window
          // opacity layer. The tiles are static until appearance changes.
          child: Image(
            image: _noise,
            opacity: AlwaysStoppedAnimation(dark ? strength * .6 : strength),
            repeat: ImageRepeat.repeat,
            gaplessPlayback: true,
          ),
        ),
      ),
    );
  }
}
