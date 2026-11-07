import 'dart:io';

import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/web_search_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';

void main() {
  for (final brightness in Brightness.values) {
    testWidgets('web settings save mask, choose backend, explicitly test and delete at 150% in $brightness', (tester) async {
      await tester.binding.setSurfaceSize(const Size(650, 1150));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      SharedPreferences.setMockInitialValues({});
      const capture = bool.fromEnvironment('T64_CAPTURE');
      if (capture) {
        await tester.runAsync(() async {
          final loader = FontLoader('T64Capture')..addFont(Future.value(ByteData.sublistView(await File('C:/Windows/Fonts/msyh.ttc').readAsBytes())));
          await loader.load();
        });
      }
      final dir = Directory.systemTemp.createTempSync('df-web-widget-');
      final backend = FakeBackend();
      var configured = false, selected = 'local', calls = 0;
      String? lastError;
      var fail = false;
      Json status() => {'configured': configured, 'backend': selected, 'lastError': lastError, 'month': '2026-11', 'usage': {'calls': calls, 'deepseekCalls': calls, 'billableCalls': calls, 'estimatedCostCny': calls * 0.005, 'uncertainCalls': 0}};
      backend.handlers['webSearch.status'] = (_) => status();
      backend.handlers['webSearch.saveKey'] = (_) { configured = true; return status(); };
      backend.handlers['webSearch.deleteKey'] = (_) { configured = false; selected = 'local'; lastError = null; return status(); };
      backend.handlers['webSearch.setBackend'] = (p) { selected = p['backend'] as String; return status(); };
      backend.handlers['webSearch.test'] = (_) {
        if (fail) { lastError = 'DeepSeek 官方账户余额不足，请充值后重试。'; throw CoreException('insufficient_balance', lastError!); }
        lastError = null; calls++; return {'count': 1, 'estimatedCostCny': 0.005};
      };
      final agent = AgentController(preferences: await Preferences.load(), sessionStore: SessionStore(sessionsDir: dir.path), backend: backend);
      addTearDown(() { agent.dispose(); dir.deleteSync(recursive: true); });
      final theme = buildTheme(brightness);
      await tester.pumpWidget(AgentScope(controller: agent, child: MaterialApp(
        theme: capture ? theme.copyWith(textTheme: theme.textTheme.apply(fontFamily: 'T64Capture')) : theme,
        builder: (context, child) => MediaQuery(data: MediaQuery.of(context).copyWith(textScaler: const TextScaler.linear(1.5)), child: child!),
        home: const Scaffold(body: SingleChildScrollView(child: WebSearchPanel())),
      )));
      await tester.pumpAndSettle();
      expect(find.text('未配置'), findsOneWidget);
      expect(tester.widget<OutlinedButton>(find.widgetWithText(OutlinedButton, '测试连接')).onPressed, isNull);
      expect(backend.callsTo('webSearch.test'), isEmpty);
      await tester.tap(find.text('保存密钥')); await tester.pumpAndSettle();
      expect(find.text('上次错误：请填写 DeepSeek 官方密钥'), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'T64_SYNTHETIC_UI_KEY');
      expect(tester.widget<TextField>(find.byType(TextField)).obscureText, isTrue);
      await tester.tap(find.text('保存密钥')); await tester.pumpAndSettle();
      expect(find.text('已配置 · 密钥已遮盖'), findsOneWidget);
      expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, isEmpty);
      expect(find.text('T64_SYNTHETIC_UI_KEY'), findsNothing);
      expect(backend.callsTo('webSearch.test'), isEmpty, reason: 'saving must not cause a paid request');
      await tester.ensureVisible(find.byType(DropdownButtonFormField<String>));
      await tester.tap(find.byType(DropdownButtonFormField<String>)); await tester.pumpAndSettle();
      await tester.tap(find.text('DeepSeek 抓取').last); await tester.pumpAndSettle();
      expect(selected, 'deepseek');
      await tester.ensureVisible(find.text('测试连接'));
      expect(find.textContaining('预计约 ¥0.005'), findsOneWidget);
      await tester.tap(find.text('测试连接')); await tester.pumpAndSettle();
      expect(backend.callsTo('webSearch.test'), hasLength(1));
      expect(find.textContaining('连接成功，返回 1 项结果'), findsOneWidget);
      fail = true;
      await tester.tap(find.text('测试连接')); await tester.pumpAndSettle();
      expect(find.textContaining('余额不足'), findsOneWidget);
      if (capture) {
        await tester.ensureVisible(find.text('联网搜索与抓取')); await tester.pumpAndSettle();
        await expectLater(find.byType(Scaffold), matchesGoldenFile('../../Claude Codex Bridge/T64-web-${brightness.name}-150.png'));
      }
      fail = false;
      await tester.ensureVisible(find.text('测试连接')); await tester.tap(find.text('测试连接')); await tester.pumpAndSettle();
      expect(find.textContaining('余额不足'), findsNothing);
      await tester.ensureVisible(find.text('删除…')); await tester.tap(find.text('删除…')); await tester.pumpAndSettle();
      await tester.tap(find.text('取消')); await tester.pumpAndSettle();
      expect(backend.callsTo('webSearch.deleteKey'), isEmpty);
      await tester.tap(find.text('删除…')); await tester.pumpAndSettle();
      await tester.tap(find.text('删除密钥')); await tester.pumpAndSettle();
      expect(find.text('未配置'), findsOneWidget);
      expect(selected, 'local');
      expect(tester.takeException(), isNull);
    });
  }
}
