import 'dart:io';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/about_panel.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'fake_backend.dart';

class AboutBackend extends FakeBackend {
  bool failSave = false;
  @override
  Future<Object?> call(String method, [Json params = const {}, Duration timeout = const Duration(seconds: 60)]) {
    if (method == 'settings.update' && failSave) throw CoreException('save_failed', '关闭行为保存失败，请重试');
    return super.call(method, params, timeout);
  }
}

void main() {
  for (final brightness in Brightness.values) {
    testWidgets('about controls and explicit unsigned approval at 150% in $brightness', (tester) async {
      await tester.binding.setSurfaceSize(const Size(560, 1050));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      SharedPreferences.setMockInitialValues({});
      const capture = bool.fromEnvironment('T67_CAPTURE');
      if (capture) { await tester.runAsync(() async {
        final loader = FontLoader('T67Capture')..addFont(Future.value(ByteData.sublistView(await File('C:/Windows/Fonts/msyh.ttc').readAsBytes())));
        await loader.load();
        final icons = FontLoader('MaterialIcons')..addFont(Future.value(ByteData.sublistView(await File('E:/dev/flutter/bin/cache/artifacts/material_fonts/materialicons-regular.otf').readAsBytes())));
        await icons.load();
      }); }
      final dir = Directory.systemTemp.createTempSync('df-about-widget-'), backend = AboutBackend();
      final status = <String, dynamic>{'application': {'version': '0.6.0-test.1', 'build': '11', 'signed': false}, 'coreVersion': '0.5.0', 'piVersion': '1.4.0', 'platform': 'win32', 'arch': 'x64', 'state': 'downloaded', 'message': '更新包校验通过；安装前需要确认。', 'downloaded': true, 'canInstall': true, 'canStartup': true, 'startOnLogin': false, 'available': {'version': '0.6.0-test.2', 'size': 123456, 'sha256': 'a' * 64, 'notes': '本机测试版本说明'}};
      backend.handlers['updates.status'] = (_) => status;
      backend.handlers['updates.install'] = (_) => status;
      backend.handlers['updates.diagnostics'] = (_) => {'path': '${dir.path}/diagnostics.zip'};
      backend.handlers['app.setStartup'] = (params) { status['startOnLogin'] = params['enabled']; return status; };
      backend.handlers['updates.licenses'] = (_) => {'generated': true, 'entries': [{'id': '0', 'name': 'Synthetic dependency', 'version': '1.2.3', 'license': 'MIT', 'path': 'licenses/texts/0.txt'}]};
      backend.handlers['updates.licenseText'] = (_) => {'text': 'Synthetic license text from the generated package'};
      final agent = AgentController(preferences: await Preferences.load(), sessionStore: SessionStore(sessionsDir: dir.path), backend: backend);
      addTearDown(() { agent.dispose(); dir.deleteSync(recursive: true); });
      final theme = buildTheme(brightness);
      await tester.pumpWidget(AgentScope(controller: agent, child: MaterialApp(
        theme: capture ? theme.copyWith(textTheme: theme.textTheme.apply(fontFamily: 'T67Capture')) : theme,
        builder: (context, child) => MediaQuery(data: MediaQuery.of(context).copyWith(textScaler: const TextScaler.linear(1.5)), child: child!),
        home: Scaffold(body: SingleChildScrollView(padding: const EdgeInsets.all(20), child: const Column(children: [AboutPanel(), AboutPanel(details: true)]))),
      )));
      await tester.pumpAndSettle();
      expect(find.text('测试版未签名'), findsOneWidget);
      expect(find.text('DreamFlutter 0.6.0-test.1'), findsOneWidget);
      expect(backend.callsTo('updates.check'), isEmpty);
      expect(backend.callsTo('app.setStartup'), isEmpty);
      expect((tester.widgetList<SwitchListTile>(find.byType(SwitchListTile))).map((item) => item.value), [true, false]);
      if (capture) await expectLater(find.byType(Scaffold), matchesGoldenFile('../../Claude Codex Bridge/T67-about-${brightness.name}-150.png'));
      Future<void> tap(String text) async { await tester.ensureVisible(find.text(text).last); await tester.pumpAndSettle(); await tester.tap(find.text(text).last); await tester.pumpAndSettle(); }
      await tap('安装并重启');
      expect(find.textContaining('测试版更新包未获受信任的正式签名'), findsOneWidget);
      expect(backend.callsTo('updates.install'), isEmpty);
      await tap('取消'); expect(backend.callsTo('updates.install'), isEmpty);
      await tap('安装并重启'); await tap('确认安装并重启');
      expect(backend.callsTo('updates.install').single['approveUnsigned'], true);
      expect(backend.callsTo('updates.install').single['windowPid'], pid);
      await tap('自动检查更新'); expect(backend.settings['autoCheckUpdates'], false);
      await tap('开机启动'); expect(backend.callsTo('app.setStartup').last['enabled'], true);
      await tap('开机启动'); expect(backend.callsTo('app.setStartup').last['enabled'], false);
      expect(find.text('关闭窗口时'), findsNothing, reason: '0.8.1 S.4: only in 通用');
      await tap('导出诊断信息'); expect(find.textContaining('不会自动上传'), findsOneWidget);
      expect(find.text('数据备份与恢复'), findsNothing);
      await tap('许可证与第三方声明'); await tap('Synthetic dependency 1.2.3');
      expect(find.text('Synthetic license text from the generated package'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }
}
