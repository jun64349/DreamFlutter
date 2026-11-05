import 'dart:io';

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';

/// Settings › 蝶君沙箱 (v0.3 3.3).
void main() {
  late FakeBackend backend;
  late AgentController agent;
  var status = <String, Object?>{};

  Future<void> openPanel(WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(1400, 900));
    SharedPreferences.setMockInitialValues({'workspace': Directory.systemTemp.path, 'onboarded': true});
    final sessions = Directory.systemTemp.createTempSync('df_sandbox_');
    backend = FakeBackend();
    backend.handlers.addAll({
      'sandbox.status': (_) => status,
      'sandbox.selfTest': (_) => {
        'items': [
          {'name': 'no-drives', 'passed': true, 'detail': null},
          {'name': 'no-windows-programs', 'passed': true, 'detail': null},
        ],
      },
      'sandbox.setOnline': (params) => status = {...status, 'online': params['online']},
    });
    agent = AgentController(
      preferences: await tester.runAsync(Preferences.load) as Preferences,
      sessionStore: SessionStore(sessionsDir: sessions.path),
      backend: backend,
    );
    addTearDown(() {
      agent.dispose();
      sessions.deleteSync(recursive: true);
    });
    await tester.pumpWidget(DreamFlutterApp(controller: agent));
    await tester.runAsync(agent.init);
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip(RegExp('^设置')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('蝶君沙箱'));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pumpAndSettle();
  }

  testWidgets('without WSL it explains how to install it', (tester) async {
    status = {'state': 'no-wsl', 'online': true, 'distro': 'DreamFlutterSandbox'};
    await openPanel(tester);
    expect(find.text('wsl --install --no-distribution'), findsOneWidget);
  });

  testWidgets('a ready sandbox can be tested and taken offline', (tester) async {
    status = {'state': 'ready', 'online': true, 'diskBytes': 1400000000, 'distro': 'DreamFlutterSandbox'};
    await openPanel(tester);
    expect(find.text('沙箱已就绪'), findsOneWidget);
    await tester.tap(find.text('运行逃逸自检'));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pumpAndSettle();
    expect(find.text('自检全部通过（2 项）'), findsOneWidget);
    expect(find.text('运行不了 Windows 程序'), findsOneWidget);
    await tester.tap(find.text('允许沙箱联网'));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pumpAndSettle();
    expect(backend.callsTo('sandbox.setOnline').single, {'online': false});
  });

  testWidgets('progress pushed by the core shows while it is being set up', (tester) async {
    status = {'state': 'absent', 'online': true, 'distro': 'DreamFlutterSandbox'};
    await openPanel(tester);
    expect(find.text('建立沙箱'), findsOneWidget);
    agent.sandboxStatus.value = {'state': 'provisioning', 'step': '下载系统镜像（阿里云）', 'progress': 0.4, 'online': true};
    await tester.pump();
    expect(find.text('下载系统镜像（阿里云）'), findsOneWidget);
    expect(tester.widget<LinearProgressIndicator>(find.byType(LinearProgressIndicator)).value, 0.4);
  });
}
