import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:test/test.dart';

void main() {
  late Directory root;

  setUp(() => root = Directory.systemTemp.createTempSync('pi_sessions_'));
  tearDown(() => root.deleteSync(recursive: true));

  File writeSession(String dir, String name, List<Map<String, Object?>> entries, {DateTime? modified}) {
    final file = File(p.join(root.path, dir, name))..createSync(recursive: true);
    file.writeAsStringSync(entries.map(jsonEncode).join('\n'));
    if (modified != null) file.setLastModifiedSync(modified);
    return file;
  }

  Map<String, Object?> header(String id, String cwd) =>
      {'type': 'session', 'version': 3, 'id': id, 'timestamp': '2026-10-27T03:00:00.000Z', 'cwd': cwd};

  Map<String, Object?> user(String text) => {
    'type': 'message',
    'id': 'u1',
    'parentId': null,
    'timestamp': '2026-10-27T03:00:01.000Z',
    'message': {'role': 'user', 'content': text, 'timestamp': 1},
  };

  test('lists sessions newest first with titles from the first user message', () async {
    writeSession('--E--a--', 'old.jsonl', [header('s1', r'E:\a'), user('first question')], modified: DateTime(2026, 10, 1));
    writeSession('--E--a--', 'new.jsonl', [header('s2', r'E:\a'), user('second question')], modified: DateTime(2026, 10, 20));

    final sessions = await SessionStore(sessionsDir: root.path).list();
    expect(sessions.map((s) => s.id), ['s2', 's1']);
    expect(sessions.first.title, 'second question');
  });

  test('session_info name wins over the first message, latest name wins', () async {
    writeSession('--E--a--', 'x.jsonl', [
      header('s1', r'E:\a'),
      user('hello'),
      {'type': 'session_info', 'id': 'i1', 'parentId': 'u1', 'timestamp': 't', 'name': 'Old name'},
      {'type': 'session_info', 'id': 'i2', 'parentId': 'i1', 'timestamp': 't', 'name': 'Refactor auth'},
    ]);
    final sessions = await SessionStore(sessionsDir: root.path).list();
    expect(sessions.single.title, 'Refactor auth');
  });

  test('filters by workspace and skips files that are not sessions', () async {
    writeSession('--E--a--', '1.jsonl', [header('s1', r'E:\a'), user('a')]);
    writeSession('--E--b--', '2.jsonl', [header('s2', r'E:\b'), user('b')]);
    writeSession('--E--b--', 'junk.jsonl', [{'type': 'not-a-session'}]);

    final store = SessionStore(sessionsDir: root.path);
    expect((await store.list(cwd: r'E:\b')).map((s) => s.id), ['s2']);
    expect((await store.workspaces()).length, 2);
  });

  test('deleteSession removes the file (Recycle Bin on Windows)', () async {
    final file = writeSession('--E--a--', 'gone.jsonl', [header('s9', r'E:\a'), user('bye')]);
    expect(await SessionStore.deleteSession(file.path), isTrue);
    expect(file.existsSync(), isFalse);
    expect(await SessionStore.deleteSession(file.path), isTrue, reason: 'already gone is fine');
  });

  test('reads parentSession for forked sessions', () async {
    writeSession('--E--a--', 'fork.jsonl', [
      {...header('s3', r'E:\a'), 'parentSession': r'E:\x\orig.jsonl'},
      user('forked'),
    ]);
    expect((await SessionStore(sessionsDir: root.path).list()).single.parentSession, r'E:\x\orig.jsonl');
  });

  test('returns an empty list when the directory does not exist', () async {
    expect(await SessionStore(sessionsDir: p.join(root.path, 'missing')).list(), isEmpty);
  });

  test('reads real sessions on this machine without throwing', () async {
    final sessions = await SessionStore().list();
    for (final s in sessions) {
      expect(s.cwd, isNotEmpty);
    }
  }, skip: Directory(SessionStore.defaultSessionsDir()).existsSync() ? false : 'no local Pi sessions');
}
