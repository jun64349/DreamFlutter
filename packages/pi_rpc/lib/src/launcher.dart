/// Locates the pieces needed to start Pi on this machine.
library;

import 'dart:io';

import 'package:path/path.dart' as p;

import 'client.dart';

class PiRuntimeLocator {
  /// Relative location of the Pi CLI inside the pinned `runtime/` folder.
  static const cliRelativePath = 'runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';

  /// `DREAMFLUTTER_PI_CLI`, else the first `runtime/...cli.js` found walking up
  /// from each of [searchRoots] (e.g. the executable's folder and the cwd).
  static String? findCli(List<String> searchRoots) {
    final override = Platform.environment['DREAMFLUTTER_PI_CLI'];
    if (override != null && File(override).existsSync()) return override;
    for (final root in searchRoots) {
      var dir = p.normalize(p.absolute(root));
      for (var depth = 0; depth < 8; depth++) {
        final candidate = p.join(dir, cliRelativePath);
        if (File(candidate).existsSync()) return candidate;
        final parent = p.dirname(dir);
        if (parent == dir) break;
        dir = parent;
      }
    }
    return null;
  }

  /// Full path of an executable on PATH, or null.
  static String? findOnPath(String name) {
    final exts = Platform.isWindows ? ['.exe', '.cmd', '.bat', ''] : [''];
    for (final dir in _pathEntries()) {
      for (final ext in exts) {
        final candidate = p.join(dir, '$name$ext');
        if (File(candidate).existsSync()) return candidate;
      }
    }
    return null;
  }

  /// Folder of a Git Bash `bash.exe` that Pi should use on Windows, when Pi's
  /// own lookup could pick the wrong one.
  ///
  /// Pi checks `%ProgramFiles%\Git\bin\bash.exe` and then `bash.exe` on PATH.
  /// Without a standard Git install, PATH may resolve to
  /// `C:\Windows\System32\bash.exe` (the WSL launcher), because the system
  /// PATH precedes the user PATH for apps started from Explorer. We find the
  /// bash that belongs to a `git.exe` on PATH and put its folder first.
  static String? findGitBashDir() {
    if (!Platform.isWindows) return null;
    for (final base in [Platform.environment['ProgramFiles'], Platform.environment['ProgramFiles(x86)']]) {
      if (base != null && File(p.join(base, 'Git', 'bin', 'bash.exe')).existsSync()) return null;
    }
    for (final dir in _pathEntries()) {
      if (!File(p.join(dir, 'git.exe')).existsSync()) continue;
      final gitRoot = p.dirname(dir); // git.exe lives in <root>\cmd or <root>\bin
      for (final sub in ['bin', p.join('usr', 'bin')]) {
        if (File(p.join(gitRoot, sub, 'bash.exe')).existsSync()) return p.join(gitRoot, sub);
      }
    }
    return null;
  }

  /// Environment overrides for the Pi child process.
  static Map<String, String> environment() {
    final bashDir = findGitBashDir();
    if (bashDir == null) return const {};
    final pathKey = Platform.environment.keys.firstWhere((k) => k.toUpperCase() == 'PATH', orElse: () => 'PATH');
    return {pathKey: '$bashDir${Platform.isWindows ? ';' : ':'}${Platform.environment[pathKey] ?? ''}'};
  }

  /// A ready-to-use launch config, or null when Node or the Pi CLI is missing.
  static PiLaunchConfig? defaultConfig({
    required String workingDirectory,
    required List<String> searchRoots,
    List<String> extraArgs = const [],
  }) {
    final cli = findCli(searchRoots);
    final node = findOnPath('node');
    if (cli == null || node == null) return null;
    return PiLaunchConfig(
      cliPath: cli,
      nodeExecutable: node,
      workingDirectory: workingDirectory,
      extraArgs: extraArgs,
      environment: environment(),
    );
  }

  static Iterable<String> _pathEntries() {
    final raw = Platform.environment.entries
        .firstWhere((e) => e.key.toUpperCase() == 'PATH', orElse: () => const MapEntry('PATH', ''))
        .value;
    return raw.split(Platform.isWindows ? ';' : ':').where((e) => e.trim().isNotEmpty);
  }
}
