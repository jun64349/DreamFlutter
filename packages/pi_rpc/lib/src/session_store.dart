/// Discovers persisted Pi sessions on disk. RPC has no "list sessions"
/// command, so this reads the session JSONL files directly (see Pi docs:
/// session-format.md). Only the header, the first user message and
/// `session_info` entries are decoded, so large sessions stay cheap to scan.
library;

import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

import 'core_client.dart' show CoreLocator;

import 'json.dart';
import 'messages.dart';

class SessionSummary {
  const SessionSummary({
    required this.path,
    required this.id,
    required this.cwd,
    required this.title,
    required this.createdAt,
    required this.modifiedAt,
    this.parentSession,
    this.isSideConversation = false,
    this.sideQuote,
  });

  final String path;

  /// For forked or cloned sessions: the session file it was created from.
  final String? parentSession;
  final bool isSideConversation;
  final String? sideQuote;
  final String id;
  final String cwd;

  /// The session name if set, otherwise the start of the first user message.
  final String title;
  final DateTime createdAt;
  final DateTime modifiedAt;
}

class SessionStore {
  SessionStore({String? sessionsDir}) : sessionsDir = sessionsDir ?? defaultSessionsDir();

  String sessionsDir;

  /// DreamFlutter's own Pi folder in its data folder (v0.3.2), not the Pi command line's ~/.pi/agent.
  static String defaultAgentDir([String? dataDir]) => _configuredLocation(dataDir, 'configuration') ?? p.join(dataDir ?? CoreLocator.defaultDataDir(), 'pi');

  static String defaultSessionsDir([String? dataDir]) => _configuredLocation(dataDir, 'sessions') ?? p.join(defaultAgentDir(dataDir), 'sessions');

  static String? _configuredLocation(String? dataDir, String key) {
    try {
      final config = jsonDecode(File(p.join(dataDir ?? CoreLocator.defaultDataDir(), 'storage-locations.json')).readAsStringSync()) as Map;
      final value = (config['paths'] as Map)[key];
      return value is String && p.isAbsolute(value) ? value : null;
    } catch (_) { return null; }
  }

  /// Sessions newest first, optionally only those whose workspace is [cwd].
  Future<List<SessionSummary>> list({String? cwd,
    bool includeSideConversations = false,
  }) async {
    final root = Directory(sessionsDir);
    if (!await root.exists()) return const [];
    final summaries = <SessionSummary>[];
    await for (final entity in root.list(recursive: true, followLinks: false)) {
      if (entity is! File || !entity.path.endsWith('.jsonl')) continue;
      final summary = await readSummary(entity,
        includeSideConversations: includeSideConversations,
      );
      if (summary == null) continue;
      if (cwd != null && !samePath(summary.cwd, cwd)) continue;
      summaries.add(summary);
    }
    summaries.sort((a, b) => b.modifiedAt.compareTo(a.modifiedAt));
    return summaries;
  }

  /// Distinct workspaces that have sessions, most recently used first.
  Future<List<String>> workspaces() async {
    final seen = <String>{};
    final result = <String>[];
    for (final s in await list()) {
      if (seen.add(p.normalize(s.cwd).toLowerCase())) result.add(s.cwd);
    }
    return result;
  }

  /// Moves a session file to the Windows Recycle Bin (deleted outright on
  /// other platforms). Returns true on success.
  static Future<bool> deleteSession(String path) async {
    final file = File(path);
    if (!await file.exists()) return true;
    if (!Platform.isWindows) {
      await file.delete();
      return true;
    }
    final escaped = path.replaceAll("'", "''");
    final result = await Process.run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('$escaped', 'OnlyErrorDialogs', 'SendToRecycleBin')",
    ]);
    return result.exitCode == 0 && !await file.exists();
  }

  static Future<SessionSummary?> readSummary(File file, {
    bool includeSideConversations = false,
  }) async {
    try {
      final stat = await file.stat();
      Json? header;
      String? firstUserText;
      String? name;
      Json? side;
      final lines = file.openRead().transform(utf8.decoder).transform(const LineSplitter());
      await for (final line in lines) {
        if (header == null) {
          final first = jsonDecode(line);
          if (first is! Map || first['type'] != 'session') return null;
          header = first.cast<String, dynamic>();
          continue;
        }
        if (line.contains('df.sideConversation')) {
          final entry = asJson(jsonDecode(line));
          if (entry['type'] == 'custom' && entry['customType'] == 'df.sideConversation' && asJson(entry['data'])['sessionId'] == header['id']) {
            if (!includeSideConversations) return null;
            side = asJson(entry['data']);
          }
        }
        if (line.contains('"type":"session_info"')) {
          name = asString(asJson(jsonDecode(line))['name']);
        } else if (firstUserText == null && line.contains('"role":"user"')) {
          final entry = asJson(jsonDecode(line));
          final message = asJson(entry['message']);
          if (entry['type'] == 'message' && message['role'] == 'user') {
            firstUserText = textOf(ContentBlock.listFrom(message['content']));
          }
        }
      }
      if (header == null) return null;
      final title = (name?.trim().isNotEmpty ?? false) ? name!.trim() : _shorten(firstUserText ?? '');
      return SessionSummary(
        path: file.path,
        id: asString(header['id']) ?? p.basenameWithoutExtension(file.path),
        cwd: asString(header['cwd']) ?? '',
        title: title,
        parentSession: asString(side?['parentSession']) ??
            asString(header['parentSession']),
        isSideConversation: side != null,
        sideQuote: asString(side?['quote']),
        createdAt: DateTime.tryParse(asString(header['timestamp']) ?? '')?.toLocal() ?? stat.modified,
        modifiedAt: stat.modified,
      );
    } catch (_) {
      return null;
    }
  }

  static String _shorten(String text) {
    final oneLine = text.replaceAll(RegExp(r'\s+'), ' ').trim();
    return oneLine.length <= 60 ? oneLine : '${oneLine.substring(0, 60)}…';
  }

  /// Path equality that ignores case and separators on Windows.
  static bool samePath(String a, String b) {
    final na = p.normalize(p.absolute(a));
    final nb = p.normalize(p.absolute(b));
    return Platform.isWindows ? na.toLowerCase() == nb.toLowerCase() : na == nb;
  }
}
