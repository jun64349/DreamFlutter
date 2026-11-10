import 'dart:io';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/gateway_pages.dart';
import 'package:dreamflutter/ui/pi_compatibility_panel.dart';
import 'package:dreamflutter/ui/providers_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'fake_backend.dart';

void main() {
  for (final brightness in Brightness.values) {
    testWidgets('Pi migration retry, external backup, read-only import and unresolved references fit 150% $brightness', (tester) async {
      await tester.binding.setSurfaceSize(const Size(800, 1200));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      SharedPreferences.setMockInitialValues({});
      final root = Directory.systemTemp.createTempSync('df-t66-widget-');
      final backend = FakeBackend();
      var done = false, external = false;
      Json status() => {'status': done ? 'done' : 'failed', 'path': '${root.path}/agent/models.json', 'backup': '${root.path}/backup', 'defaultImportFolder': '${root.path}/import',
        'command': "\$env:PI_CODING_AGENT_DIR='${root.path}/agent'; pi", 'generatedAt': 1794010000000, 'externalModified': external,
        if (!done) 'error': '合成迁移失败，文件已恢复', if (done) 'externalBackup': '${root.path}/external.json', 'unresolved': ['unknown/missing'],
        if (done) 'results': [{'provider': 'existing', 'status': '已有映射，跳过；不覆盖渠道'}]};
      backend.handlers['piMigration.status'] = (_) => status();
      backend.handlers['piMigration.retry'] = (_) { done = true; return status(); };
      backend.handlers['piMigration.import'] = (p) { expect(p['folder'], '${root.path}/import'); return status(); };
      backend.handlers['piMigration.generate'] = (_) { external = false; return status(); };
      final agent = AgentController(preferences: await Preferences.load(), sessionStore: SessionStore(sessionsDir: root.path), backend: backend);
      addTearDown(() { agent.dispose(); root.deleteSync(recursive: true); });
      const capture = bool.fromEnvironment('T66_CAPTURE');
      if (capture) {
        await tester.runAsync(() async { final loader = FontLoader('T66Capture')..addFont(Future.value(ByteData.sublistView(await File('C:/Windows/Fonts/msyh.ttc').readAsBytes()))); await loader.load(); });
      }
      final theme = buildTheme(brightness);
      await tester.pumpWidget(AgentScope(controller: agent, child: MaterialApp(
        theme: capture ? theme.copyWith(textTheme: theme.textTheme.apply(fontFamily: 'T66Capture')) : theme,
        builder: (context, child) => MediaQuery(data: MediaQuery.of(context).copyWith(textScaler: const TextScaler.linear(1.5)), child: child!),
        home: Scaffold(body: SingleChildScrollView(child: PiCompatibilityPanel(pickFolder: (initial) async { expect(initial, '${root.path}/import'); return initial; }))),
      )));
      await tester.pumpAndSettle();
      expect(find.text('迁移失败 · 原有配置页仍可用'), findsOneWidget);
      expect(find.text('打开原有配置页'), findsOneWidget);
      await tester.tap(find.text('重试迁移')); await tester.pumpAndSettle();
      expect(find.text('已迁入渠道 · 兼容配置由渠道生成'), findsOneWidget);
      expect(find.text('打开原有配置页'), findsNothing);
      expect(find.text('unknown/missing'), findsOneWidget);
      await tester.ensureVisible(find.text('从原配置导入')); await tester.tap(find.text('从原配置导入')); await tester.pumpAndSettle();
      expect(backend.callsTo('piMigration.import'), hasLength(1));
      expect(find.textContaining('已有映射，跳过'), findsOneWidget);
      external = true;
      await tester.ensureVisible(find.text('刷新迁移状态')); await tester.tap(find.text('刷新迁移状态')); await tester.pumpAndSettle();
      expect(find.text('检测到外部修改；重新生成前会先备份。'), findsOneWidget);
      await tester.ensureVisible(find.text('重新生成')); await tester.tap(find.text('重新生成')); await tester.pumpAndSettle();
      expect(find.textContaining('检测到外部修改，已备份到'), findsOneWidget);
      if (capture) {
        await tester.ensureVisible(find.text('原有连接配置')); await tester.pumpAndSettle();
        await expectLater(find.byType(Scaffold), matchesGoldenFile('../../Claude Codex Bridge/T66-pi-${brightness.name}-150.png'));
      }
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('successful migration redirects the legacy entry, exposes origin and keeps ChatGPT login and logout', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1100, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    SharedPreferences.setMockInitialValues({});
    final root = Directory.systemTemp.createTempSync('df-t66-oauth-widget-'), backend = FakeBackend();
    backend.handlers['piMigration.status'] = (_) => {'status': 'done', 'path': '${root.path}/models.json', 'command': 'synthetic command'};
    backend.handlers['gateway.channels'] = (_) => [
      {'id': 'p1', 'provider': 'df-p1', 'name': 'Imported', 'origin': 'cc-switch', 'models': [{'id': 'a'}], 'keys': []},
      {'id': 'pi:openai', 'provider': 'openai', 'name': 'ChatGPT', 'source': 'pi', 'oauth': true, 'models': [], 'keys': []},
    ];
    backend.handlers['gateway.groups'] = (_) => <Json>[];
    backend.handlers['piMigration.oauthStart'] = (_) => {'id': 'test-flow'};
    backend.handlers['piMigration.oauthStatus'] = (_) => {'id': 'test-flow', 'provider': 'openai', 'status': 'running', 'event': {'url': 'https://example.invalid/login'}, 'prompt': {'type': 'manual_code', 'message': '合成登录步骤'}};
    backend.handlers['piMigration.oauthAnswer'] = (_) { backend.push({'event': 'piMigration.oauth', 'login': {'id': 'test-flow', 'provider': 'openai', 'status': 'done'}}); return {'ok': true}; };
    final agent = AgentController(preferences: await Preferences.load(), sessionStore: SessionStore(sessionsDir: root.path), backend: backend);
    addTearDown(() { agent.dispose(); root.deleteSync(recursive: true); });
    await agent.refreshGateway();
    await tester.pumpWidget(AgentScope(controller: agent, child: MaterialApp(theme: buildTheme(Brightness.light), home: const ProvidersPage())));
    await tester.pumpAndSettle();
    expect(find.byType(ChannelManagementPage), findsOneWidget);
    expect(find.text('Imported'), findsOneWidget);
    await tester.ensureVisible(find.text('管理 ChatGPT 登录')); await tester.tap(find.text('管理 ChatGPT 登录')); await tester.pumpAndSettle();
    await tester.tap(find.text('重新登录')); await tester.pumpAndSettle();
    expect(find.text('https://example.invalid/login'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'T66_SYNTHETIC_CODE'); await tester.tap(find.text('继续登录')); await tester.pumpAndSettle();
    expect(find.text('状态：done'), findsOneWidget);
    expect(find.text('T66_SYNTHETIC_CODE'), findsNothing);
    await tester.tap(find.text('退出登录')); await tester.pumpAndSettle();
    expect(backend.callsTo('piMigration.oauthLogout'), hasLength(1)); expect(find.text('状态：logged_out'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
