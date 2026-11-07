import 'dart:io';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/package_sources_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'fake_backend.dart';

class SourceBackend extends FakeBackend {
  bool failSave = false;
  @override
  Future<Object?> call(String method, [Json params = const {}, Duration timeout = const Duration(seconds: 60)]) {
    if (method == 'settings.update' && failSave) throw CoreException('save_failed', '软件源保存失败，请重试');
    return super.call(method, params, timeout);
  }
}

void main() {
  for (final brightness in Brightness.values) {
    testWidgets('package sources persist choices, show layers and errors at 150% in $brightness', (tester) async {
      await tester.binding.setSurfaceSize(const Size(560, 1050));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      SharedPreferences.setMockInitialValues({});
      const capture = bool.fromEnvironment('T65_CAPTURE');
      if (capture) {
        await tester.runAsync(() async {
          final loader = FontLoader('T65Capture')..addFont(Future.value(ByteData.sublistView(await File('C:/Windows/Fonts/msyh.ttc').readAsBytes())));
          await loader.load();
        });
      }
      final dir = Directory.systemTemp.createTempSync('df-sources-widget-');
      final backend = SourceBackend();
      backend.handlers['packageSources.status'] = (_) => {
        'nextHost': {'uv': {'layer': 'project'}, 'pip': {'layer': 'application'}, 'npm': {'layer': 'existing'}},
        'recent': {'sandbox': {'uv': {'layer': 'application'}, 'pip': {'layer': 'project'}, 'npm': {'layer': 'existing'}}},
      };
      final agent = AgentController(preferences: await Preferences.load(), sessionStore: SessionStore(sessionsDir: dir.path), backend: backend);
      addTearDown(() { agent.dispose(); dir.deleteSync(recursive: true); });
      final theme = buildTheme(brightness);
      await tester.pumpWidget(AgentScope(controller: agent, child: MaterialApp(
        theme: capture ? theme.copyWith(textTheme: theme.textTheme.apply(fontFamily: 'T65Capture')) : theme,
        builder: (context, child) => MediaQuery(data: MediaQuery.of(context).copyWith(textScaler: const TextScaler.linear(1.5)), child: child!),
        home: const Scaffold(body: SingleChildScrollView(padding: EdgeInsets.all(20), child: PackageSourcesPanel())),
      )));
      await tester.pumpAndSettle();
      expect(backend.callsTo('settings.update'), isEmpty);
      expect(find.text('跟随现有配置（默认）'), findsNWidgets(2));
      expect(find.text('下一条工作台命令：uv：项目配置 · pip：应用设置 · npm：跟随现有'), findsOneWidget);
      Future<void> choose(int index, String label) async {
        final dropdown = find.byType(DropdownButtonFormField<String>).at(index);
        await tester.ensureVisible(dropdown); await tester.pumpAndSettle();
        await tester.tap(dropdown); await tester.pumpAndSettle();
        await tester.tap(find.text(label).last); await tester.pumpAndSettle();
      }
      await choose(0, '清华 TUNA');
      expect(backend.settings['pythonPackageSource'], 'tuna');
      await choose(1, 'npmmirror');
      expect(backend.settings['npmPackageSource'], 'npmmirror');
      expect(backend.callsTo('settings.update').first, {'pythonPackageSource': 'tuna'});
      expect(find.text('只影响 DreamFlutter 启动的工具；项目自己指定的源优先；新命令开始生效。'), findsOneWidget);
      if (capture) {
        await tester.ensureVisible(find.text('工具软件源')); await tester.pumpAndSettle();
        await expectLater(find.byType(Scaffold), matchesGoldenFile('../../Claude Codex Bridge/T65-B-${brightness.name}-150.png'));
      }
      backend.failSave = true;
      await choose(0, '官方 PyPI');
      expect(backend.settings['pythonPackageSource'], 'tuna');
      expect(find.textContaining('软件源保存失败'), findsOneWidget);
      expect(find.text('清华 TUNA'), findsOneWidget);
      backend.failSave = false;
      await choose(0, '跟随现有配置（默认）');
      expect(backend.settings['pythonPackageSource'], 'inherit');
      expect(find.textContaining('软件源保存失败'), findsNothing);
      expect(tester.takeException(), isNull);
    });
  }
}
