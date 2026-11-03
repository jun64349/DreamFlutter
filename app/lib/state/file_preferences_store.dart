import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:shared_preferences_platform_interface/shared_preferences_platform_interface.dart';
import 'package:shared_preferences_platform_interface/types.dart';

/// The window's preferences as a JSON file in the app's data folder
/// (`data\window\prefs.json`, v0.3.2) instead of the plugin's file under
/// %APPDATA%. Same format as shared_preferences_windows, so the old file is
/// taken over as it is on first use.
class FilePreferencesStore extends InMemorySharedPreferencesStore {
  FilePreferencesStore._(this.file, super.data) : super.withData();

  final File file;

  static Future<FilePreferencesStore> open(String path, {String? legacy}) async {
    final file = File(path);
    var source = file;
    if (!file.existsSync() && legacy != null && File(legacy).existsSync()) source = File(legacy);
    final data = <String, Object>{};
    try {
      final decoded = jsonDecode(await source.readAsString());
      if (decoded is Map) {
        for (final MapEntry(:key, :value) in decoded.entries) {
          if (value == null) continue;
          data['$key'] = value is List ? value.map((e) => '$e').toList() : value as Object;
        }
      }
    } catch (_) {
      // No file yet, or an unreadable one: start empty.
    }
    final store = FilePreferencesStore._(file, data);
    if (!identical(source, file)) await store._save();
    return store;
  }

  /// Writes one after another (two quick changes would race on the temporary file).
  Future<void> _writing = Future.value();

  Future<void> _save() => _writing = _writing.then((_) => _write()).catchError((Object _) {});

  Future<void> _write() async {
    final all = await getAllWithParameters(GetAllParameters(filter: PreferencesFilter(prefix: '')));
    await file.parent.create(recursive: true);
    final temp = File(p.join(file.parent.path, '${p.basename(file.path)}.tmp'));
    await temp.writeAsString(const JsonEncoder.withIndent('  ').convert(all));
    await temp.rename(file.path);
  }

  @override
  Future<bool> setValue(String valueType, String key, Object value) async {
    await super.setValue(valueType, key, value);
    await _save();
    return true;
  }

  @override
  Future<bool> remove(String key) async {
    await super.remove(key);
    await _save();
    return true;
  }

  @override
  Future<bool> clearWithParameters(ClearParameters parameters) async {
    await super.clearWithParameters(parameters);
    await _save();
    return true;
  }
}
