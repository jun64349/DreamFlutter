import 'dart:io';

import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/security_panel.dart';
import 'package:dreamflutter/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';

void main() {
  for (final brightness in Brightness.values) {
    testWidgets('security exceptions, audit and failures at 150% in $brightness', (tester) async {
      await tester.binding.setSurfaceSize(const Size(650, 1000));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      SharedPreferences.setMockInitialValues({});
      const capture = bool.fromEnvironment('T63_CAPTURE');
      if (capture) {
        await tester.runAsync(() async {
          final loader = FontLoader('T63Capture')..addFont(Future.value(ByteData.sublistView(await File('C:/Windows/Fonts/msyh.ttc').readAsBytes())));
          await loader.load();
        });
      }
      final dir = Directory.systemTemp.createTempSync('df-security-widget-');
      final backend = FakeBackend();
      final paths = <String>[];
      var failed = false;
      backend.handlers['security.exceptions'] = (_) { if (failed) throw CoreException('synthetic', '无法读取安全设置，请重试'); return {'paths': paths.toList()}; };
      backend.handlers['security.audit'] = (_) => {'events': <Json>[{'time': 1794000000000, 'policy': 'T63-1', 'kind': 'path', 'object': 'synthetic.env', 'decision': 'deny', 'reason': '环境凭据文件', 'runId': 'synthetic-run'}]};
      backend.handlers['security.addException'] = (params) { paths.add(params['path'] as String); return {'ok': true}; };
      backend.handlers['security.removeException'] = (params) { paths.remove(params['path']); return {'ok': true}; };
      backend.handlers['security.export'] = (_) => {'text': '{"object":"〔已遮盖：疑似密钥〕"}'};
      final previousDestination = chooseSecurityAuditDestination;
      chooseSecurityAuditDestination = () async => '${dir.path}/audit.jsonl';
      addTearDown(() => chooseSecurityAuditDestination = previousDestination);
      final agent = AgentController(preferences: await Preferences.load(), sessionStore: SessionStore(sessionsDir: dir.path), backend: backend)..workspace = dir.path;
      addTearDown(() { agent.dispose(); dir.deleteSync(recursive: true); });
      await tester.pumpWidget(AgentScope(controller: agent, child: MaterialApp(
        theme: capture ? buildTheme(brightness).copyWith(textTheme: buildTheme(brightness).textTheme.apply(fontFamily: 'T63Capture')) : buildTheme(brightness),
        builder: (context, child) => MediaQuery(data: MediaQuery.of(context).copyWith(textScaler: const TextScaler.linear(1.5)), child: child!),
        home: const Scaffold(body: SingleChildScrollView(child: SecurityPanel())),
      )));
      await tester.pumpAndSettle();
      expect(find.text('还没有例外'), findsOneWidget);
      await tester.tap(find.text('添加')); await tester.pumpAndSettle();
      expect(find.text('请填写要允许的文件或目录路径'), findsOneWidget);
      expect(backend.callsTo('security.addException'), isEmpty);
      await tester.enterText(find.byType(TextField), '.env.synthetic');
      await tester.tap(find.text('添加')); await tester.pumpAndSettle();
      expect(backend.callsTo('security.addException').single['cwd'], dir.path);
      expect(find.text('.env.synthetic'), findsOneWidget);
      await tester.tap(find.byTooltip('删除路径例外')); await tester.pumpAndSettle();
      expect(paths, isEmpty);
      await tester.ensureVisible(find.text('最近 1 条记录'));
      await tester.tap(find.text('最近 1 条记录')); await tester.pumpAndSettle();
      expect(find.text('path · deny'), findsOneWidget);
      expect(find.textContaining('synthetic-run'), findsOneWidget);
      failed = true;
      await tester.ensureVisible(find.byTooltip('刷新记录')); await tester.tap(find.byTooltip('刷新记录')); await tester.pumpAndSettle();
      expect(find.text('无法读取安全设置，请重试'), findsOneWidget);
      failed = false;
      await tester.tap(find.byTooltip('刷新记录')); await tester.pumpAndSettle();
      expect(find.text('无法读取安全设置，请重试'), findsNothing);
      await tester.ensureVisible(find.text('导出审计…'));
      await tester.tap(find.text('导出审计…'));
      for (var i = 0; i < 100; i++) {
        await tester.pump();
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
        if (find.textContaining('审计已导出：').evaluate().isNotEmpty) break;
      }
      await tester.pumpAndSettle();
      expect(find.textContaining('审计已导出：'), findsOneWidget);
      expect(File('${dir.path}/audit.jsonl').readAsStringSync(), contains('〔已遮盖：疑似密钥〕'));
      if (capture) {
        await tester.ensureVisible(find.text('路径例外'));
        await tester.pumpAndSettle();
        await expectLater(find.byType(Scaffold), matchesGoldenFile('../../Claude Codex Bridge/T63-security-${brightness.name}-150.png'));
      }
      expect(tester.takeException(), isNull);
    });
  }
}
