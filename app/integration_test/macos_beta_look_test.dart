import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/beta_edition.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/ui/beta_activation.dart';
import 'package:dreamflutter/ui/web_surface.dart';
import 'package:dreamflutter/ui/window_frame.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../test/fake_backend.dart';
import '../test/fake_pi.dart';

/// Real macOS window visual capture for the 1.0 Preview friend-beta edition.
/// Run on macOS CI with:
///   flutter test integration_test/macos_beta_look_test.dart -d macos \
///     --dart-define=DREAMFLUTTER_BETA=true --dart-define=MACOS_SHOT_DIR=...
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  const shotDirEnv = String.fromEnvironment('MACOS_SHOT_DIR', defaultValue: 'build/macos-screenshots');

  testWidgets('capture macOS beta 1.0 UI scenes', (tester) async {
    final prevRealWindow = AppTitleBar.realWindow;
    final prevWebSurfaceFactory = WebSurfaces.create;
    AppTitleBar.realWindow = true;
    WebSurfaces.create = () async => null;

    final root = Directory.systemTemp.createTempSync('df_mac_shots_');
    final sessionsDir = Directory(p.join(root.path, 'sessions'))..createSync(recursive: true);
    final butterflySessions = Directory(p.join(root.path, 'butterfly-sessions'))..createSync(recursive: true);
    final workspace = Directory(p.join(root.path, '实验报告'))..createSync(recursive: true);
    final sandboxWorkspace = p.join(root.path, 'sandbox', 'workspace');
    Directory(sandboxWorkspace).createSync(recursive: true);

    final wbSessionPath = p.join(sessionsDir.path, 'wb-demo.jsonl');
    File(wbSessionPath).writeAsStringSync([
      jsonEncode({'type': 'session', 'id': 'wb-demo', 'cwd': workspace.path}),
      jsonEncode({'type': 'session_info', 'name': '整理实验室温湿度周报'}),
    ].join('\n'));

    final bfSessionPath = p.join(butterflySessions.path, 'bf-demo.jsonl');
    File(bfSessionPath).writeAsStringSync([
      jsonEncode({'type': 'session', 'id': 'bf-demo', 'cwd': sandboxWorkspace}),
      jsonEncode({'type': 'session_info', 'name': '梳理最近机器学习文献要点'}),
    ].join('\n'));

    final backend = FakeBackend()
      ..sessionsDir = sessionsDir.path
      ..butterflyHome = butterflySessions.path
      ..settings = {
        'approvalMode': 'changes',
        'autoCompaction': true,
        'defaultModel': 'df-c9/$betaTerra',
        'smallTaskModel': 'df-c9/$betaTerra',
        'largeTaskModel': 'df-c9/$betaSol',
        'visionModel': 'df-c9/$betaTerra',
        'sandboxOnline': true,
        'userName': '朋友',
      };

    final nowMs = DateTime.now().millisecondsSinceEpoch;
    backend.sessionRows = [
      {
        'path': wbSessionPath,
        'id': 'wb-demo',
        'cwd': workspace.path,
        'title': '整理实验室温湿度周报',
        'modified': nowMs - 120000,
        'messageCount': 4,
      },
    ];

    final betaChannels = [
      {
        'id': 'c9',
        'name': betaChannelName,
        'provider': 'df-c9',
        'platform': 'openai-relay',
        'kind': 'relay',
        'api': 'openai-completions',
        'baseUrl': betaBaseUrl,
        'models': betaModels(),
        'keys': [{'id': 'k1', 'label': '', 'enabled': true, 'hint': '89ab'}],
        'enabled': true,
      },
    ];
    final seatbeltStatus = {
      'kind': 'seatbelt',
      'state': 'ready',
      'step': null,
      'progress': null,
      'error': null,
      'online': true,
      'diskBytes': 18874368,
      'distro': 'macos-seatbelt',
      'workspaceDir': sandboxWorkspace,
      'mirror': null,
      'bundled': true,
    };

    backend.handlers.addAll({
      'gateway.channels': (_) => betaChannels,
      'gateway.groups': (_) => <Json>[],
      'gateway.platforms': (_) => <Json>[],
      'setup.status': (_) => {'completed': true, 'dataRoot': root.path},
      'setup.testChannel': (_) => {'ok': true},
      'sandbox.status': (_) => seatbeltStatus,
      'sandbox.selfTest': (_) => {
        'items': [
          {'name': 'workspace-write', 'passed': true, 'detail': 'ok'},
          {'name': 'host-write-blocked', 'passed': true, 'detail': 'ok'},
          {'name': 'sensitive-read-blocked', 'passed': true, 'detail': 'ok'},
        ],
      },
      'updates.status': (_) => {'state': 'idle', 'application': {'version': '1.0.0-preview.2', 'build': '20'}},
      'attention.list': (_) => {'now': <Json>[], 'later': <Json>[], 'counts': {'total': 0}, 'pending': <Json>[]},
      'ledger.summary': (_) => {'timeZone': 'Asia/Shanghai', 'rows': <Json>[]},
      'ledger.entries': (_) => <Json>[],
      'storage.locations': (_) => {
        'rows': [
          {'id': 'database', 'label': '后台数据库', 'path': p.join(root.path, 'application-data', 'database'), 'bytes': 24576, 'movable': true},
        ],
        'artifacts': <Json>[],
      },
      'backup.overview': (_) => {'estimateText': '120 KB'},
      'workspace.toolRules': (_) => <Json>[],
      'memory.list': (_) => <Json>[],
      'memory.candidates': (_) => <Json>[],
      'schedules.list': (_) => <Json>[],
    });

    final wbMessages = <Json>[
      {'role': 'user', 'timestamp': nowMs - 120000, 'content': '把这周传感器记录整理成简明结论。'},
      {
        'role': 'assistant',
        'timestamp': nowMs - 110000,
        'model': betaTerra,
        'provider': 'df-c9',
        'stopReason': 'toolUse',
        'content': [
          {'type': 'toolCall', 'id': 't1', 'name': 'bash', 'arguments': {'command': 'python3 scripts/summary.py --week 45'}},
        ],
      },
      {'role': 'toolResult', 'toolCallId': 't1', 'toolName': 'bash', 'isError': false, 'content': [{'type': 'text', 'text': '平均温度 22.4 ℃，平均湿度 61.8 %'}]},
      {
        'role': 'assistant',
        'timestamp': nowMs - 105000,
        'model': betaTerra,
        'provider': 'df-c9',
        'stopReason': 'stop',
        'content': [
          {
            'type': 'text',
            'text': '已经梳理完成：\n\n| 指标 | 本周 | 上周 |\n| --- | --- | --- |\n| 平均温度 | 22.4 ℃ | 21.8 ℃ |\n| 平均湿度 | 61.8 % | 55.2 % |\n\n> 夜里出现过几次湿度超限，建议核对实验柜除湿设定。\n\n```python\nsummary = week.mean()\n```',
          },
        ],
      },
    ];

    final modelObj = {
      ...betaModels().first,
      'provider': 'df-c9',
      'api': 'openai-completions',
      'baseUrl': betaBaseUrl,
    };

    void populatePi(FakePi pi) {
      pi.extraResponses.addAll({
        'get_state': {
          'model': modelObj,
          'thinkingLevel': 'medium',
          'isStreaming': false,
          'isCompacting': false,
          'steeringMode': 'one-at-a-time',
          'followUpMode': 'one-at-a-time',
          'sessionId': 'mac-demo',
          'sessionFile': pi.sessionFile,
          'autoCompactionEnabled': true,
          'messageCount': pi.messages.length,
          'pendingMessageCount': 0,
        },
        'get_available_models': {'models': [modelObj]},
        'get_available_thinking_levels': {'levels': ['off', 'low', 'medium', 'high']},
        'get_commands': {'commands': <Object>[]},
        'get_session_stats': {
          'sessionId': 'mac-demo',
          'userMessages': 1,
          'assistantMessages': 2,
          'toolCalls': 1,
          'toolResults': 1,
          'totalMessages': 4,
          'tokens': {'input': 820, 'output': 190, 'cacheRead': 0, 'cacheWrite': 0, 'total': 1010},
          'cost': 0,
          'contextUsage': {'tokens': 1010, 'contextWindow': 500000, 'percent': 0.2},
        },
        'set_model': modelObj,
      });
      pi.onCommand = (c) {
        if (c['type'] == 'switch_session' && c['sessionPath'] == wbSessionPath) {
          pi.messages = wbMessages;
        }
      };
      if (pi.target.sessionPath == wbSessionPath) pi.messages = wbMessages;
    }

    backend.onLaunch = populatePi;

    SharedPreferences.setMockInitialValues({
      'workspace': workspace.path,
      'recentWorkspaces': [workspace.path],
      'onboarded': true,
      'zoom': 1.0,
      'decorativeMotion': false,
    });

    final agent = AgentController(
      preferences: await tester.runAsync(Preferences.load) as Preferences,
      sessionStore: SessionStore(sessionsDir: sessionsDir.path),
      backend: backend,
    );
    final key = GlobalKey();
    final shotsDir = Directory(shotDirEnv)..createSync(recursive: true);

    addTearDown(() async {
      AppTitleBar.realWindow = prevRealWindow;
      WebSurfaces.create = prevWebSurfaceFactory;
      await tester.pumpWidget(const SizedBox());
      agent.dispose();
      try {
        root.deleteSync(recursive: true);
      } catch (_) {}
    });

    Future<void> settle([int rounds = 6]) async {
      for (var i = 0; i < rounds; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 35)));
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    Future<void> shot(String name) async {
      await settle();
      final error = tester.takeException();
      if (error != null) throw StateError('$name: $error');
      await tester.runAsync(() async {
        final boundary = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        final image = await boundary.toImage(pixelRatio: 2.0);
        final data = await image.toByteData(format: ui.ImageByteFormat.png);
        File(p.join(shotsDir.path, name)).writeAsBytesSync(data!.buffer.asUint8List(), flush: true);
        image.dispose();
      });
    }

    await tester.binding.setSurfaceSize(const Size(1280, 820));
    await tester.runAsync(agent.init);
    await settle();

    // 1. Beta activation screen
    await tester.pumpWidget(
      RepaintBoundary(
        key: key,
        child: DreamFlutterApp(
          controller: agent,
          home: BetaActivation(status: {'dataRoot': root.path}, onComplete: () {}),
        ),
      ),
    );
    await shot('01-beta-activation-light.png');

    // 2. Main 1.0 redesigned home (light)
    await tester.pumpWidget(RepaintBoundary(key: key, child: DreamFlutterApp(controller: agent)));
    await tester.runAsync(agent.refreshSessions);
    await settle();
    await shot('02-home-workbench-light.png');

    // 3. Workbench conversation with process block, table & code
    await tester.runAsync(() => agent.openSession(wbSessionPath));
    await settle(8);
    await shot('03-chat-workbench-light.png');

    // 4. Butterfly space
    await tester.runAsync(() => agent.openButterfly());
    await settle();
    await shot('04-butterfly-seatbelt-light.png');

    // 5a. Beta model pool settings
    agent.openSettings('模型');
    await settle();
    await shot('05a-settings-beta-models.png');

    // 5b. Butterfly Seatbelt sandbox settings
    agent.openSettings('蝶君');
    await settle();
    final sandboxRow = find.text('运行逃逸自检');
    if (sandboxRow.evaluate().isNotEmpty) {
      await tester.ensureVisible(sandboxRow.first);
      await settle();
    }
    await shot('05b-settings-seatbelt-sandbox.png');

    // 6. Dark theme home
    agent.showSection(AppSection.chat);
    await tester.runAsync(() => agent.newSession());
    await tester.runAsync(() => agent.setThemeMode(ThemeMode.dark));
    await settle();
    await shot('06-home-dark.png');
  });
}
