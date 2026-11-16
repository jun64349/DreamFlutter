import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../craft_style.dart';
import '../theme.dart';

Color paintingArtAccentFor(PaintingTheme theme) => switch (theme.id) {
      'jiadie' || 'moye' => const Color(0xFFB58A52),
      'caodie' => const Color(0xFFC99B32),
      'yuhua' => const Color(0xFF597E52),
      'shensi' => const Color(0xFFC48D38),
      'qiandie' => const Color(0xFFC7A242),
      'youhua' => const Color(0xFFE0B042),
      'liuguang' => const Color(0xFF4FB3B1),
      'huandie' => const Color(0xFFA86ECC),
      'shiqing' => const Color(0xFFD86B85),
      _ => theme.colors.ochre,
    };

Color paintingArtAccent(BuildContext context) => paintingArtAccentFor(context.painting);

Color paintingThumbColorFor(PaintingTheme theme) => switch (theme.id) {
      'caodie' => const Color(0xFFF3D876),
      'yuhua' => const Color(0xFFF8F3E8),
      'shensi' => const Color(0xFFC48D38),
      'qiandie' => const Color(0xFFC7A242),
      'youhua' => const Color(0xFFF4EAD8),
      'liuguang' => const Color(0xFFF3C873),
      'huandie' => const Color(0xFFB99ADD),
      'shiqing' => const Color(0xFFE2C66D),
      _ => theme.colors.card,
    };

class PaintingMotif extends StatelessWidget {
  const PaintingMotif({super.key, this.theme, this.width = 240, this.height = 160, this.opacity = .13, this.animate = false});

  final PaintingTheme? theme;
  final double width;
  final double height;
  final double opacity;
  final bool animate;

  @override
  Widget build(BuildContext context) {
    final painting = theme ?? context.painting;
    final colors = painting.colors;
    final child = SizedBox(
      width: width,
      height: height,
      child: CustomPaint(
        painter: PaintingMotifPainter(
          themeId: painting.id,
          accent: colors.accent,
          artAccent: paintingArtAccentFor(painting),
          card: colors.card,
          seal: colors.seal,
        ),
      ),
    );
    if (animate) return _MotifMotion(opacity: opacity, child: child);
    return ExcludeSemantics(child: Opacity(opacity: opacity, child: child));
  }
}

class _MotifMotion extends StatefulWidget {
  const _MotifMotion({required this.opacity, required this.child});

  final double opacity;
  final Widget child;

  @override
  State<_MotifMotion> createState() => _MotifMotionState();
}

class _MotifMotionState extends State<_MotifMotion> with SingleTickerProviderStateMixin {
  late final _controller = AnimationController(vsync: this, duration: const Duration(seconds: 22));
  Timer? _timer;

  bool get _still => MediaQuery.disableAnimationsOf(context) || !TickerMode.valuesOf(context).enabled;
  void _play() { if (mounted && !_still && !_controller.isAnimating) _controller.forward(from: 0); }

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 23), (_) => _play());
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_still) {
      _controller.stop();
      _controller.value = 0;
    } else {
      _play();
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (MediaQuery.disableAnimationsOf(context)) return ExcludeSemantics(child: Opacity(opacity: widget.opacity, child: widget.child));
    return ExcludeSemantics(
      child: AnimatedBuilder(
        animation: _controller,
        child: widget.child,
        builder: (context, child) {
          final wave = math.sin(math.pi * _controller.value);
          return Opacity(
            opacity: widget.opacity * (1 - .23 * wave),
            child: Transform.translate(
              offset: Offset(0, -4 * wave),
              child: Transform.rotate(angle: .6 * math.pi / 180 * wave, child: child),
            ),
          );
        },
      ),
    );
  }
}

class PaintingMotifPainter extends CustomPainter {
  const PaintingMotifPainter({required this.themeId, required this.accent, required this.artAccent, required this.card, required this.seal});

  final String themeId;
  final Color accent;
  final Color artAccent;
  final Color card;
  final Color seal;

  @override
  void paint(Canvas canvas, Size size) {
    final scale = math.min(size.width / 240, size.height / 160);
    if (scale <= 0) return;
    final key = switch (themeId) { 'warmPaper' || 'twilight' => 'warm', 'moye' => 'jiadie', _ => themeId };
    canvas.save();
    canvas.translate((size.width - 240 * scale) / 2, (size.height - 160 * scale) / 2);
    canvas.scale(scale);
    for (final shape in _shapes[key] ?? _shapes['warm']!) {
      final stroke = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.4 / scale
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round;
      switch (shape.kind) {
        case _PaintKind.line:
          canvas.drawPath(shape.path, stroke..color = accent);
        case _PaintKind.accent:
          canvas.drawPath(shape.path, stroke..color = artAccent);
        case _PaintKind.seal:
          canvas.drawPath(shape.path, Paint()..color = seal.withValues(alpha: .72));
        case _PaintKind.dot:
          canvas.drawPath(shape.path, Paint()..color = artAccent);
        case _PaintKind.dew:
          canvas.drawPath(shape.path, Paint()..color = card.withValues(alpha: .6));
          canvas.drawPath(shape.path, stroke..color = artAccent);
        case _PaintKind.glass:
          canvas.drawPath(shape.path, Paint()..color = accent.withValues(alpha: .18));
        case _PaintKind.glass2:
          canvas.drawPath(shape.path, Paint()..color = artAccent.withValues(alpha: .17));
        case _PaintKind.glass3:
          canvas.drawPath(shape.path, Paint()..color = seal.withValues(alpha: .12));
      }
    }
    final craft = _craftMotifDetails[key];
    if (craft != null) {
      canvas.drawPath(_path(craft), Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.15 / scale
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round
        ..color = artAccent.withValues(alpha: .75));
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(PaintingMotifPainter old) =>
      old.themeId != themeId || old.accent != accent || old.artAccent != artAccent || old.card != card || old.seal != seal;
}

/// Fine edge marks derived from each painting's associated craft. The shared
/// geometry is decorative only; it never participates in input or semantics.
class CraftOrnament extends StatelessWidget {
  const CraftOrnament({super.key, required this.theme, required this.opacity});
  final PaintingTheme theme;
  final double opacity;

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: IgnorePointer(child: CustomPaint(painter: CraftOrnamentPainter(theme, opacity))),
  );
}

class CraftOrnamentPainter extends CustomPainter {
  const CraftOrnamentPainter(this.theme, this.opacity);
  final PaintingTheme theme;
  final double opacity;

  @override
  void paint(Canvas canvas, Size size) {
    if (size.isEmpty) return;
    final key = switch (theme.id) { 'warmPaper' || 'twilight' => 'warm', 'moye' => 'jiadie', _ => theme.id };
    final paths = _craftEdges[key] ?? _craftEdges['warm']!;
    final sx = size.width / 240, sy = size.height / 160;
    canvas.save();
    canvas.clipRect(Offset.zero & size);
    canvas.scale(sx, sy);
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1 / ((sx + sy) / 2)
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..color = paintingArtAccentFor(theme).withValues(alpha: opacity);
    for (final path in paths) { canvas.drawPath(_path(path), paint); }
    canvas.restore();
  }

  @override
  bool shouldRepaint(CraftOrnamentPainter old) => old.theme.id != theme.id || old.opacity != opacity;
}

// Coordinates share the prototype's 240×160 viewBox. Each mark stays near
// its own corner, leaving the surrounding content surface clear.
const _craftEdges = <String, List<String>>{
  'warm': ['M28 130C44 118 61 112 81 112H167C187 112 204 118 212 130', 'M42 139C54 131 67 127 83 127H164C180 127 193 131 200 139'],
  'jiadie': ['M25 119C72 140 168 140 215 119', 'M39 129C82 147 158 147 201 129', 'M77 136C83 123 92 116 101 112C110 116 119 123 125 136M125 136C131 123 140 116 149 112C158 116 167 123 173 136'],
  'shiqing': ['M38 134L61 114L84 134M84 134L107 114L130 134M130 134L153 114L176 134M176 134L199 114L222 134', 'M49 145L61 134L73 145M95 145L107 134L119 145M141 145L153 134L165 145M187 145L199 134L211 145'],
  'shensi': ['M36 141H174L205 110V24', 'M36 127H167L191 103V24', 'M174 141L191 124L205 110'],
  'caodie': ['M42 139C55 118 65 97 69 72M76 139C85 115 92 91 92 65M110 139C120 119 131 105 145 93'],
  'yuhua': ['M46 25V140M46 39H67M46 57H59M46 75H67M46 93H59M46 111H67M46 129H59'],
  'qiandie': ['M35 137L80 118L124 137L169 118L213 137', 'M35 146L80 127L124 146L169 127L213 146'],
  'youhua': ['M41 132C72 145 164 145 199 132', 'M61 118C78 127 83 137 83 146M179 118C162 127 157 137 157 146'],
  'liuguang': ['M35 140L86 112L123 129L177 91L213 105', 'M86 112L83 79M123 129L129 150M177 91L173 63'],
  'huandie': ['M35 140C44 117 58 103 74 103C90 103 103 117 112 140M128 140C137 117 151 103 167 103C183 103 196 117 205 140', 'M38 149H202'],
};

// One short craft detail is part of each existing painting motif, rather than
// placing a second illustration over the home-page art.
const _craftMotifDetails = <String, String>{
  'warm': 'M22 142C38 133 54 130 70 131M27 150C42 143 56 141 70 142',
  'jiadie': 'M144 139C160 145 184 145 201 138M153 145C165 149 182 149 193 145',
  'caodie': 'M182 144C189 132 195 122 202 111M190 145C195 137 201 130 207 125',
  'yuhua': 'M26 18V51M26 22H35M26 32H31M26 42H35',
  'shensi': 'M184 31H202V49M184 36H197V49M197 36L202 31',
  'qiandie': 'M164 133L178 127L192 133L206 127',
  'youhua': 'M31 135C45 141 64 141 78 135M36 142C48 146 61 146 73 142',
  'liuguang': 'M182 107L196 100L207 106M196 100L195 90',
  'huandie': 'M177 133C182 121 189 115 197 115C205 115 212 121 217 133',
  'shiqing': 'M34 126L42 118L50 126M50 126L58 118L66 126M174 121L182 113L190 121',
};

enum _PaintKind { line, accent, seal, dot, dew, glass, glass2, glass3 }

class _Shape {
  const _Shape(this.path, [this.kind = _PaintKind.line]);
  final Path path;
  final _PaintKind kind;
}

_Shape _line(String data, [bool accent = false]) => _Shape(_path(data), accent ? _PaintKind.accent : _PaintKind.line);
_Shape _circle(double x, double y, double r, _PaintKind kind) => _Shape(Path()..addOval(Rect.fromCircle(center: Offset(x, y), radius: r)), kind);
_Shape _rect(double x, double y, double w, double h, _PaintKind kind, [double radius = 0]) =>
    _Shape(Path()..addRRect(RRect.fromRectAndRadius(Rect.fromLTWH(x, y, w, h), Radius.circular(radius))), kind);

Path _path(String source) {
  final tokens = [for (final match in RegExp(r'[A-Za-z]|-?\d*\.?\d+').allMatches(source)) match.group(0)!];
  final path = Path();
  var i = 0;
  var current = Offset.zero;
  double number() => double.parse(tokens[i++]);
  while (i < tokens.length) {
    switch (tokens[i++]) {
      case 'M':
        current = Offset(number(), number());
        path.moveTo(current.dx, current.dy);
      case 'L':
        current = Offset(number(), number());
        path.lineTo(current.dx, current.dy);
      case 'H':
        current = Offset(number(), current.dy);
        path.lineTo(current.dx, current.dy);
      case 'V':
        current = Offset(current.dx, number());
        path.lineTo(current.dx, current.dy);
      case 'C':
        final c1 = Offset(number(), number());
        final c2 = Offset(number(), number());
        current = Offset(number(), number());
        path.cubicTo(c1.dx, c1.dy, c2.dx, c2.dy, current.dx, current.dy);
      case 'Z':
        path.close();
      case final command:
        throw FormatException('Unsupported motif command: $command');
    }
  }
  return path;
}

final _shapes = <String, List<_Shape>>{
  'warm': [
    _line('M20 112C64 88 107 130 190 78'),
    _line('M35 124C89 106 126 139 176 112', true),
    _rect(181, 104, 24, 24, _PaintKind.seal, 3),
  ],
  'jiadie': [
    _line('M30 140C76 112 108 66 188 22'),
    _line('M71 110C44 101 36 81 41 61C66 65 83 81 71 110Z'),
    _line('M106 78C91 52 99 32 117 20C132 43 128 65 106 78Z', true),
    _line('M133 58C153 69 174 62 190 42C166 32 145 37 133 58Z'),
    _circle(54, 44, 5, _PaintKind.dot),
  ],
  'caodie': [
    _line('M28 144C37 103 37 65 25 25M53 145C51 96 69 57 82 18M78 145C91 104 99 55 94 9M106 145C104 93 130 54 151 24M137 145C153 113 172 79 199 55M164 145C169 113 185 95 211 82'),
    _line('M51 93C29 82 22 64 29 50M103 80C127 74 139 58 143 39M145 111C170 107 186 91 192 72', true),
    _circle(84, 20, 5, _PaintKind.dot),
    _circle(153, 25, 4, _PaintKind.dot),
  ],
  'yuhua': [
    _line('M44 12V146M44 20H59M44 32H52M44 44H59M44 56H52M44 68H59M44 80H52M44 92H59M44 104H52M44 116H59M44 128H52M44 140H59'),
    _line('M90 140C112 108 137 67 183 24M118 100C93 87 91 63 99 49C122 57 133 77 118 100ZM143 66C151 42 169 35 190 39C185 62 166 75 143 66Z'),
    _circle(93, 139, 5, _PaintKind.accent),
    _circle(119, 99, 5, _PaintKind.accent),
    _circle(143, 65, 5, _PaintKind.accent),
  ],
  'shensi': [
    _rect(19, 14, 202, 132, _PaintKind.line, 3),
    _rect(28, 23, 184, 114, _PaintKind.accent, 2),
    _line('M69 124L157 36M148 34L165 31L162 48M66 125C56 133 51 133 47 131C51 124 56 118 66 125Z'),
    _line('M48 111C83 102 100 115 131 93', true),
  ],
  'qiandie': [
    _line('M24 29L89 17L102 133L37 145Z'),
    _line('M89 17L151 31L137 145L102 133Z', true),
    _line('M151 31L211 20L222 127L137 145Z'),
    _line('M50 55L70 50L75 75L55 80ZM159 83L184 78L188 103L163 108Z'),
    _circle(120, 57, 8, _PaintKind.dot),
    _circle(65, 111, 5, _PaintKind.dot),
  ],
  'youhua': [
    _line('M117 143C120 110 121 79 127 49M124 99C99 92 80 75 70 53M124 81C148 77 165 61 177 42'),
    _line('M128 54C96 49 87 28 101 18C112 9 123 20 128 31C134 13 151 9 158 22C166 37 148 52 128 54Z'),
    _line('M74 55C52 48 44 34 52 26C63 19 76 34 74 55ZM176 44C184 20 203 20 207 31C210 43 192 50 176 44Z', true),
    _circle(93, 84, 7, _PaintKind.dew),
    _circle(155, 92, 4, _PaintKind.dew),
  ],
  'liuguang': [
    _Shape(_path('M25 126L45 34L100 17L102 80L61 142Z'), _PaintKind.glass),
    _Shape(_path('M102 80L100 17L158 25L185 73L150 137L61 142Z'), _PaintKind.glass2),
    _Shape(_path('M185 73L213 122L150 137Z'), _PaintKind.glass3),
    _line('M25 126L45 34L100 17L158 25L185 73L213 122L150 137L61 142ZM45 34L102 80L100 17M102 80L61 142M102 80L185 73L150 137M158 25L102 80'),
  ],
  'huandie': [
    _circle(56, 91, 31, _PaintKind.glass),
    _circle(112, 52, 43, _PaintKind.glass2),
    _circle(163, 93, 38, _PaintKind.glass3),
    _circle(197, 42, 5, _PaintKind.dot),
    _circle(45, 37, 4, _PaintKind.dot),
    _circle(118, 128, 3, _PaintKind.dot),
    _line('M24 135C77 118 137 153 215 112'),
  ],
  'shiqing': [
    _line('M31 113C14 99 24 75 45 80C41 56 68 45 83 61C91 32 128 31 139 58C158 39 186 52 181 75C207 69 221 94 203 110C185 126 159 116 158 96C146 116 116 113 110 91C99 114 69 115 63 94C54 112 42 118 31 113Z'),
    _line('M42 132C87 119 135 146 195 122M61 143C104 132 142 151 178 137', true),
    _line('M81 62C91 76 105 77 112 62M139 59C137 76 150 83 163 72', true),
  ],
};

SliderThemeData paintingSliderTheme(PaintingTheme theme) => SliderThemeData(
      trackHeight: 4,
      activeTrackColor: theme.colors.accent,
      inactiveTrackColor: theme.colors.border,
      thumbColor: paintingThumbColorFor(theme),
      disabledThumbColor: paintingThumbColorFor(theme).withValues(alpha: .5),
      overlayColor: theme.colors.accentSoft,
      activeTickMarkColor: theme.colors.card,
      inactiveTickMarkColor: theme.colors.border,
      trackShape: theme.id == 'yuhua' ? const RectangularSliderTrackShape() : const RoundedRectSliderTrackShape(),
      thumbShape: PaintingSliderThumbShape(theme),
      overlayShape: const RoundSliderOverlayShape(overlayRadius: 20),
    );

class PaintingSliderThumbShape extends SliderComponentShape {
  const PaintingSliderThumbShape(this.theme);
  final PaintingTheme theme;

  @override
  Size getPreferredSize(bool isEnabled, bool isDiscrete) => theme.id == 'yuhua' ? const Size(14, 20) : const Size(20, 20);

  @override
  void paint(
    PaintingContext context,
    Offset center, {
    required Animation<double> activationAnimation,
    required Animation<double> enableAnimation,
    required bool isDiscrete,
    required TextPainter labelPainter,
    required RenderBox parentBox,
    required SliderThemeData sliderTheme,
    required TextDirection textDirection,
    required double value,
    required double textScaleFactor,
    required Size sizeWithOverflow,
  }) {
    final scale = 1 + .16 * activationAnimation.value;
    final color = Color.lerp(sliderTheme.disabledThumbColor, sliderTheme.thumbColor, enableAnimation.value)!;
    final path = Path();
    if (theme.id == 'shiqing') {
      final d = 8 * scale;
      path
        ..moveTo(center.dx, center.dy - d)
        ..lineTo(center.dx + d, center.dy)
        ..lineTo(center.dx, center.dy + d)
        ..lineTo(center.dx - d, center.dy)
        ..close();
    } else if (theme.id != 'yuhua' && craftGeometryFor(theme.id) == CraftGeometry.angular) {
      final bounds = Rect.fromCenter(center: center, width: 16 * scale, height: 16 * scale);
      path.addPath(BeveledRectangleBorder(borderRadius: BorderRadius.circular(3 * scale)).getOuterPath(bounds), Offset.zero);
    } else {
      final width = (theme.id == 'yuhua' ? 9.0 : 16.0) * scale;
      path.addRRect(RRect.fromRectAndRadius(Rect.fromCenter(center: center, width: width, height: 16 * scale), Radius.circular(theme.id == 'yuhua' ? 2 : width / 2)));
    }
    context.canvas.drawShadow(path, Colors.black, 1 + activationAnimation.value, true);
    context.canvas.drawPath(path, Paint()..color = color);
    context.canvas.drawPath(path, Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1
      ..color = paintingArtAccentFor(theme).withValues(alpha: .28));
  }
}
