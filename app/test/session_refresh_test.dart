import 'dart:async';
import 'dart:io';

import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';
import 'fake_pi.dart';

void main() {
  test('live context follows each request and stays with the owning session', () async {
    final backend = FakeBackend();
    final first = SessionRuntime(workspace: '.', launch: backend.launch, onToast: (_) {});
    final other = SessionRuntime(workspace: '.', launch: backend.launch, onToast: (_) {});
    Json usage(int tokens) => {'tokens': tokens, 'contextWindow': 10000, 'percent': tokens / 100};
    void advance(FakePi pi, int tokens) => pi.emit({'type': 'df_context_usage_changed', 'contextUsage': usage(tokens)});
    try {
      await first.start();
      await other.start();
      final pi = backend.pis.first;
      final otherTokens = other.stats.contextTokens;
      pi.startRun('多轮工具调用');
      advance(pi, 1100);
      await Future<void>.delayed(Duration.zero);
      expect(first.isRunning, true);
      expect(first.stats.contextTokens, 1100);
      expect(other.stats.contextTokens, otherTokens);

      // get_session_stats is already in flight when the next request settles.
      pi.extraResponses['get_session_stats'] = {'contextUsage': usage(1100), 'tokens': {'total': 1200}};
      pi.onCommand = (command) {
        if (command['type'] == 'get_session_stats') advance(pi, 2400);
      };
      pi.emit({'type': 'turn_end'});
      await Future<void>.delayed(Duration.zero);
      expect(first.stats.totalTokens, 1200);
      expect(first.stats.contextTokens, 2400);
      expect(first.stats.contextPercent, 24);
      expect(other.stats.contextTokens, otherTokens);
    } finally {
      first.dispose();
      other.dispose();
      await backend.dispose();
    }
  });

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
