import 'package:flutter/material.dart';

/// Every visual decision lives here (colors, type, radii, spacing), so the
/// planned visual-design pass can restyle the whole app from one file.
class AppTokens {
  static const seed = Color(0xFF3B6FD8);

  static const radiusSm = 6.0;
  static const radius = 10.0;
  static const radiusLg = 14.0;

  static const gap = 8.0;
  static const pad = 12.0;
  static const padLg = 16.0;

  static const sidebarWidth = 248.0;
  static const contentMaxWidth = 860.0;

  static const fontFamily = 'Microsoft YaHei UI';
  static const fontFallback = ['Segoe UI', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC'];
  static const monoFamily = 'Cascadia Mono';
  static const monoFallback = ['Consolas', 'Courier New', 'monospace'];
}

/// Semantic colors not covered by [ColorScheme].
@immutable
class AppColors extends ThemeExtension<AppColors> {
  const AppColors({
    required this.sidebar,
    required this.userBubble,
    required this.onUserBubble,
    required this.card,
    required this.border,
    required this.muted,
    required this.success,
    required this.warning,
    required this.danger,
    required this.codeBackground,
  });

  final Color sidebar;
  final Color userBubble;
  final Color onUserBubble;
  final Color card;
  final Color border;
  final Color muted;
  final Color success;
  final Color warning;
  final Color danger;
  final Color codeBackground;

  static const light = AppColors(
    sidebar: Color(0xFFF4F4F2),
    userBubble: Color(0xFFE6EEFC),
    onUserBubble: Color(0xFF1C3A73),
    card: Color(0xFFFFFFFF),
    border: Color(0x1F000000),
    muted: Color(0xFF75736E),
    success: Color(0xFF2E7D4F),
    warning: Color(0xFFB26B00),
    danger: Color(0xFFC0392B),
    codeBackground: Color(0xFFF3F3F1),
  );

  static const dark = AppColors(
    sidebar: Color(0xFF1E1E1D),
    userBubble: Color(0xFF243553),
    onUserBubble: Color(0xFFD7E3FA),
    card: Color(0xFF262625),
    border: Color(0x24FFFFFF),
    muted: Color(0xFF9C9A93),
    success: Color(0xFF6CC48F),
    warning: Color(0xFFE5A94A),
    danger: Color(0xFFEF7B6E),
    codeBackground: Color(0xFF1B1B1A),
  );

  @override
  AppColors copyWith() => this;

  @override
  AppColors lerp(ThemeExtension<AppColors>? other, double t) => t < 0.5 || other is! AppColors ? this : other;
}

extension AppThemeContext on BuildContext {
  AppColors get colors => Theme.of(this).extension<AppColors>()!;
  TextTheme get text => Theme.of(this).textTheme;
}

ThemeData buildTheme(Brightness brightness) {
  final isDark = brightness == Brightness.dark;
  final scheme = ColorScheme.fromSeed(
    seedColor: AppTokens.seed,
    brightness: brightness,
    surface: isDark ? const Color(0xFF191918) : const Color(0xFFFCFCFB),
  );
  final colors = isDark ? AppColors.dark : AppColors.light;
  final base = ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    fontFamily: AppTokens.fontFamily,
    fontFamilyFallback: AppTokens.fontFallback,
    extensions: [colors],
    visualDensity: VisualDensity.compact,
    dividerColor: colors.border,
  );
  final border = OutlineInputBorder(
    borderRadius: BorderRadius.circular(AppTokens.radiusLg),
    borderSide: BorderSide(color: colors.border),
  );
  return base.copyWith(
    scaffoldBackgroundColor: scheme.surface,
    dividerTheme: DividerThemeData(color: colors.border, thickness: 0.5, space: 0.5),
    inputDecorationTheme: InputDecorationTheme(
      border: border,
      enabledBorder: border,
      focusedBorder: border.copyWith(borderSide: BorderSide(color: scheme.primary)),
      contentPadding: const EdgeInsets.symmetric(horizontal: AppTokens.pad, vertical: 10),
      isDense: true,
    ),
    tooltipTheme: const TooltipThemeData(waitDuration: Duration(milliseconds: 500)),
  );
}
