import 'package:flutter/material.dart';

import '../craft_style.dart';
import '../theme.dart';
import 'painting_art.dart';

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

/// Selection belongs to the current painting, with enough lift in dark themes.
/// Only paint changes: callers retain their own hit regions and semantics.
class CraftSelectionSurface extends StatelessWidget {
  const CraftSelectionSurface({super.key, required this.child, this.selected = true});
  final Widget child;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final theme = context.painting, colors = context.colors;
    final dark = theme.isDark;
    final ground = Color.alphaBlend(colors.ink.withValues(alpha: dark ? .035 : 0), colors.sidebar);
    return AnimatedContainer(
      duration: AppTokens.motion(context, AppTokens.medium),
      curve: AppTokens.curve,
      decoration: ShapeDecoration(
        gradient: selected ? LinearGradient(colors: [
          Color.alphaBlend(colors.accent.withValues(alpha: dark ? .25 : .16), ground),
          Color.alphaBlend(paintingArtAccentFor(theme).withValues(alpha: dark ? .14 : .08), ground),
        ]) : null,
        color: selected ? null : Colors.transparent,
        shape: craftSurfaceShape(context, radius: 10,
          borderColor: selected ? colors.accent.withValues(alpha: dark ? .34 : .22) : Colors.transparent,
          engraved: selected),
      ),
      child: Stack(fit: StackFit.passthrough, children: [
        if (selected) Positioned(right: 4, top: 0, width: 36, height: 20,
          child: CraftOrnament(theme: theme, opacity: dark ? .32 : .22)),
        child,
      ]),
    );
  }
}
