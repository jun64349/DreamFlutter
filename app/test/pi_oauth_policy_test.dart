import 'dart:io';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/gateway_pages.dart';
import 'package:dreamflutter/ui/pi_compatibility_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'fake_backend.dart';

void main() {
  for (final brightness in Brightness.values) {
    testWidgets('only ChatGPT can sign in; retained OAuth is read-only and can exit at 150% in $brightness', (tester) async {
      await tester.binding.setSurfaceSize(const Size(560, 1050)); addTearDown(() => tester.binding.setSurfaceSize(null));
      SharedPreferences.setMockInitialValues({});
      const capture = bool.fromEnvironment('T70_CAPTURE');
      if (capture) {
        await tester.runAsync(() async {
          for (final font in [('T70Capture', 'C:/Windows/Fonts/msyh.ttc'), ('MaterialIcons', 'E:/dev/flutter/bin/cache/artifacts/material_fonts/materialicons-regular.otf')]) {
            final loader = FontLoader(font.$1)..addFont(Future.value(ByteData.sublistView(await File(font.$2).readAsBytes()))); await loader.load();
          }
        });
      }
      final root = Directory.systemTemp.createTempSync('df-t70-widget-'), backend = FakeBackend();
      final rows = <Json>[
        {'id': 'api', 'provider': 'df-api', 'name': 'API key channel', 'source': 'df', 'models': [], 'keys': []},
        {'id': 'pi:openai-codex', 'provider': 'openai-codex', 'name': 'Retained Codex legacy', 'source': 'pi', 'oauth': true, 'enabled': true, 'models': [], 'keys': []},
        {'id': 'pi:github-copilot', 'provider': 'github-copilot', 'name': 'Hidden Copilot', 'source': 'pi', 'oauth': true, 'enabled': false, 'models': [], 'keys': []},
        {'id': 'pi:future', 'provider': 'future-oauth', 'name': 'Hidden future OAuth', 'source': 'pi', 'oauth': true, 'enabled': false, 'models': [], 'keys': []},
      ];
      backend.handlers['gateway.channels'] = (_) => rows; backend.handlers['gateway.groups'] = (_) => <Json>[];
      backend.handlers['piMigration.oauthLogout'] = (p) { rows[1]['enabled'] = false; return {'ok': true}; };
      final agent = AgentController(preferences: await Preferences.load(), sessionStore: SessionStore(sessionsDir: root.path), backend: backend);
      addTearDown(() { agent.dispose(); root.deleteSync(recursive: true); }); await agent.refreshGateway();
      final theme = buildTheme(brightness);
      await tester.pumpWidget(AgentScope(controller: agent, child: MaterialApp(theme: capture ? theme.copyWith(textTheme: theme.textTheme.apply(fontFamily: 'T70Capture')) : theme,
        builder: (context, child) => MediaQuery(data: MediaQuery.of(context).copyWith(textScaler: const TextScaler.linear(1.5)), child: child!),
        home: const Scaffold(body: SingleChildScrollView(padding: EdgeInsets.all(16), child: ChannelList())),
      ))); await tester.pumpAndSettle();
      expect(find.text('API key channel'), findsOneWidget); expect(find.text('Retained Codex legacy'), findsOneWidget);
      expect(find.text('Hidden Copilot'), findsNothing); expect(find.text('Hidden future OAuth'), findsNothing);
      expect(find.text('登录 ChatGPT'), findsOneWidget); expect(find.text('重新登录'), findsNothing);
      expect(backend.callsTo('piMigration.oauthStart'), isEmpty);
      if (capture) { await expectLater(find.byType(Scaffold), matchesGoldenFile('../../Claude Codex Bridge/T70-oauth-${brightness.name}-150.png')); }
      await tester.ensureVisible(find.text('查看登录与退出')); await tester.pumpAndSettle(); await tester.tap(find.text('查看登录与退出')); await tester.pumpAndSettle();
      expect(find.descendant(of: find.byType(AlertDialog), matching: find.byType(FilledButton)), findsNothing);
      expect(find.descendant(of: find.byType(AlertDialog), matching: find.byType(TextField)), findsNothing);
      await tester.tap(find.text('退出登录')); await tester.pumpAndSettle();
      expect(backend.callsTo('piMigration.oauthLogout').single['provider'], 'openai-codex'); expect(backend.callsTo('piMigration.oauthStart'), isEmpty);
      expect(find.text('已退出登录；此服务商不再支持重新登录。'), findsOneWidget);
      await tester.tap(find.text('关闭')); await agent.refreshGateway(); await tester.pumpAndSettle();
      expect(find.text('Retained Codex legacy'), findsNothing); expect(find.text('登录 ChatGPT'), findsOneWidget);
      expect(backend.callsTo('gateway.saveChannel'), isEmpty); expect(backend.callsTo('gateway.removeChannel'), isEmpty); expect(tester.takeException(), isNull);
    });
  }
  testWidgets('new ChatGPT entry logs in, cancels and retries with only the whitelisted provider', (tester) async {
    expect(chatGptPiProviderId, 'openai'); expect(canLoginPiOAuth('openai-codex'), isFalse);
    SharedPreferences.setMockInitialValues({}); final root = Directory.systemTemp.createTempSync('df-t70-chatgpt-'), backend = FakeBackend();
    backend.handlers['gateway.channels'] = (_) => <Json>[]; backend.handlers['gateway.groups'] = (_) => <Json>[];
    backend.handlers['piMigration.oauthStart'] = (_) => {'id': 't70-flow'};
    backend.handlers['piMigration.oauthStatus'] = (_) => {'id': 't70-flow', 'provider': chatGptPiProviderId, 'status': 'running', 'prompt': {'type': 'manual_code', 'message': 'Synthetic code'}};
    backend.handlers['piMigration.oauthCancel'] = (_) { backend.push({'event': 'piMigration.oauth', 'login': {'id': 't70-flow', 'provider': chatGptPiProviderId, 'status': 'cancelled'}}); return {'ok': true}; };
    backend.handlers['piMigration.oauthAnswer'] = (_) { backend.push({'event': 'piMigration.oauth', 'login': {'id': 't70-flow', 'provider': chatGptPiProviderId, 'status': 'done'}}); return {'ok': true}; };
    backend.handlers['piMigration.oauthLogout'] = (_) => {'ok': true};
    final agent = AgentController(preferences: await Preferences.load(), sessionStore: SessionStore(sessionsDir: root.path), backend: backend);
    addTearDown(() { agent.dispose(); root.deleteSync(recursive: true); }); await agent.refreshGateway();
    await tester.pumpWidget(AgentScope(controller: agent, child: MaterialApp(theme: buildTheme(Brightness.light), home: const Scaffold(body: SingleChildScrollView(child: ChannelList()))))); await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('登录 ChatGPT')); await tester.pumpAndSettle(); await tester.tap(find.text('登录 ChatGPT')); await tester.pumpAndSettle(); expect(backend.callsTo('piMigration.oauthStart'), isEmpty);
    await tester.tap(find.widgetWithText(FilledButton, '登录 ChatGPT')); await tester.pumpAndSettle();
    await tester.tap(find.text('取消登录')); await tester.pumpAndSettle(); expect(backend.callsTo('piMigration.oauthCancel').single['id'], 't70-flow');
    await tester.tap(find.widgetWithText(FilledButton, '登录 ChatGPT')); await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'T70_SYNTHETIC_CODE'); await tester.tap(find.text('继续登录')); await tester.pumpAndSettle();
    expect(find.text('状态：done'), findsOneWidget); expect(find.text('T70_SYNTHETIC_CODE'), findsNothing);
    await tester.tap(find.text('退出登录')); await tester.pumpAndSettle(); expect(find.text('状态：logged_out'), findsOneWidget);
    expect(backend.callsTo('piMigration.oauthStart').map((p) => p['provider']), [chatGptPiProviderId, chatGptPiProviderId]);
    expect(backend.callsTo('piMigration.oauthLogout').single['provider'], chatGptPiProviderId); expect(tester.takeException(), isNull);
  });
}
