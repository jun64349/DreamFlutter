import 'dart:io';

import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:shared_preferences/shared_preferences.dart';
import 'garden_deletions.dart';

/// When the approval extension asks before a tool call.
enum ApprovalMode {
  /// Never ask.
  off('off', '全部放行', '工具调用直接执行，不再询问。'),

  /// Ask before anything that can change files or run commands.
  changes('changes', '修改和命令需确认', '读取、搜索类操作直接执行；写文件、改文件、执行命令前先问你。'),

  /// Ask before every tool call.
  all('all', '全部需确认', '每一次工具调用都先问你。');

  const ApprovalMode(this.id, this.label, this.description);
  final String id;
  final String label;
  final String description;

  static ApprovalMode parse(String? id) => values.firstWhere((m) => m.id == id, orElse: () => changes);
}

/// User choices remembered between launches.
class Preferences {
  Preferences(this._prefs);

  static Future<Preferences> load() async => Preferences(await SharedPreferences.getInstance());

  final SharedPreferences _prefs;

  String? get closeBehaviorChoice => _prefs.getString('closeBehaviorChoice');
  Future<void> setCloseBehaviorChoice(String value) =>
      _prefs.setString('closeBehaviorChoice', value);

  /// Model used for new sessions until the user picks another one.
  static const defaultModelKey = 'cc-switch-deep-seek/deepseek-flash';
  static const maxRecentWorkspaces = 10;
  // Stored values remain physical scales; relabelling does not enlarge an
  // existing user's choice a second time.
  static const defaultTextScale = 1.25;
  static const defaultZoom = 1.1;
  static const textScales = [1.125, 1.1875, 1.25, 1.375, 1.5625];

  static String defaultWorkspace() {
    final home = Platform.environment['USERPROFILE'] ?? Platform.environment['HOME'] ?? Directory.current.path;
    return p.join(home, 'DreamFlutter');
  }

  // --- Backup --------------------------------------------------------------

  /// Everything remembered here, for a backup package (the core stores it as prefs.json).
  /// Doubles are tagged: through JSON in Node, 1.0 would come back as the int 1.
  Map<String, Object?> exportAll() => {
    for (final key in _prefs.getKeys()) if (key != GardenDeletions.preferenceKey)
      key: switch (_prefs.get(key)) {
        final double v => {'double': v},
        final v => v,
      },
  };

  /// Puts a restored backup's preferences back (paths already moved to this machine by the core).
  Future<bool> importAll(Map<String, Object?> values) async {
    var saved = true;
    for (final MapEntry(:key, :value) in values.entries) {
      if (key == GardenDeletions.preferenceKey) continue;
      switch (value) {
        case final bool v:
          saved &= await _prefs.setBool(key, v);
        case final int v:
          saved &= await _prefs.setInt(key, v);
        case {'double': final num v}:
          saved &= await _prefs.setDouble(key, v.toDouble());
        case final String v:
          saved &= await _prefs.setString(key, v);
        case final List<Object?> v when v.every((e) => e is String):
          saved &= await _prefs.setStringList(key, v.cast<String>());
        default:
          break;
      }
    }
    return saved;
  }

  // --- Workspace -----------------------------------------------------------

  String? get workspace => _prefs.getString('workspace');
  Future<void> setWorkspace(String value) async {
    await _prefs.setString('workspace', value);
    final recent = [value, ...recentWorkspaces.where((w) => p.normalize(w).toLowerCase() != p.normalize(value).toLowerCase())];
    await _prefs.setStringList('recentWorkspaces', recent.take(maxRecentWorkspaces).toList());
  }

  List<String> get recentWorkspaces => _prefs.getStringList('recentWorkspaces') ?? const [];
  Future<void> removeRecentWorkspace(String value) => _prefs.setStringList(
    'recentWorkspaces',
    recentWorkspaces.where((w) => p.normalize(w).toLowerCase() != p.normalize(value).toLowerCase()).toList(),
  );

  // --- Settings now owned by the core -----------------------------------------
  //
  // v0.1.0 kept these in the window; they are read once to seed the core's
  // settings (see AgentController._migratePreferences).

  String get modelKey => _prefs.getString('modelKey') ?? defaultModelKey;
  String? get thinkingLevel => _prefs.getString('thinkingLevel');
  ApprovalMode get approvalMode => ApprovalMode.parse(_prefs.getString('approvalMode'));
  bool get autoCompaction => _prefs.getBool('autoCompaction') ?? true;

  bool get migratedToCore => _prefs.getBool('migratedToCore') ?? false;
  Future<void> setMigratedToCore() => _prefs.setBool('migratedToCore', true);

  /// The one-time "still running in the tray" notice was shown.
  bool get trayHintShown => _prefs.getBool('trayHintShown') ?? false;
  Future<void> setTrayHintShown() => _prefs.setBool('trayHintShown', true);

  // --- Appearance ----------------------------------------------------------

  ThemeMode get themeMode => switch (_prefs.getString('themeMode')) {
    'light' => ThemeMode.light,
    'dark' => ThemeMode.dark,
    _ => ThemeMode.system,
  };
  Future<void> setThemeMode(ThemeMode mode) => _prefs.setString('themeMode', mode.name);

  /// The painting themes for daytime and night (ids from PaintingTheme).
  String? get lightTheme => _prefs.getString('lightTheme');
  Future<void> setLightTheme(String id) => _prefs.setString('lightTheme', id);
  String? get darkTheme => _prefs.getString('darkTheme');
  Future<void> setDarkTheme(String id) => _prefs.setString('darkTheme', id);

  String get paperTexture => _prefs.getString('paperTexture') ?? 'cotton';
  Future<void> setPaperTexture(String value) => _prefs.setString('paperTexture', value);
  double get paperStrength => _prefs.getDouble('paperStrength') ?? .10;
  Future<void> setPaperStrength(double value) => _prefs.setDouble('paperStrength', value);
  bool get decorativeMotion => _prefs.getBool('decorativeMotion') ?? true;
  Future<void> setDecorativeMotion(bool value) => _prefs.setBool('decorativeMotion', value);

  double get textScale => _prefs.getDouble('textScale') ?? defaultTextScale;
  Future<void> setTextScale(double value) => _prefs.setDouble('textScale', value);

  /// Whole-interface zoom steps (Ctrl + plus / minus), like a browser's.
  static const zoomLevels = [0.737, 0.825, 0.88, 0.99, 1.1, 1.21, 1.375, 1.65, 1.925, 2.2];

  double get zoom => _prefs.getDouble('zoom') ?? defaultZoom;
  Future<void> setZoom(double value) => _prefs.setDouble('zoom', value);

  /// The first-run guide was dismissed.
  bool get onboarded => _prefs.getBool('onboarded') ?? false;
  Future<void> setOnboarded() => _prefs.setBool('onboarded', true);

  /// The details panel is open over the conversation. Closed until asked for (0.4: it slides
  /// over the conversation now; the old side column's 'runPanelOpen' is not carried over).
  bool get runPanelOpen => _prefs.getBool('detailsOpen') ?? false;
  Future<void> setRunPanelOpen(bool value) => _prefs.setBool('detailsOpen', value);

  /// Widths the user dragged the sidebar and the details panel to (0.4, extra test 8).
  static const sidebarWidths = (min: 232.0, initial: 264.0, max: 420.0);
  static const panelWidths = (min: 280.0, initial: 312.0, max: 560.0);

  double get sidebarWidth => (_prefs.getDouble('sidebarWidth') ?? sidebarWidths.initial).clamp(sidebarWidths.min, sidebarWidths.max);
  Future<void> setSidebarWidth(double value) => _prefs.setDouble('sidebarWidth', value);
  double get panelWidth => (_prefs.getDouble('panelWidth') ?? panelWidths.initial).clamp(panelWidths.min, panelWidths.max);
  Future<void> setPanelWidth(double value) => _prefs.setDouble('panelWidth', value);

  /// 「入门 5 课」progress (state/onboarding.dart, route step 4).
  ({int lesson, int step, bool closed, bool waitingForReport}) get tour => (
    lesson: _prefs.getInt('tour.lesson') ?? 0,
    step: _prefs.getInt('tour.step') ?? 0,
    closed: _prefs.getBool('tour.closed') ?? false,
    waitingForReport: _prefs.getBool('tour.waitingForReport') ?? false,
  );
  Future<void> setTour({required int lesson, required int step, required bool closed, required bool waitingForReport}) async {
    await _prefs.setInt('tour.lesson', lesson);
    await _prefs.setInt('tour.step', step);
    await _prefs.setBool('tour.closed', closed);
    await _prefs.setBool('tour.waitingForReport', waitingForReport);
  }
}
