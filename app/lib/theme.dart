import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import 'butterfly_art.dart';

/// Every visual decision lives here (colors, type, radii, spacing, the
/// butterfly), so a theme is one set of values.
///
/// The current theme is 「蛱蝶」, after Zhao Chang's Northern Song scroll
/// 《写生蛱蝶图》: paper-silk ground, ink text, mineral green, a touch of
/// ochre and a cinnabar seal; Song typefaces, fine lines, almost no shadows.
/// See docs/v0.2-design.md.
class AppTokens {
  // Corner radii of 「蛱蝶」; widgets use context.radius*, which follow the theme.
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
    required this.butterfly,
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

  /// The butterfly mark's colors (docs/design/brand.md, section 二.2).
  final ButterflyColors butterfly;
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
    butterfly: ButterflyColors(ground: Color(0xFFEEE7D7), line: Color(0xFF3F3B34), core: Color(0xFFF3F0E4), wing: Color(0xFFCA704D), glow: Color(0xFFE8CCB0)),
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
    butterfly: ButterflyColors(ground: Color(0xFF1C1915), line: Color(0xFFFFFFFF), core: Color(0xFF2A2620), wing: Color(0xFFD39A6A), glow: Color(0xFFB89B63)),
    diffAdded: Color(0x3386B8A6),
    diffRemoved: Color(0x33E07A6C),
  );

  @override
  AppColors copyWith() => this;

  @override
  AppColors lerp(ThemeExtension<AppColors>? other, double t) => t < 0.5 || other is! AppColors ? this : other;
}

/// What sits in the corner of the paper and beside the inscription.
enum MarkKind {
  /// A square cinnabar seal with two characters (「梦蝶」).
  seal,

  /// A plate label in italic serif, like a natural-history engraving.
  plate,

  /// The butterfly as a small solid glyph.
  glyph,
}

/// A theme taken from one painting or artwork: its colors, the shape of
/// corners, the heading face, and the small details that carry it (the mark,
/// the inscription in the sidebar). Users pick one for daytime and one for
/// night; see docs/research/art-themes.md for the sources.
@immutable
class PaintingTheme {
  const PaintingTheme({
    required this.id,
    required this.name,
    required this.work,
    required this.colors,
    this.brightness = Brightness.light,
    this.radiusSm = 4,
    this.radius = 6,
    this.radiusLg = 10,
    this.serifFamily = 'Noto Serif SC',
    this.labelSpacing = 1.4,
    this.mark = MarkKind.seal,
    this.markText = '梦蝶',
    this.inscription = '栩栩然胡蝶也',
    this.verticalInscription = true,
    this.butterflyStroke = 1.0,
  });

  final String id;

  /// Two characters: 「蛱蝶」.
  final String name;

  /// The source, as shown in the theme picker.
  final String work;
  final AppColors colors;
  final Brightness brightness;
  final double radiusSm;
  final double radius;
  final double radiusLg;

  /// Headings and replies; Latin letters come from this face, Chinese from
  /// the Song fallbacks.
  final String serifFamily;
  final double labelSpacing;
  final MarkKind mark;
  final String markText;

  /// Written in the sidebar: top to bottom for Chinese, turned sideways for Latin.
  final String inscription;
  final bool verticalInscription;

  /// Line weight of the butterfly's outline (leaded glass draws it heavier).
  final double butterflyStroke;

  bool get isDark => brightness == Brightness.dark;

  /// 赵昌《写生蛱蝶图》, the first theme.
  static const jiadie = PaintingTheme(id: 'jiadie', name: '蛱蝶', work: '北宋 · 赵昌《写生蛱蝶图》', colors: AppColors.light);

  /// The same painting by lamplight.
  static const moye = PaintingTheme(id: 'moye', name: '墨夜', work: '北宋 · 赵昌《写生蛱蝶图》，灯下', colors: AppColors.dark, brightness: Brightness.dark);

  /// Van Gogh, Long Grass with Butterflies (1890, National Gallery, London).
  static const caodie = PaintingTheme(
    id: 'caodie',
    name: '草蝶',
    work: '梵高《开花的长草与蝴蝶》，1890',
    radiusSm: 6,
    radius: 12,
    radiusLg: 18,
    serifFamily: 'Georgia',
    labelSpacing: 0.8,
    mark: MarkKind.glyph,
    inscription: 'Long Grass with Butterflies',
    verticalInscription: false,
    colors: AppColors(
      rail: Color(0xFFDDE3CB),
      sidebar: Color(0xFFE8EBD8),
      background: Color(0xFFF6F7EC),
      userBubble: Color(0xFFE3E9D2),
      onUserBubble: Color(0xFF1F281B),
      card: Color(0xFFFFFFFB),
      border: Color(0x2B1F281B),
      ink: Color(0xFF1F281B),
      ink2: Color(0xFF34402F),
      muted: Color(0xFF525E4B),
      accent: Color(0xFF3C6B32),
      onAccent: Color(0xFFFFFFFB),
      accentSoft: Color(0x1F3C6B32),
      ochre: Color(0xFF8F5F12),
      seal: Color(0xFFC0462C),
      success: Color(0xFF3C6B32),
      warning: Color(0xFF8F5F12),
      danger: Color(0xFFB23A24),
      codeBackground: Color(0xFFECEFDF),
      terminal: Color(0xFF1F281B),
      onTerminal: Color(0xFFE8EBD8),
      terminalMuted: Color(0xFFB3BCA4),
      terminalError: Color(0xFFE8A091),
      butterfly: ButterflyColors(ground: Color(0xFFE8EBD8), line: Color(0xFF1F281B), core: Color(0xFFFFFFFB), wing: Color(0xFF3C6B32), glow: Color(0xFFF4EDB8)),
      diffAdded: Color(0x293C6B32),
      diffRemoved: Color(0x24B23A24),
    ),
  );

  /// Maria Sibylla Merian, Metamorphosis insectorum Surinamensium (1705).
  static const yuhua = PaintingTheme(
    id: 'yuhua',
    name: '羽化',
    work: '梅里安《苏里南昆虫变态图谱》，1705',
    radiusSm: 2,
    radius: 2,
    radiusLg: 3,
    serifFamily: 'Sitka Heading',
    labelSpacing: 2.4,
    mark: MarkKind.plate,
    markText: 'Tab. LVIII',
    inscription: 'Metamorphosis insectorum Surinamensium',
    verticalInscription: false,
    colors: AppColors(
      rail: Color(0xFFE4DCC6),
      sidebar: Color(0xFFECE5D3),
      background: Color(0xFFF7F3E9),
      userBubble: Color(0xFFE9E2CF),
      onUserBubble: Color(0xFF241E19),
      card: Color(0xFFFFFFFF),
      border: Color(0x33241E19),
      ink: Color(0xFF241E19),
      ink2: Color(0xFF3A3229),
      muted: Color(0xFF5C5245),
      accent: Color(0xFF18649A),
      onAccent: Color(0xFFFFFFFF),
      accentSoft: Color(0x1A18649A),
      ochre: Color(0xFF456A40),
      seal: Color(0xFFB0502F),
      success: Color(0xFF456A40),
      warning: Color(0xFF835519),
      danger: Color(0xFFA04729),
      codeBackground: Color(0xFFEFE9DA),
      terminal: Color(0xFF241E19),
      onTerminal: Color(0xFFECE5D3),
      terminalMuted: Color(0xFFB8AD99),
      terminalError: Color(0xFFE8A091),
      butterfly: ButterflyColors(ground: Color(0xFFECE5D3), line: Color(0xFF241E19), core: Color(0xFFFFFFFF), wing: Color(0xFF18649A), glow: Color(0xFF9FC2DF)),
      diffAdded: Color(0x24456A40),
      diffRemoved: Color(0x24A04729),
    ),
  );

  /// Dosso Dossi, Jupiter, Mercury and Virtue (about 1523, Wawel Royal Castle).
  static const shensi = PaintingTheme(
    id: 'shensi',
    name: '神思',
    work: '多索·多西《朱庇特、墨丘利与美德》，约 1523',
    radiusSm: 3,
    radius: 6,
    radiusLg: 8,
    serifFamily: 'Palatino Linotype',
    labelSpacing: 1.8,
    mark: MarkKind.plate,
    markText: 'Silentium',
    inscription: 'Jupiter, Mercury and Virtue',
    verticalInscription: false,
    colors: AppColors(
      rail: Color(0xFFE3D9C3),
      sidebar: Color(0xFFECE4D2),
      background: Color(0xFFF7F2E7),
      userBubble: Color(0xFFEADFCB),
      onUserBubble: Color(0xFF29211B),
      card: Color(0xFFFFFDF8),
      border: Color(0x2E29211B),
      ink: Color(0xFF29211B),
      ink2: Color(0xFF41372D),
      muted: Color(0xFF5E5246),
      accent: Color(0xFF9C3328),
      onAccent: Color(0xFFFFF8F0),
      accentSoft: Color(0x1A9C3328),
      ochre: Color(0xFF7C591B),
      seal: Color(0xFF3B728C),
      success: Color(0xFF446940),
      warning: Color(0xFF7C591B),
      danger: Color(0xFF9C3328),
      codeBackground: Color(0xFFEFE7D6),
      terminal: Color(0xFF29211B),
      onTerminal: Color(0xFFECE4D2),
      terminalMuted: Color(0xFFBCAF98),
      terminalError: Color(0xFFE8A091),
      butterfly: ButterflyColors(ground: Color(0xFFECE4D2), line: Color(0xFF29211B), core: Color(0xFFFFFDF8), wing: Color(0xFF9C3328), glow: Color(0xFFD9A441)),
      diffAdded: Color(0x24446940),
      diffRemoved: Color(0x249C3328),
    ),
  );

  /// Jan Davidsz. de Heem's flower still lifes (about 1670): a white
  /// butterfly against near-black.
  static const youhua = PaintingTheme(
    id: 'youhua',
    name: '幽华',
    work: '德·黑姆的花卉静物，约 1670',
    brightness: Brightness.dark,
    radiusSm: 4,
    radius: 8,
    radiusLg: 12,
    serifFamily: 'Constantia',
    mark: MarkKind.glyph,
    inscription: 'Vanitas',
    verticalInscription: false,
    colors: AppColors(
      rail: Color(0xFF0E1012),
      sidebar: Color(0xFF1B1E22),
      background: Color(0xFF131517),
      userBubble: Color(0xFF2A2F35),
      onUserBubble: Color(0xFFEDE7DD),
      card: Color(0xFF21262B),
      border: Color(0x24EDE7DD),
      ink: Color(0xFFEDE7DD),
      ink2: Color(0xFFD5CEC2),
      muted: Color(0xFF9DA4AA),
      accent: Color(0xFFE2676A),
      onAccent: Color(0xFF1A0E0E),
      accentSoft: Color(0x29E2676A),
      ochre: Color(0xFFE0B042),
      seal: Color(0xFFEAF0D0),
      success: Color(0xFF93C08C),
      warning: Color(0xFFE0B042),
      danger: Color(0xFFEF7F76),
      codeBackground: Color(0xFF0E1012),
      terminal: Color(0xFF0B0C0E),
      onTerminal: Color(0xFFE6E1D8),
      terminalMuted: Color(0xFF9DA4AA),
      terminalError: Color(0xFFEF9A8F),
      butterfly: ButterflyColors(ground: Color(0xFF1B1E22), line: Color(0xFFFFFFFF), core: Color(0xFF21262B), wing: Color(0xFFE2676A), glow: Color(0xFFEAF0D0)),
      diffAdded: Color(0x3393C08C),
      diffRemoved: Color(0x33EF7F76),
    ),
  );

  /// Tiffany Studios' leaded-glass butterfly lamps (about 1900).
  static const liuguang = PaintingTheme(
    id: 'liuguang',
    name: '琉光',
    work: '蒂芙尼工作室的蝴蝶台灯，约 1900',
    brightness: Brightness.dark,
    radiusSm: 6,
    radius: 12,
    radiusLg: 16,
    serifFamily: 'Georgia',
    labelSpacing: 1.2,
    mark: MarkKind.glyph,
    inscription: 'Tiffany Studios',
    verticalInscription: false,
    butterflyStroke: 2.2,
    colors: AppColors(
      rail: Color(0xFF12100E),
      sidebar: Color(0xFF201D1A),
      background: Color(0xFF171513),
      userBubble: Color(0xFF332D27),
      onUserBubble: Color(0xFFF2EAE0),
      card: Color(0xFF2A2622),
      border: Color(0x2EF2EAE0),
      ink: Color(0xFFF2EAE0),
      ink2: Color(0xFFD8CFC2),
      muted: Color(0xFFA39B8F),
      accent: Color(0xFFE09F3E),
      onAccent: Color(0xFF1E1608),
      accentSoft: Color(0x29E09F3E),
      ochre: Color(0xFF4FB3B1),
      seal: Color(0xFFE09F3E),
      success: Color(0xFF4FB3B1),
      warning: Color(0xFFE09F3E),
      danger: Color(0xFFE57A6A),
      codeBackground: Color(0xFF12100E),
      terminal: Color(0xFF0E0C0B),
      onTerminal: Color(0xFFEDE5DA),
      terminalMuted: Color(0xFFA39B8F),
      terminalError: Color(0xFFEF9A8F),
      butterfly: ButterflyColors(ground: Color(0xFF201D1A), line: Color(0xFFFFFFFF), core: Color(0xFF2A2622), wing: Color(0xFFE09F3E), glow: Color(0xFFF3D29D)),
      diffAdded: Color(0x334FB3B1),
      diffRemoved: Color(0x33E57A6A),
    ),
  );

  static const all = [jiadie, caodie, yuhua, shensi, moye, youhua, liuguang];

  /// The theme with [id] if it has the right brightness, else that side's default.
  static PaintingTheme byId(String? id, Brightness brightness) {
    final found = all.where((t) => t.id == id && t.brightness == brightness).firstOrNull;
    return found ?? (brightness == Brightness.dark ? moye : jiadie);
  }
}

/// The non-color parts of the active [PaintingTheme], for widgets.
@immutable
class AppStyle extends ThemeExtension<AppStyle> {
  const AppStyle(this.theme);

  final PaintingTheme theme;

  @override
  AppStyle copyWith() => this;

  @override
  AppStyle lerp(ThemeExtension<AppStyle>? other, double t) => t < 0.5 || other is! AppStyle ? this : other;
}

extension AppThemeContext on BuildContext {
  AppColors get colors => Theme.of(this).extension<AppColors>()!;
  TextTheme get text => Theme.of(this).textTheme;
  PaintingTheme get painting => Theme.of(this).extension<AppStyle>()?.theme ?? PaintingTheme.jiadie;

  /// Corner radii of the active theme.
  double get radiusSm => painting.radiusSm;
  double get radius => painting.radius;
  double get radiusLg => painting.radiusLg;

  /// [style] in the theme's heading and reply face (Song for Chinese).
  TextStyle serif(TextStyle? style) =>
      (style ?? const TextStyle()).copyWith(fontFamily: painting.serifFamily, fontFamilyFallback: AppTokens.serifFallback);

  /// A small spaced-out section label (「今天」「步骤」).
  TextStyle? get label => text.labelSmall?.copyWith(color: colors.muted, letterSpacing: painting.labelSpacing);
}

/// The Material theme for [brightness], from [painting] (by default 「蛱蝶」
/// by day and 「墨夜」 by night).
ThemeData buildTheme(Brightness brightness, {PaintingTheme? painting}) {
  final t = painting ?? PaintingTheme.byId(null, brightness);
  final c = t.colors;
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
    extensions: [c, AppStyle(t)],
    visualDensity: VisualDensity.compact,
    dividerColor: c.border,
    scaffoldBackgroundColor: c.background,
    canvasColor: c.background,
    splashFactory: InkSparkle.splashFactory,
  );
  TextStyle? serif(TextStyle? s, {FontWeight weight = FontWeight.w600}) =>
      s?.copyWith(fontFamily: t.serifFamily, fontFamilyFallback: AppTokens.serifFallback, fontWeight: weight, color: c.ink);
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
  final radius = BorderRadius.circular(t.radius);
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
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(t.radiusLg)),
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
      decoration: BoxDecoration(color: c.ink.withValues(alpha: 0.92), borderRadius: BorderRadius.circular(t.radiusSm)),
      textStyle: TextStyle(color: c.background, fontSize: 12),
    ),
    // Notices follow the theme (a light bar on light themes), quiet and small (v0.3.1 test 1).
    snackBarTheme: SnackBarThemeData(
      backgroundColor: c.card,
      contentTextStyle: TextStyle(color: c.ink, fontSize: 13),
      actionTextColor: c.accent,
      elevation: 2,
      shape: RoundedRectangleBorder(borderRadius: radius, side: BorderSide(color: c.border)),
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

/// The colors of the butterfly mark in one theme (docs/design/brand.md, section 二.2).
@immutable
class ButterflyColors {
  const ButterflyColors({required this.ground, required this.line, required this.core, required this.wing, required this.glow});

  /// The rounded square behind it in the app icon; the window draws the butterfly alone.
  final Color ground;

  /// Outlines and antennae: dark on light themes, white on dark ones.
  final Color line;

  /// The light cores of the wings.
  final Color core;

  /// The bands of the wings.
  final Color wing;

  /// The light end of the gradients on the right wings.
  final Color glow;

  /// [wing] mixed into [glow] by [t] (0 = wing).
  Color mix(double t) => Color.lerp(wing, glow, t)!;
}

/// The butterfly mark: the user's butterfly, traced 1:1 (butterfly_art.dart),
/// in the colors of the current theme.
class ButterflyMark extends StatelessWidget {
  const ButterflyMark({super.key, this.size = 36, this.semanticLabel, this.colors});

  /// Width; the height is three quarters of it.
  final double size;
  final String? semanticLabel;

  /// Defaults to the current theme's.
  final ButterflyColors? colors;

  @override
  Widget build(BuildContext context) {
    final painter = CustomPaint(
      size: Size(size, size * 0.75),
      painter: ButterflyPainter(colors ?? context.colors.butterfly, stroke: context.painting.butterflyStroke),
    );
    return semanticLabel == null ? ExcludeSemantics(child: painter) : Semantics(label: semanticLabel, image: true, child: painter);
  }
}

/// Paints the butterfly centred in its size, keeping its proportions.
class ButterflyPainter extends CustomPainter {
  ButterflyPainter(this.colors, {this.stroke = 1, this.solid});

  final ButterflyColors colors;

  /// Line weight relative to the original (leaded glass draws it heavier).
  final double stroke;

  /// Paint everything in this one color (the glyph).
  final Color? solid;

  static final _bands = [for (final p in butterflyBands) (p, butterflyPath(p.data))];
  static final _cores = [for (final p in butterflyCores) (p, butterflyPath(p.data))];
  static final _antennae = butterflyPath(butterflyAntennae);
  static final _outline = butterflyPath(butterflyOutline);

  /// Width of the original's lines in the 1024 grid.
  static const lineWidth = 24.0;

  /// Lines are never drawn thinner than this many logical pixels: below about
  /// 40 px wide the original line would turn into a grey hair (optical
  /// thickening for small sizes only; larger marks are exactly the trace).
  static const minLine = 1.2;

  /// Maps the 1024 grid onto [size], centred; returns the scale.
  static double fit(Canvas canvas, Size size) {
    const box = butterflyBox;
    final scale = math.min(size.width / box.width, size.height / box.height);
    canvas.translate((size.width - box.width * scale) / 2, (size.height - box.height * scale) / 2);
    canvas.scale(scale);
    canvas.translate(-box.left, -box.top);
    return scale;
  }

  Paint _fill(ButterflyPiece piece, Color flat) {
    final g = piece.gradient;
    if (solid != null || g == null) return Paint()..color = solid ?? flat;
    return Paint()
      ..shader = ui.Gradient.linear(g.from, g.to, [for (final s in g.stops) colors.mix(s.$2)], [for (final s in g.stops) s.$1]);
  }

  @override
  void paint(Canvas canvas, Size size) {
    canvas.save();
    final scale = fit(canvas, size);
    for (final (piece, path) in _bands) {
      canvas.drawPath(path, _fill(piece, colors.wing));
    }
    if (solid == null) {
      for (final (piece, path) in _cores) {
        canvas.drawPath(path, _fill(piece, colors.core));
      }
    }
    final line = Paint()..color = solid ?? colors.line;
    canvas.drawPath(_antennae, line);
    canvas.drawPath(_outline, line);
    // Heavier lines (leaded glass) or a small mark: widen the filled line shapes on both sides.
    final extra = math.max((stroke - 1) * 10, minLine / scale - lineWidth);
    if (extra > 0) {
      final widen = Paint()
        ..color = line.color
        ..style = PaintingStyle.stroke
        ..strokeJoin = StrokeJoin.round
        ..strokeWidth = extra;
      canvas.drawPath(_antennae, widen);
      canvas.drawPath(_outline, widen);
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(ButterflyPainter old) =>
      old.colors.line != colors.line || old.colors.core != colors.core || old.colors.wing != colors.wing || old.colors.glow != colors.glow || old.stroke != stroke || old.solid != solid;
}

/// The butterfly as a solid one-color silhouette, for buttons and small icons.
class ButterflyGlyph extends StatelessWidget {
  const ButterflyGlyph({super.key, this.size = 18, this.color});

  final double size;

  /// Defaults to the surrounding icon color.
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final color = this.color ?? IconTheme.of(context).color ?? context.colors.ink;
    return ExcludeSemantics(
      child: CustomPaint(size: Size(size, size * 0.75), painter: ButterflyPainter(context.colors.butterfly, solid: color)),
    );
  }
}

/// The cinnabar 「梦蝶」 seal.
class SealStamp extends StatelessWidget {
  const SealStamp({super.key, this.size = 34});

  final double size;

  @override
  Widget build(BuildContext context) {
    final seal = context.colors.seal;
    final chars = context.painting.markText.characters.toList();
    final style = TextStyle(
      fontFamily: AppTokens.serifFamily,
      fontFamilyFallback: AppTokens.serifFallback,
      fontWeight: FontWeight.w700,
      fontSize: size * 0.34,
      height: 1,
      color: seal,
    );
    return Semantics(
      label: '朱印：${chars.join()}',
      image: true,
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(border: Border.all(color: seal, width: 1.5), borderRadius: BorderRadius.circular(3)),
        // Read right to left, top to bottom: 梦蝶.
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceEvenly,
          children: [
            for (final c in chars.reversed) ExcludeSemantics(child: Text(c, style: style)),
          ],
        ),
      ),
    );
  }
}

/// The theme's mark: the 「梦蝶」 seal, a plate label, or a small butterfly.
class ThemeMark extends StatelessWidget {
  const ThemeMark({super.key, this.size = 34});

  final double size;

  @override
  Widget build(BuildContext context) {
    final theme = context.painting;
    final colors = context.colors;
    return switch (theme.mark) {
      MarkKind.seal => SealStamp(size: size),
      MarkKind.plate => Semantics(
        label: theme.markText,
        child: Container(
          padding: const EdgeInsets.only(bottom: 2),
          decoration: BoxDecoration(border: Border(bottom: BorderSide(color: colors.muted.withValues(alpha: 0.6), width: 0.6))),
          child: Text(
            theme.markText,
            style: context.serif(TextStyle(fontSize: size * 0.38, fontStyle: FontStyle.italic, color: colors.muted, height: 1)),
          ),
        ),
      ),
      MarkKind.glyph => ButterflyGlyph(size: size * 0.8, color: colors.seal),
    };
  }
}
