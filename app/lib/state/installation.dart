import 'dart:convert';
import 'dart:io';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

/// The install pointer contains only a directory, never preferences or secrets.
class Installation {
  static File get pointer => File(p.join(CoreLocator.legacyDataDir(), 'installation.json'));
  static String dataRoot() {
    final explicit = Platform.environment['DREAMFLUTTER_DATA'];
    if (explicit != null && explicit.isNotEmpty) return explicit;
    try { final root = (jsonDecode(pointer.readAsStringSync()) as Map)['dataRoot']; if (root is String && p.isAbsolute(root)) return root; } catch (_) {}
    final standard = CoreLocator.defaultDataDir();
    if (hasData(standard)) return standard;
    final legacy = CoreLocator.legacyDataDir();
    return hasData(legacy) ? legacy : standard;
  }
  static bool hasData(String root) => [
    'core.db', 'storage-locations.json', p.join('application-data','database','core.db'), p.join('window','prefs.json'), 'pi',
  ].any((name) => FileSystemEntity.typeSync(p.join(root,name)) != FileSystemEntityType.notFound);
  static Future<void> remember(String root) async {
    if (!p.isAbsolute(root)) throw ArgumentError('请选择完整的文件夹路径');
    // Commit before launching the core. An interrupted wizard resumes at this root.
    await pointer.parent.create(recursive:true);
    final next = File('${pointer.path}.next');
    await next.writeAsString(jsonEncode({'dataRoot':root}),flush:true);
    await next.rename(pointer.path);
  }
  static Future<int?> freeBytes(String path) async {
    if (!Platform.isWindows) return null;
    final root = p.rootPrefix(p.absolute(path)).replaceAll("'", "''");
    final result = await Process.run('powershell.exe',['-NoProfile','-NonInteractive','-Command',"([System.IO.DriveInfo]::new('$root')).AvailableFreeSpace"]);
    return result.exitCode == 0 ? int.tryParse('${result.stdout}'.trim()) : null;
  }
}
