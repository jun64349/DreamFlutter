import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

/// The user's answer to "trust this workspace's Pi configuration?".
enum TrustChoice {
  trustRemember('信任并记住'),
  trustOnce('仅这次信任'),
  distrustOnce('这次不信任'),
  distrustRemember('不信任并记住');

  const TrustChoice(this.label);
  final String label;

  bool get trusted => this == trustRemember || this == trustOnce;
  bool get remember => this == trustRemember || this == distrustRemember;
}

/// Pi's project trust, decided by the GUI.
///
/// RPC mode cannot show Pi's trust prompt (extensions have no UI channel that
/// early), so without a decision Pi silently skips a workspace's own settings,
/// skills and extensions. The GUI therefore checks the same rules as Pi
/// (`core/trust-manager.js`) before launching and passes `--approve` or
/// `--no-approve`. Remembered answers go to Pi's own `trust.json`, so the
/// terminal version of Pi honors them too.
class ProjectTrust {
  ProjectTrust({String? agentDir}) : agentDir = agentDir ?? SessionStore.defaultAgentDir();

  final String agentDir;

  static const _protectedConfigEntries = [
    'settings.json',
    'mcp.json',
    'extensions',
    'skills',
    'prompts',
    'themes',
    'SYSTEM.md',
    'APPEND_SYSTEM.md',
  ];

  String get trustFile => p.join(agentDir, 'trust.json');

  /// True when [cwd] has project resources that Pi only loads when trusted.
  static bool requiresTrust(String cwd) {
    final home = Platform.environment['USERPROFILE'] ?? Platform.environment['HOME'] ?? '';
    final userSkills = p.normalize(p.join(home, '.agents', 'skills')).toLowerCase();
    var dir = p.normalize(p.absolute(cwd));
    if (_protectedConfigEntries.any((e) => FileSystemEntity.typeSync(p.join(dir, '.pi', e)) != FileSystemEntityType.notFound)) {
      return true;
    }
    while (true) {
      final skills = p.join(dir, '.agents', 'skills');
      if (p.normalize(skills).toLowerCase() != userSkills && Directory(skills).existsSync()) return true;
      final parent = p.dirname(dir);
      if (parent == dir) return false;
      dir = parent;
    }
  }

  /// The nearest saved decision for [cwd] or an ancestor in Pi's trust.json.
  bool? savedDecision(String cwd) {
    final data = _read();
    var dir = p.normalize(p.absolute(cwd));
    while (true) {
      for (final entry in data.entries) {
        if (_same(entry.key, dir) && entry.value is bool) return entry.value as bool;
      }
      final parent = p.dirname(dir);
      if (parent == dir) return null;
      dir = parent;
    }
  }

  /// Saves a decision the same way Pi's `/trust` does.
  void remember(String cwd, bool trusted) {
    final data = _read()..removeWhere((key, _) => _same(key, cwd));
    data[p.normalize(p.absolute(cwd))] = trusted;
    final file = File(trustFile);
    file.parent.createSync(recursive: true);
    file.writeAsStringSync(const JsonEncoder.withIndent('  ').convert(data));
  }

  /// CLI arguments for launching Pi in [cwd]: asks through [prompt] when a
  /// decision is needed and none is saved. Returns no arguments when Pi can
  /// decide on its own.
  Future<List<String>> launchArgs(String cwd, Future<TrustChoice?> Function(String cwd)? prompt) async {
    if (!requiresTrust(cwd) || savedDecision(cwd) != null || prompt == null) return const [];
    final choice = await prompt(cwd) ?? TrustChoice.distrustOnce;
    if (choice.remember) {
      try {
        remember(cwd, choice.trusted);
      } catch (_) {
        // Fall back to a one-time decision if trust.json is not writable.
      }
    }
    return [choice.trusted ? '--approve' : '--no-approve'];
  }

  Map<String, dynamic> _read() {
    try {
      final decoded = jsonDecode(File(trustFile).readAsStringSync());
      return decoded is Map ? decoded.cast<String, dynamic>() : {};
    } catch (_) {
      return {};
    }
  }

  static bool _same(String a, String b) {
    final na = p.normalize(p.absolute(a));
    final nb = p.normalize(p.absolute(b));
    return Platform.isWindows ? na.toLowerCase() == nb.toLowerCase() : na == nb;
  }
}
