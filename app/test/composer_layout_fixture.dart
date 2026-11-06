import 'dart:io';
import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'fake_backend.dart';

const composerModelName = 'DeepSeek-V4.1-Flash · 工作区验证模型';

Future<({AgentController agent, FakeBackend backend, GlobalKey capture})> startComposerLayout(WidgetTester tester) async {
  await tester.binding.setSurfaceSize(const Size(1000, 800));
  final directory = Directory.systemTemp.createTempSync('df_composer_layout_');
  SharedPreferences.setMockInitialValues({'workspace': directory.path, 'onboarded': true, 'zoom': 1.5});
  final backend = FakeBackend();
  backend.onLaunch = (pi) {
    final model = <String, dynamic>{'id': 'layout-model', 'name': composerModelName, 'provider': 'layout-test', 'reasoning': true, 'input': ['text', 'image'], 'contextWindow': 200000, 'maxTokens': 4096};
    pi.extraResponses.addAll({
      'get_state': {'sessionFile': pi.sessionFile, 'sessionId': 'layout-session', 'model': model, 'thinkingLevel': 'medium', 'isStreaming': false},
      'get_available_models': {'models': [model]},
      'get_available_thinking_levels': {'levels': ['off', 'low', 'medium', 'high']},
      'df_agent_state': {'agentMode': 'standard', 'planMode': false, 'todos': []},
    });
  };
  final agent = AgentController(preferences: (await tester.runAsync(Preferences.load))!, sessionStore: SessionStore(sessionsDir: directory.path), backend: backend);
  final capture = GlobalKey();
  await tester.pumpWidget(RepaintBoundary(key: capture, child: DreamFlutterApp(controller: agent)));
  await tester.runAsync(agent.init);
  await tester.pumpAndSettle();
  addTearDown(() async {
    await tester.pumpWidget(const SizedBox());
    agent.dispose();
    directory.deleteSync(recursive: true);
    await tester.binding.setSurfaceSize(null);
  });
  return (agent: agent, backend: backend, capture: capture);
}
