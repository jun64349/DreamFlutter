import 'package:flutter/material.dart';

import '../craft_style.dart';
import '../theme.dart';

/// Shared vessel / joinery edge for composed surfaces. It changes paint only;
/// padding, hit targets, focus order and the existing content stay with callers.
CraftSurfaceBorder craftSurfaceShape(
  BuildContext context, {
  double radius = 12,
  Color? borderColor,
  double borderWidth = 1,
  bool engraved = true,
}) => CraftSurfaceBorder(
  geometry: context.painting.craftGeometry,
  radius: radius,
  side: BorderSide(color: borderColor ?? context.colors.border, width: borderWidth),
  detailColor: engraved ? context.colors.accent.withValues(alpha: context.painting.isDark ? .28 : .22) : null,
);

ShapeDecoration craftSurfaceDecoration(
  BuildContext context, {
  Color? color,
  Color? borderColor,
  double borderWidth = 1,
  double radius = 12,
  bool engraved = true,
  List<BoxShadow>? shadows,
}) => ShapeDecoration(
  color: color ?? context.colors.card,
  shape: craftSurfaceShape(context, radius: radius, borderColor: borderColor,
    borderWidth: borderWidth, engraved: engraved),
  shadows: shadows,
);
