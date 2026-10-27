import 'dart:io';

import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:shared_preferences/shared_preferences.dart';

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

  /// Model used for new sessions until the user picks another one.
  static const defaultModelKey = 'cc-switch-deep-seek/deepseek-flash';
  static const maxRecentWorkspaces = 10;
  static const textScales = [0.9, 1.0, 1.1, 1.25];

  static String defaultWorkspace() {
    final home = Platform.environment['USERPROFILE'] ?? Platform.environment['HOME'] ?? Directory.current.path;
    return p.join(home, 'DreamFlutter');
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

  double get textScale => _prefs.getDouble('textScale') ?? 1.0;
  Future<void> setTextScale(double value) => _prefs.setDouble('textScale', value);
}
