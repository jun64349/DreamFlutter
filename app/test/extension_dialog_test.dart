import 'dart:io';

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_pi.dart';

void main() {
  late List<FakePi> pis;
  late AgentController agent;
  late Directory sessions;

  Future<void> startApp(WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(1280, 800));
    SharedPreferences.setMockInitialValues({'workspace': Directory.systemTemp.path});
    sessions = Directory.systemTemp.createTempSync('df_dialog_');
    pis = [];
    agent = AgentController(
      preferences: await tester.runAsync(Preferences.load) as Preferences,
      sessionStore: SessionStore(sessionsDir: sessions.path),
      resolveConfig: (cwd, args) => PiLaunchConfig(cliPath: 'cli.js', workingDirectory: cwd, extraArgs: args),
      launch: (config) async {
        final pi = FakePi(config);
        pis.add(pi);
        return PiRpcClient(pi);
      },
    );
    await tester.pumpWidget(DreamFlutterApp(controller: agent));
    await tester.runAsync(agent.init);
    await tester.pumpAndSettle();
  }

  Future<void> requestApproval(WidgetTester tester) async {
    await tester.runAsync(() async {
      pis.single.emit({
        'type': 'extension_ui_request',
        'id': 'ui-1',
        'method': 'select',
        'title': 'Agent 请求执行操作\n\n执行命令：\nrm -rf build',
        'options': ['允许', '本会话内总是允许「bash」', '拒绝'],
      });
      await Future<void>.delayed(const Duration(milliseconds: 50));
    });
    await tester.pumpAndSettle();
  }

  tearDown(() {
    agent.dispose();
    sessions.deleteSync(recursive: true);
  });

  testWidgets('answering an approval closes only the dialog', (tester) async {
    await startApp(tester);
    await requestApproval(tester);
    expect(find.text('Agent 请求执行操作'), findsOneWidget);
    expect(find.text('rm -rf build'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, '允许'));
    await tester.pumpAndSettle();

    expect(find.text('Agent 请求执行操作'), findsNothing);
    expect(find.text('新会话'), findsWidgets, reason: 'the main page must still be there');
    expect(pis.single.commands.last, {'type': 'extension_ui_response', 'id': 'ui-1', 'value': '允许'});
  });

  testWidgets('a dialog whose run ended closes by itself', (tester) async {
    await startApp(tester);
    await requestApproval(tester);
    await tester.runAsync(() async {
      pis.single.finishRun();
      await Future<void>.delayed(const Duration(milliseconds: 50));
    });
    await tester.pumpAndSettle();

    expect(find.text('Agent 请求执行操作'), findsNothing);
    expect(find.text('新会话'), findsWidgets);
  });
}
