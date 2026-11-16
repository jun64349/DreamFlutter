import 'dart:math' as math;
import 'dart:ui' show lerpDouble;

import 'package:flutter/material.dart';

/// Shared control geometry. The painting theme still owns its palette and motif.
enum CraftGeometry { curved, angular }

CraftGeometry craftGeometryFor(String paintingId) => switch (paintingId) {
  // Japanese folds and American glass share straight cuts, not a cultural origin.
  'caodie' || 'yuhua' || 'shensi' || 'qiandie' || 'youhua' || 'liuguang' || 'huandie' =>
    CraftGeometry.angular,
  _ => CraftGeometry.curved,
};

OutlinedBorder craftButtonShape(CraftGeometry geometry, {double radius = 10}) =>
    CraftSurfaceBorder(geometry: geometry, radius: radius);

/// A painted face that also defines its ink, focus outline and clipping path.
/// The optional detail is one short mark inside the edge of a large surface.
class CraftSurfaceBorder extends OutlinedBorder {
  const CraftSurfaceBorder({
    required this.geometry,
    super.side = BorderSide.none,
    this.radius = 12,
    this.detailColor,
  }) : assert(radius >= 0);

  final CraftGeometry geometry;
  final double radius;
  final Color? detailColor;

  double get _chamfer => radius < 4 ? radius : radius <= 10 ? 3 : radius <= 14 ? 4 : 5;

  Path _outline(Rect rect) {
    if (rect.isEmpty) return Path();
    final l = rect.left, t = rect.top, r = rect.right, b = rect.bottom;
    final half = rect.shortestSide / 2;
    final path = Path();
    if (geometry == CraftGeometry.angular) {
      final cut = math.min(_chamfer, half);
      return path
        ..moveTo(l + cut, t)..lineTo(r - cut, t)..lineTo(r, t + cut)
        ..lineTo(r, b - cut)..lineTo(r - cut, b)..lineTo(l + cut, b)
        ..lineTo(l, b - cut)..lineTo(l, t + cut)..close();
    }
    final shoulder = math.min(radius, half);
    final foot = shoulder * .8;
    final inset = shoulder * .18;
    final waist = rect.center.dy;
    return path
      ..moveTo(l + shoulder, t)..lineTo(r - shoulder, t)
      ..quadraticBezierTo(r, t, r, t + shoulder)
      ..cubicTo(r, waist, r - inset / 2, b, r - foot - inset, b)
      ..lineTo(l + foot + inset, b)
      ..cubicTo(l + inset / 2, b, l, waist, l, t + shoulder)
      ..quadraticBezierTo(l, t, l + shoulder, t)..close();
  }

  @override
  Path getOuterPath(Rect rect, {TextDirection? textDirection}) => _outline(rect);

  @override
  Path getInnerPath(Rect rect, {TextDirection? textDirection}) =>
      _outline(rect.deflate(side.strokeInset));

  @override
  void paint(Canvas canvas, Rect rect, {TextDirection? textDirection}) {
    if (rect.isEmpty) return;
    if (side.style != BorderStyle.none) {
      canvas.drawPath(
        _outline(rect.inflate(side.strokeOffset / 2)),
        side.toPaint()..strokeJoin = geometry == CraftGeometry.curved ? StrokeJoin.round : StrokeJoin.bevel,
      );
    }
    final detail = detailColor;
    if (detail == null || detail.a == 0 || rect.width < 28 || rect.height < 22) return;
    canvas.save();
    canvas.clipPath(_outline(rect.deflate(side.strokeInset)));
    _paintEdge(canvas, rect, geometry, detail, surface: true);
    canvas.restore();
  }

  @override
  CraftSurfaceBorder copyWith({BorderSide? side, double? radius, Color? detailColor}) => CraftSurfaceBorder(
    geometry: geometry,
    side: side ?? this.side,
    radius: radius ?? this.radius,
    detailColor: detailColor ?? this.detailColor,
  );

  @override
  CraftSurfaceBorder scale(double t) => CraftSurfaceBorder(
    geometry: geometry, side: side.scale(t), radius: radius * t, detailColor: Color.lerp(null, detailColor, t),
  );

  static CraftSurfaceBorder _lerp(CraftSurfaceBorder a, CraftSurfaceBorder b, double t) => CraftSurfaceBorder(
    geometry: t < .5 ? a.geometry : b.geometry,
    side: BorderSide.lerp(a.side, b.side, t),
    radius: lerpDouble(a.radius, b.radius, t)!,
    detailColor: Color.lerp(a.detailColor, b.detailColor, t),
  );

  @override
  ShapeBorder? lerpFrom(ShapeBorder? a, double t) =>
      a is CraftSurfaceBorder ? _lerp(a, this, t) : super.lerpFrom(a, t);

  @override
  ShapeBorder? lerpTo(ShapeBorder? b, double t) =>
      b is CraftSurfaceBorder ? _lerp(this, b, t) : super.lerpTo(b, t);

  @override
  bool operator ==(Object other) => other is CraftSurfaceBorder &&
      other.geometry == geometry && other.side == side && other.radius == radius && other.detailColor == detailColor;

  @override
  int get hashCode => Object.hash(geometry, side, radius, detailColor);
}

/// Lets InputDecorator retain its floating-label gap, validation and autofill.
ShapedInputBorder craftInputBorder(
  CraftGeometry geometry, {
  BorderSide side = BorderSide.none,
  double radius = 12,
  Color? detailColor,
}) => ShapedInputBorder(
  shape: CraftSurfaceBorder(geometry: geometry, radius: radius, detailColor: detailColor),
  borderSide: side.copyWith(strokeAlign: BorderSide.strokeAlignCenter),
);

bool craftKeyboardFocus(Set<WidgetState> states) =>
    states.contains(WidgetState.focused) && !states.contains(WidgetState.disabled) &&
    FocusManager.instance.highlightMode == FocusHighlightMode.traditional;

void _paintEdge(Canvas canvas, Rect rect, CraftGeometry geometry, Color color, {
  bool selected = false, bool surface = false,
}) {
  final stroke = Paint()..color = color..style = PaintingStyle.stroke..strokeWidth = 1;
  final center = surface ? rect.right - 22 : rect.center.dx;
  final bottom = rect.bottom - (surface ? 5.5 : 3.5);
  if (geometry == CraftGeometry.curved) {
    final half = surface ? 9.0 : selected ? 5.0 : 6.0;
    canvas.drawPath(Path()
      ..moveTo(center - half, bottom - 1.5)
      ..quadraticBezierTo(center, bottom + 1.5, center + half, bottom - 1.5),
      stroke..strokeCap = StrokeCap.round,
    );
  } else if (selected) {
    canvas.drawLine(Offset(center - 5, bottom), Offset(center + 5, bottom), stroke);
  } else {
    final start = surface ? const Offset(12, 4) : const Offset(8, 3);
    final end = surface ? const Offset(4, 12) : const Offset(3, 8);
    canvas.drawLine(Offset(rect.right - start.dx, rect.top + start.dy), Offset(rect.right - end.dx, rect.top + end.dy), stroke);
  }
}

/// A small edge detail, drawn on the existing surface without taking pointer input.
class CraftControlMark extends StatelessWidget {
  const CraftControlMark({
    super.key,
    required this.geometry,
    required this.color,
    required this.child,
    this.selected = false,
  });

  final CraftGeometry geometry;
  final Color color;
  final Widget child;
  final bool selected;

  @override
  Widget build(BuildContext context) => CustomPaint(
    foregroundPainter: _CraftControlMarkPainter(geometry, color, selected),
    child: child,
  );
}

class _CraftControlMarkPainter extends CustomPainter {
  const _CraftControlMarkPainter(this.geometry, this.color, this.selected);

  final CraftGeometry geometry;
  final Color color;
  final bool selected;

  @override
  void paint(Canvas canvas, Size size) {
    if (color.a == 0 || size.width < 24 || size.height < 22) return;
    _paintEdge(canvas, Offset.zero & size, geometry, color, selected: selected);
  }

  @override
  bool hitTest(Offset position) => false;

  @override
  bool shouldRepaint(_CraftControlMarkPainter oldDelegate) =>
      oldDelegate.geometry != geometry || oldDelegate.color != color || oldDelegate.selected != selected;
}
