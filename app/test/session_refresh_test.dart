import 'dart:async';
import 'dart:io';

import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';

void main() {
  for (final changeWorkspace in [false, true]) {
    test('late session refresh cannot replace newer results (workspace change: $changeWorkspace)', () async {
      SharedPreferences.setMockInitialValues({});
      final directory = Directory.systemTemp.createTempSync('df_refresh_');
      final backend = FakeBackend();
      final agent = AgentController(preferences: await Preferences.load(), backend: backend, sessionStore: SessionStore(sessionsDir: directory.path));
      try {
        agent.workspace = directory.path;
        final older = Completer<Object?>();
        final newer = Completer<Object?>();
        var calls = 0;
        backend.handlers['sessions.list'] = (_) => calls++ == 0 ? older.future : newer.future;
        final first = agent.refreshSessions();
        if (changeWorkspace) agent.workspace = '${directory.path}/other';
        final second = agent.refreshSessions();
        newer.complete([{'path': '${directory.path}/new.jsonl', 'cwd': agent.workspace, 'title': 'new'}]);
        await second;
        older.complete([{'path': '${directory.path}/old.jsonl', 'cwd': directory.path, 'title': 'old'}]);
        await first;
        expect(agent.sidebar.map((e) => e.title), ['new']);
      } finally {
        agent.dispose();
        directory.deleteSync(recursive: true);
      }
    });
  }
}
