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
    return chooseRoot(CoreLocator.defaultDataDir(), CoreLocator.legacyDataDir());
  }
  /// The software's own data folder first; the pre-0.3.2 %APPDATA%\DreamFlutter only when it still
  /// holds data that was never moved. The backup module leaves 「已搬到新位置.txt」 (MOVED_MARKER in
  /// core/src/backup/backup.ts) in it after moving, and its leftover core.db must not be reopened:
  /// a fresh package would otherwise start on years-old data instead of the first-run wizard.
  static String chooseRoot(String standard, String legacy) {
    if (hasData(standard)) return standard;
    return hasData(legacy) && !File(p.join(legacy, movedMarker)).existsSync() ? legacy : standard;
  }
  static const movedMarker = '已搬到新位置.txt';
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
