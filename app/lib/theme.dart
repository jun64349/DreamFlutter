import 'package:flutter/material.dart';

/// Every visual decision lives here (colors, type, radii, spacing, the
/// butterfly), so a theme is one set of values.
///
/// The current theme is 「蛱蝶」, after Zhao Chang's Northern Song scroll
/// 《写生蛱蝶图》: paper-silk ground, ink text, mineral green, a touch of
/// ochre and a cinnabar seal; Song typefaces, fine lines, almost no shadows.
/// See docs/v0.2-design.md.
class AppTokens {
  static const radiusSm = 4.0;
  static const radius = 6.0;
  static const radiusLg = 10.0;

  static const gap = 8.0;
  static const pad = 12.0;
  static const padLg = 16.0;

  static const railWidth = 72.0;
  static const sidebarWidth = 248.0;
  static const runPanelWidth = 300.0;

  /// Reading width of the conversation.
  static const contentMaxWidth = 720.0;

  /// Interface text. Windows 11 ships Noto Sans SC / Noto Serif SC.
  static const fontFamily = 'Noto Sans SC';
  static const fontFallback = ['Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Segoe UI'];

  /// Headings and the reply body.
  static const serifFamily = 'Noto Serif SC';
  static const serifFallback = ['Source Han Serif SC', 'Songti SC', 'SimSun', 'serif'];

  static const monoFamily = 'Cascadia Mono';
  static const monoFallback = ['Consolas', 'Courier New', 'monospace'];

  /// Letter spacing of small section labels (「今天」「步骤」).
  static const labelSpacing = 1.4;

  static const fast = Duration(milliseconds: 160);
  static const medium = Duration(milliseconds: 260);
}

/// Semantic colors not covered by [ColorScheme].
@immutable
class AppColors extends ThemeExtension<AppColors> {
  const AppColors({
    required this.rail,
    required this.sidebar,
    required this.background,
    required this.userBubble,
    required this.onUserBubble,
    required this.card,
    required this.border,
    required this.ink,
    required this.ink2,
    required this.muted,
    required this.accent,
    required this.onAccent,
    required this.accentSoft,
    required this.ochre,
    required this.seal,
    required this.success,
    required this.warning,
    required this.danger,
    required this.codeBackground,
    required this.terminal,
    required this.onTerminal,
    required this.terminalMuted,
    required this.terminalError,
    required this.wingUpper,
    required this.wingLower,
    required this.diffAdded,
    required this.diffRemoved,
  });

  /// Navigation rail, side panels, page ground.
  final Color rail;
  final Color sidebar;
  final Color background;
  final Color userBubble;
  final Color onUserBubble;

  /// Raised surfaces: cards, the input box, menus.
  final Color card;
  final Color border;
  final Color ink;
  final Color ink2;
  final Color muted;

  /// 石绿 mineral green.
  final Color accent;
  final Color onAccent;
  final Color accentSoft;

  /// 赭石 ochre, for secondary emphasis.
  final Color ochre;

  /// 朱砂 cinnabar, only for the seal.
  final Color seal;
  final Color success;
  final Color warning;
  final Color danger;
  final Color codeBackground;
  final Color terminal;
  final Color onTerminal;
  final Color terminalMuted;
  final Color terminalError;

  /// The butterfly's wash colors.
  final Color wingUpper;
  final Color wingLower;
  final Color diffAdded;
  final Color diffRemoved;

  static const light = AppColors(
    rail: Color(0xFFE9DFCA),
    sidebar: Color(0xFFEFE7D5),
    background: Color(0xFFF3ECDD),
    userBubble: Color(0xFFE6DBC4),
    onUserBubble: Color(0xFF2B2620),
    card: Color(0xFFFAF6EC),
    border: Color(0x294A3A24),
    ink: Color(0xFF2B2620),
    ink2: Color(0xFF4A4238),
    muted: Color(0xFF6B6052),
    accent: Color(0xFF3F6E5E),
    onAccent: Color(0xFFFBF8F1),
    accentSoft: Color(0x1F3F6E5E),
    ochre: Color(0xFF9A5B32),
    seal: Color(0xFFA8332A),
    success: Color(0xFF3F6E5E),
    warning: Color(0xFF9A5B32),
    danger: Color(0xFFA8332A),
    codeBackground: Color(0xFFEDE4D1),
    terminal: Color(0xFF2E2A24),
    onTerminal: Color(0xFFE8DFCB),
    terminalMuted: Color(0xFFC2B69C),
    terminalError: Color(0xFFE8A091),
    wingUpper: Color(0xFFE3C995),
    wingLower: Color(0xFFAFC3A0),
    diffAdded: Color(0x293F6E5E),
    diffRemoved: Color(0x24A8332A),
  );

  /// 墨夜: the same painting by lamplight.
  static const dark = AppColors(
    rail: Color(0xFF181512),
    sidebar: Color(0xFF1C1915),
    background: Color(0xFF211E19),
    userBubble: Color(0xFF353028),
    onUserBubble: Color(0xFFECE3D2),
    card: Color(0xFF2A2620),
    border: Color(0x24ECE3D2),
    ink: Color(0xFFECE3D2),
    ink2: Color(0xFFD2C7B3),
    muted: Color(0xFFA89C84),
    accent: Color(0xFF86B8A6),
    onAccent: Color(0xFF14211C),
    accentSoft: Color(0x2486B8A6),
    ochre: Color(0xFFD39A6A),
    seal: Color(0xFFD5675A),
    success: Color(0xFF86B8A6),
    warning: Color(0xFFD39A6A),
    danger: Color(0xFFE07A6C),
    codeBackground: Color(0xFF1A1714),
    terminal: Color(0xFF14120F),
    onTerminal: Color(0xFFE8DFCB),
    terminalMuted: Color(0xFFA89C84),
    terminalError: Color(0xFFE8A091),
    wingUpper: Color(0xFFB89B63),
    wingLower: Color(0xFF7D957A),
    diffAdded: Color(0x3386B8A6),
    diffRemoved: Color(0x33E07A6C),
  );

  @override
  AppColors copyWith() => this;

  @override
  AppColors lerp(ThemeExtension<AppColors>? other, double t) => t < 0.5 || other is! AppColors ? this : other;
}

extension AppThemeContext on BuildContext {
  AppColors get colors => Theme.of(this).extension<AppColors>()!;
  TextTheme get text => Theme.of(this).textTheme;

  /// [style] in the Song typeface used for headings and replies.
  TextStyle serif(TextStyle? style) =>
      (style ?? const TextStyle()).copyWith(fontFamily: AppTokens.serifFamily, fontFamilyFallback: AppTokens.serifFallback);

  /// A small spaced-out section label (「今天」「步骤」).
  TextStyle? get label => text.labelSmall?.copyWith(color: colors.muted, letterSpacing: AppTokens.labelSpacing);
}

ThemeData buildTheme(Brightness brightness) {
  final isDark = brightness == Brightness.dark;
  final c = isDark ? AppColors.dark : AppColors.light;
  final scheme = ColorScheme(
    brightness: brightness,
    primary: c.accent,
    onPrimary: c.onAccent,
    primaryContainer: c.accentSoft,
    onPrimaryContainer: c.ink,
    secondary: c.ochre,
    onSecondary: c.onAccent,
    secondaryContainer: c.userBubble,
    onSecondaryContainer: c.ink,
    tertiary: c.seal,
    onTertiary: c.onAccent,
    error: c.danger,
    onError: c.onAccent,
    surface: c.background,
    onSurface: c.ink,
    onSurfaceVariant: c.muted,
    surfaceContainerLowest: c.card,
    surfaceContainerLow: c.card,
    surfaceContainer: c.card,
    surfaceContainerHigh: c.card,
    surfaceContainerHighest: c.sidebar,
    surfaceTint: Colors.transparent,
    outline: c.border,
    outlineVariant: c.border,
    inverseSurface: c.ink,
    onInverseSurface: c.background,
    shadow: Colors.black,
  );
  final base = ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    fontFamily: AppTokens.fontFamily,
    fontFamilyFallback: AppTokens.fontFallback,
    extensions: [c],
    visualDensity: VisualDensity.compact,
    dividerColor: c.border,
    scaffoldBackgroundColor: c.background,
    canvasColor: c.background,
    splashFactory: InkSparkle.splashFactory,
  );
  TextStyle? serif(TextStyle? s, {FontWeight weight = FontWeight.w600}) =>
      s?.copyWith(fontFamily: AppTokens.serifFamily, fontFamilyFallback: AppTokens.serifFallback, fontWeight: weight, color: c.ink);
  final text = base.textTheme.apply(bodyColor: c.ink, displayColor: c.ink);
  final textTheme = text.copyWith(
    displayLarge: serif(text.displayLarge),
    displayMedium: serif(text.displayMedium),
    displaySmall: serif(text.displaySmall),
    headlineLarge: serif(text.headlineLarge),
    headlineMedium: serif(text.headlineMedium),
    headlineSmall: serif(text.headlineSmall),
    titleLarge: serif(text.titleLarge),
    titleMedium: serif(text.titleMedium),
  );
  final radius = BorderRadius.circular(AppTokens.radius);
  final shape = RoundedRectangleBorder(borderRadius: radius);
  final border = OutlineInputBorder(borderRadius: radius, borderSide: BorderSide(color: c.border));
  return base.copyWith(
    textTheme: textTheme,
    dividerTheme: DividerThemeData(color: c.border, thickness: 0.5, space: 0.5),
    inputDecorationTheme: InputDecorationTheme(
      border: border,
      enabledBorder: border,
      focusedBorder: border.copyWith(borderSide: BorderSide(color: c.accent)),
      filled: true,
      fillColor: c.card,
      contentPadding: const EdgeInsets.symmetric(horizontal: AppTokens.pad, vertical: 10),
      isDense: true,
      hintStyle: TextStyle(color: c.muted),
    ),
    filledButtonTheme: FilledButtonThemeData(style: FilledButton.styleFrom(shape: shape, elevation: 0)),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(shape: shape, foregroundColor: c.ink, side: BorderSide(color: c.border)),
    ),
    textButtonTheme: TextButtonThemeData(style: TextButton.styleFrom(shape: shape, foregroundColor: c.accent)),
    iconButtonTheme: IconButtonThemeData(style: IconButton.styleFrom(foregroundColor: c.muted, shape: shape)),
    segmentedButtonTheme: SegmentedButtonThemeData(
      style: SegmentedButton.styleFrom(
        shape: shape,
        side: BorderSide(color: c.border),
        selectedBackgroundColor: c.accentSoft,
        selectedForegroundColor: c.ink,
      ),
    ),
    cardTheme: CardThemeData(color: c.card, elevation: 0, shape: RoundedRectangleBorder(borderRadius: radius, side: BorderSide(color: c.border))),
    dialogTheme: DialogThemeData(
      backgroundColor: c.card,
      elevation: 2,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppTokens.radiusLg)),
      titleTextStyle: serif(text.titleLarge),
    ),
    popupMenuTheme: PopupMenuThemeData(
      color: c.card,
      elevation: 3,
      shape: RoundedRectangleBorder(borderRadius: radius, side: BorderSide(color: c.border)),
    ),
    menuTheme: MenuThemeData(style: MenuStyle(backgroundColor: WidgetStatePropertyAll(c.card))),
    tooltipTheme: TooltipThemeData(
      waitDuration: const Duration(milliseconds: 500),
      decoration: BoxDecoration(color: c.ink.withValues(alpha: 0.92), borderRadius: BorderRadius.circular(AppTokens.radiusSm)),
      textStyle: TextStyle(color: c.background, fontSize: 12),
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: c.ink,
      contentTextStyle: TextStyle(color: c.background),
      actionTextColor: c.wingUpper,
      shape: shape,
    ),
    tabBarTheme: TabBarThemeData(
      labelColor: c.ink,
      unselectedLabelColor: c.muted,
      indicatorColor: c.accent,
      dividerColor: c.border,
    ),
    chipTheme: ChipThemeData(backgroundColor: c.card, side: BorderSide(color: c.border), shape: shape),
    listTileTheme: ListTileThemeData(shape: shape, iconColor: c.muted),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? c.onAccent : c.muted),
      trackColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? c.accent : c.border),
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: c.accent, linearTrackColor: c.border),
    scrollbarTheme: ScrollbarThemeData(
      thickness: const WidgetStatePropertyAll(6),
      radius: const Radius.circular(3),
      thumbColor: WidgetStatePropertyAll(c.muted.withValues(alpha: 0.35)),
    ),
    appBarTheme: AppBarTheme(backgroundColor: c.background, foregroundColor: c.ink, titleTextStyle: serif(text.titleLarge)),
  );
}

// ---------------------------------------------------------------------------
// The butterfly and the seal
// ---------------------------------------------------------------------------

/// The 蛱蝶 mark: a gongbi butterfly in ink line with a pale wash, drawn from
/// the same outline as the design mockups (a 120 × 90 box).
class ButterflyMark extends StatelessWidget {
  const ButterflyMark({super.key, this.size = 36, this.veins = false, this.semanticLabel});

  /// Width; the height is three quarters of it.
  final double size;

  /// Draw wing veins and spots (for large sizes).
  final bool veins;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final painter = CustomPaint(
      size: Size(size, size * 0.75),
      painter: _ButterflyPainter(ink: colors.ink, upper: colors.wingUpper, lower: colors.wingLower, spot: colors.ochre, veins: veins),
    );
    return semanticLabel == null ? ExcludeSemantics(child: painter) : Semantics(label: semanticLabel, image: true, child: painter);
  }
}

class _ButterflyPainter extends CustomPainter {
  _ButterflyPainter({required this.ink, required this.upper, required this.lower, required this.spot, required this.veins});

  final Color ink;
  final Color upper;
  final Color lower;
  final Color spot;
  final bool veins;

  static Path _upperWing() => Path()
    ..moveTo(60, 40)
    ..cubicTo(70, 20, 92, 6, 110, 10)
    ..cubicTo(118, 12, 116, 28, 106, 38)
    ..cubicTo(98, 46, 80, 46, 62, 44)
    ..close();

  static Path _lowerWing() => Path()
    ..moveTo(61, 46)
    ..cubicTo(78, 48, 94, 56, 96, 70)
    ..cubicTo(97, 80, 86, 84, 78, 78)
    ..cubicTo(70, 72, 64, 60, 61, 48)
    ..close();

  @override
  void paint(Canvas canvas, Size size) {
    canvas.save();
    canvas.scale(size.width / 120, size.height / 90);
    final scale = size.width / 120;
    final line = Paint()
      ..color = ink
      ..style = PaintingStyle.stroke
      ..strokeJoin = StrokeJoin.round
      // About one pixel wide at any size, never thinner than the drawing's own line.
      ..strokeWidth = (1.1 / scale).clamp(0.8, 6.0);
    final mirror = Matrix4.identity()
      ..translateByDouble(120, 0, 0, 1)
      ..scaleByDouble(-1, 1, 1, 1);
    for (final (path, color) in [(_upperWing(), upper), (_lowerWing(), lower)]) {
      for (final p in [path, path.transform(mirror.storage)]) {
        canvas.drawPath(p, Paint()..color = color.withValues(alpha: 0.75));
        canvas.drawPath(p, line);
      }
    }
    if (veins) {
      final vein = Paint()
        ..color = ink.withValues(alpha: 0.6)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 0.45;
      final right = Path()
        ..moveTo(62, 42)
        ..lineTo(104, 16)
        ..moveTo(62, 43)
        ..lineTo(109, 27)
        ..moveTo(63, 44)
        ..lineTo(98, 40)
        ..moveTo(62, 47)
        ..lineTo(90, 64)
        ..moveTo(62, 48)
        ..lineTo(80, 76);
      canvas.drawPath(right, vein);
      canvas.drawPath(right.transform(mirror.storage), vein);
      final dot = Paint()..color = spot.withValues(alpha: 0.75);
      canvas.drawCircle(const Offset(86, 68), 2.6, dot);
      canvas.drawCircle(const Offset(34, 68), 2.6, dot);
      final antenna = Path()
        ..moveTo(59, 36)
        ..cubicTo(56, 25, 52, 18, 47, 14)
        ..moveTo(61, 36)
        ..cubicTo(64, 25, 68, 18, 73, 14);
      canvas.drawPath(antenna, line..strokeWidth = 0.7);
    }
    canvas.drawOval(Rect.fromCenter(center: const Offset(60, 47), width: veins ? 3.6 : 6, height: veins ? 24 : 26), Paint()..color = ink);
    canvas.restore();
  }

  @override
  bool shouldRepaint(_ButterflyPainter old) => old.ink != ink || old.upper != upper || old.lower != lower || old.veins != veins;
}

/// The cinnabar 「梦蝶」 seal.
class SealStamp extends StatelessWidget {
  const SealStamp({super.key, this.size = 34});

  final double size;

  @override
  Widget build(BuildContext context) {
    final seal = context.colors.seal;
    final style = TextStyle(
      fontFamily: AppTokens.serifFamily,
      fontFamilyFallback: AppTokens.serifFallback,
      fontWeight: FontWeight.w700,
      fontSize: size * 0.34,
      height: 1,
      color: seal,
    );
    return Semantics(
      label: '朱印：梦蝶',
      image: true,
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(border: Border.all(color: seal, width: 1.5), borderRadius: BorderRadius.circular(3)),
        // Read right to left, top to bottom: 梦蝶.
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceEvenly,
          children: [
            ExcludeSemantics(child: Text('蝶', style: style)),
            ExcludeSemantics(child: Text('梦', style: style)),
          ],
        ),
      ),
    );
  }
}
