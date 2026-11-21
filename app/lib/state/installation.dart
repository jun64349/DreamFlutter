import 'dart:convert';
import 'dart:io';
import 'package:flutter/services.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

/// The install pointer contains only a directory, never preferences or secrets.
class Installation {
  static const _windowsLocation = MethodChannel('dreamflutter/install_location');
  static String? _selectedDataRoot;

  static File get pointer => File(p.join(CoreLocator.legacyDataDir(), 'installation.json'));
  static String dataRoot() {
    if (_selectedDataRoot != null) return _selectedDataRoot!;
    final explicit = Platform.environment['DREAMFLUTTER_DATA'];
    if (explicit != null && explicit.isNotEmpty) return explicit;
    try { final root = (jsonDecode(pointer.readAsStringSync()) as Map)['dataRoot']; if (root is String && p.isAbsolute(root)) return root; } catch (_) {}
    // Never the pre-0.3.2 %APPDATA%\DreamFlutter data (user 2026-11-18): a new install starts at the wizard.
    return CoreLocator.defaultDataDir();
  }
  static bool hasData(String root) => [
    'core.db', 'storage-locations.json', p.join('application-data','database','core.db'), p.join('window','prefs.json'), 'pi',
  ].any((name) => FileSystemEntity.typeSync(p.join(root,name)) != FileSystemEntityType.notFound);
  static Future<void> remember(String root) async {
    if (!p.isAbsolute(root)) throw ArgumentError('请选择完整的文件夹路径');
    if (Platform.isWindows) {
      try {
        if (await _windowsLocation.invokeMethod<bool>('remember', root) != true) {
          throw FileSystemException('无法保存数据位置', root);
        }
        _selectedDataRoot = root;
        return;
      } on MissingPluginException {
        // Development runs without a Velopack installation keep the old pointer.
      }
    }
    // Commit before launching the core. An interrupted wizard resumes at this root.
    await pointer.parent.create(recursive:true);
    final next = File('${pointer.path}.next');
    await next.writeAsString(jsonEncode({'dataRoot':root}),flush:true);
    await next.rename(pointer.path);
  }
  static Future<int?> freeBytes(String path) async {
    if (Platform.isWindows) {
      final root = p.rootPrefix(p.absolute(path)).replaceAll("'", "''");
      final result = await Process.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "([System.IO.DriveInfo]::new('$root')).AvailableFreeSpace"]);
      return result.exitCode == 0 ? int.tryParse('${result.stdout}'.trim()) : null;
    }
    if (Platform.isMacOS) {
      var probe = Directory(p.absolute(path));
      while (!probe.existsSync()) {
        final parent = probe.parent;
        if (parent.path == probe.path) break;
        probe = parent;
      }
      if (!probe.existsSync()) return null;
      final result = await Process.run('df', ['-k', probe.path]);
      if (result.exitCode != 0) return null;
      final lines = '${result.stdout}'.trim().split('\n');
      if (lines.length < 2) return null;
      final cols = lines.last.trim().split(RegExp(r'\s+'));
      if (cols.length < 4) return null;
      final availKb = int.tryParse(cols[3]);
      return availKb != null ? availKb * 1024 : null;
    }
    return null;
  }
}
