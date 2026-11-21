import 'dart:io';

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/ui/settings_controls.dart' show SettingRow, V1Toggle;
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
    await tester.tap(find.byKey(const ValueKey('settings-nav-蝶君')));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pumpAndSettle();
    // 0.12 put 性格/主动/长期目标/规则/日程 above the sandbox card: scroll down to it.
    await tester.drag(find.byKey(const ValueKey('settings-蝶君')), const Offset(0, -4000));
    await tester.pumpAndSettle();
  }

  // Route step 4 (user 2026-11-18): one-click sandbox. Setting up installs WSL itself; the manual
  // command only shows after that failed.
  testWidgets('without WSL one button sets it all up; the manual command only after a failure', (tester) async {
    status = {'state': 'no-wsl', 'online': true, 'distro': 'DreamFlutterSandbox'};
    await openPanel(tester);
    expect(find.text('wsl --install --no-distribution'), findsNothing);
    backend.handlers['sandbox.provision'] = (_) => status;
    await tester.ensureVisible(find.text('建立沙箱'));
    await tester.tap(find.text('建立沙箱'));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pumpAndSettle();
    expect(backend.callsTo('sandbox.provision'), hasLength(1));
    agent.sandboxStatus.value = {'state': 'no-wsl', 'online': true, 'error': '需要你在 Windows 的管理员确认里点「是」才能安装 WSL。'};
    await tester.pump();
    expect(find.textContaining('管理员确认里点「是」'), findsOneWidget);
    expect(find.text('wsl --install --no-distribution'), findsOneWidget);
  });

  testWidgets('after WSL is installed it offers to restart now or later', (tester) async {
    status = {'state': 'restart-needed', 'online': true, 'distro': 'DreamFlutterSandbox'};
    await openPanel(tester);
    expect(find.textContaining('重启电脑后才能用'), findsOneWidget);
    backend.handlers['sandbox.restartComputer'] = (_) => {'restarting': true};
    await tester.ensureVisible(find.text('现在重启'));
    await tester.tap(find.text('现在重启'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '现在重启').last);
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pumpAndSettle();
    expect(backend.callsTo('sandbox.restartComputer'), hasLength(1));
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
    expect(find.text('允许沙箱联网'), findsNothing, reason: 'one networking switch: 允许联网 above the panel');
    final onlineSwitch = find.descendant(of: find.ancestor(of: find.text('允许联网'), matching: find.byType(SettingRow)).first, matching: find.byType(V1Toggle));
    await tester.ensureVisible(onlineSwitch);
    await tester.pumpAndSettle();
    await tester.tap(onlineSwitch);
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

  testWidgets('Git compatibility confirms the real destination before copying', (tester) async {
    const standard = r'C:\Users\sample\DreamFlutter\workspace';
    const compatibility = r'C:\appcontainer-0123456789abcdef0123456789abcdef\workspace';
    const enable = '启用 Git 兼容工作区';
    status = {
      'kind': 'appcontainer', 'state': 'ready', 'online': false, 'distro': 'DreamFlutter-Windows',
      'workspaceDir': standard, 'gitCompatibility': {'enabled': false, 'alternativePath': compatibility},
    };
    await openPanel(tester);
    backend.handlers['sandbox.setGitCompatibility'] = (_) => status = {
      ...status, 'workspaceDir': compatibility, 'retainedWorkspaceDir': standard,
      'gitCompatibility': {'enabled': true, 'alternativePath': standard},
    };
    await tester.ensureVisible(find.text(enable));
    await tester.tap(find.text(enable)); await tester.pumpAndSettle();
    expect(find.textContaining(compatibility), findsOneWidget);
    expect(backend.callsTo('sandbox.setGitCompatibility'), isEmpty);
    await tester.tap(find.text('取消')); await tester.pumpAndSettle();
    expect(backend.callsTo('sandbox.setGitCompatibility'), isEmpty);
    await tester.tap(find.text(enable)); await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, enable)); await tester.pumpAndSettle();
    expect(backend.callsTo('sandbox.setGitCompatibility').single, {'enabled': true, 'workspaceDir': compatibility});
    expect(find.text('切回标准工作区'), findsOneWidget);
    expect(find.text(compatibility), findsOneWidget);
  });
}
