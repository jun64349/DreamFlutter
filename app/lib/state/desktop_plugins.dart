import 'package:flutter/foundation.dart';
import 'package:pi_rpc/pi_rpc.dart';

import 'backend.dart';

class DesktopPlugin {
  DesktopPlugin.fromJson(Json row)
    : id = row['id'] as String,
      title = row['title'] as String,
      description = row['description'] as String,
      version = row['version'] as String,
      system = row['kind'] == 'system',
      installed = row['installed'] == true,
      enabled = row['enabled'] == true,
      active = row['active'] == true,
      restartRequired = row['restartRequired'] == true;

  final String id, title, description, version;
  final bool system, installed, enabled, active, restartRequired;
}

class DesktopPlugins extends ChangeNotifier {
  DesktopPlugins(this._backend);
  final AgentBackend _backend;
  List<DesktopPlugin> entries = const [];
  List<Json> _bindings = const [];
  Object? loadError;
  bool loaded = false;
  bool _disposed = false;
  int _generation = 0;

  bool active(String id, {bool fallback = false}) =>
      entries.where((entry) => entry.id == id).firstOrNull?.active ?? fallback;

  bool opensSpending(
    String code, {
    required bool control,
    required bool shift,
  }) => _bindings.any(
    (item) =>
        item['command'] == 'spending.open' &&
        item['key'] == code &&
        (item['control'] == true) == control &&
        (item['shift'] == true) == shift,
  );

  Future<void> refresh({bool reconnect = false}) async {
    final generation = ++_generation;
    if (reconnect) {
      entries = const [];
      _bindings = const [];
      loaded = false;
    }
    try {
      final response = asJsonMap(await _backend.call('plugins.list'));
      final rows = response['plugins'];
      if (rows is! List) throw const FormatException('后台未提供插件目录');
      final next = rows
          .map((row) => DesktopPlugin.fromJson(asJsonMap(row)))
          .toList();
      if (_disposed || generation != _generation) return;
      entries = next;
      _bindings = const [];
      loaded = true;
      loadError = null;
      if (active('window-shortcuts')) {
        final shortcuts = asJsonMap(await _backend.call('plugins.shortcuts'));
        if (_disposed || generation != _generation) return;
        _bindings = (shortcuts['bindings'] as List).map(asJsonMap).toList();
      }
    } catch (error) {
      if (_disposed || generation != _generation) return;
      _bindings = const [];
      loadError = error;
    }
    notifyListeners();
  }

  Future<void> change(DesktopPlugin plugin, String action) async {
    await _backend.call('plugins.$action', {'id': plugin.id});
    if (!_disposed) await refresh();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
