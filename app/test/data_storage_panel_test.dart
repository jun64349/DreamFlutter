import 'dart:io';

import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/data_storage_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';

void main() {
  for (final brightness in Brightness.values) {
    testWidgets('memory storage saves threshold, confirms compression and refreshes space in $brightness at 150%', (tester) async {
      await tester.binding.setSurfaceSize(const Size(500, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      SharedPreferences.setMockInitialValues({});
      final sessions = Directory.systemTemp.createTempSync('df-storage-widget-');
      final backend = FakeBackend();
      var paused = false;
      var deleted = 0;
      backend.handlers['storage.memory'] = (_) => {
        'path': '${sessions.path}/core.db', 'logicalBytes': 1000, 'databaseBytes': 10000, 'versions': 15 - deleted,
        'space': {'paused': paused, 'reason': paused ? '磁盘空间不足，记忆写入已暂停' : null,
          'freeBytes': 2048, 'minimumBytes': backend.settings['memoryMinFreeBytes'] ?? 1073741824},
      };
      backend.handlers['storage.compactMemory'] = (_) {
        deleted = 4;
        return {'deleted': deleted, 'backup': '${sessions.path}/backup.db'};
      };
      final agent = AgentController(preferences: await Preferences.load(), sessionStore: SessionStore(sessionsDir: sessions.path), backend: backend);
      addTearDown(() { agent.dispose(); sessions.deleteSync(recursive: true); });
      await tester.pumpWidget(AgentScope(controller: agent, child: MaterialApp(
        theme: ThemeData(brightness: brightness),
        builder: (context, child) => MediaQuery(data: MediaQuery.of(context).copyWith(textScaler: const TextScaler.linear(1.5)), child: child!),
        home: const Scaffold(body: SingleChildScrollView(child: Padding(padding: EdgeInsets.all(16), child: DataStoragePanel()))),
      )));
      await tester.pumpAndSettle();
      expect(find.textContaining('15 个历史版本'), findsOneWidget);
      await tester.enterText(find.byType(TextField), '-1');
      await tester.tap(find.text('保存阈值')); await tester.pumpAndSettle();
      expect(find.textContaining('请输入有效'), findsOneWidget);
      expect(backend.callsTo('settings.update'), isEmpty);
      await tester.enterText(find.byType(TextField), '2.5');
      await tester.tap(find.text('保存阈值')); await tester.pumpAndSettle();
      expect(backend.callsTo('settings.update').last['memoryMinFreeBytes'], 2684354560);
      await tester.ensureVisible(find.text('压缩历史…'));
      await tester.tap(find.text('压缩历史…')); await tester.pumpAndSettle();
      expect(backend.callsTo('storage.compactMemory'), isEmpty);
      await tester.tap(find.text('取消')); await tester.pumpAndSettle();
      expect(backend.callsTo('storage.compactMemory'), isEmpty);
      await tester.tap(find.text('压缩历史…')); await tester.pumpAndSettle();
      await tester.tap(find.text('备份并压缩')); await tester.pumpAndSettle();
      expect(backend.callsTo('storage.compactMemory'), hasLength(1));
      expect(find.textContaining('已删除 4 个旧版本'), findsOneWidget);
      paused = true; backend.push({'event': 'memory.storage'}); await tester.pumpAndSettle();
      expect(find.text('磁盘空间不足，记忆写入已暂停'), findsOneWidget);
      paused = false; backend.push({'event': 'memory.storage'}); await tester.pumpAndSettle();
      expect(find.text('磁盘空间不足，记忆写入已暂停'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('sandbox busy receipt is readable after reopening and after polling in $brightness at 150%', (tester) async {
      await tester.binding.setSurfaceSize(const Size(500, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      SharedPreferences.setMockInitialValues({});
      final temporary = Directory.systemTemp.createTempSync('df-storage-busy-widget-');
      final backend = FakeBackend();
      await backend.connect();
      const message = '蝶君沙箱正被其他程序占用。它是本机默认的 WSL 系统，终端、编辑器等调用 WSL 的程序会把它启动。请关闭这些程序后再试。原位置的数据没有改动。';
      Json? outcome = {'id': 'old-busy', 'kind': 'sandbox', 'ok': false, 'reasonCode': 'sandbox_in_use', 'error': 'ERROR_SHARING_VIOLATION'};
      backend.handlers['storage.memory'] = (_) => {'path': '${temporary.path}/core.db', 'space': {'minimumBytes': 0}};
      backend.handlers['storage.locations'] = (_) => {
        'rows': [{'id': 'sandbox', 'label': '沙箱', 'layer': '应用数据', 'path': temporary.path, 'bytes': 1024, 'movable': true}],
        'artifacts': [], 'lastMove': outcome,
      };
      backend.handlers['storage.move'] = (_) => {'id': 'new-busy', 'restarting': true};
      final agent = AgentController(preferences: await Preferences.load(), sessionStore: SessionStore(sessionsDir: temporary.path), backend: backend);
      addTearDown(() { agent.dispose(); temporary.deleteSync(recursive: true); });
      Widget frame(String key) => AgentScope(controller: agent, child: MaterialApp(
        theme: ThemeData(brightness: brightness),
        builder: (context, child) => MediaQuery(data: MediaQuery.of(context).copyWith(textScaler: const TextScaler.linear(1.5)), child: child!),
        home: Scaffold(body: SingleChildScrollView(child: Padding(padding: const EdgeInsets.all(16), child: DataStoragePanel(key: ValueKey(key))))),
      ));
      await tester.pumpWidget(frame('busy')); await tester.pumpAndSettle();
      expect(find.text(message), findsOneWidget, reason: 'persisted lastMove uses the same plain-language message');
      expect(find.textContaining('ERROR_SHARING_VIOLATION'), findsNothing);
      final button = find.text('修改沙箱位置…');
      await tester.ensureVisible(button); await tester.pumpAndSettle();
      await tester.tap(button); await tester.pumpAndSettle();
      await tester.enterText(find.widgetWithText(TextField, '目标新目录（绝对路径）'), '${temporary.path}/new-sandbox');
      await tester.tap(find.text('搬迁并重启')); await tester.pump(const Duration(milliseconds: 700));
      expect(find.text('后台正在重启并验证搬迁，请稍候…'), findsOneWidget);
      outcome = {'id': 'new-busy', 'kind': 'sandbox', 'ok': false, 'reasonCode': 'sandbox_in_use', 'error': 'ERROR_SHARING_VIOLATION'};
      await tester.pump(const Duration(seconds: 1)); await tester.pumpAndSettle();
      expect(find.text(message), findsWidgets, reason: 'live polling also maps the structured reason');
      expect(find.textContaining('ERROR_SHARING_VIOLATION'), findsNothing);
      expect(find.text('后台正在重启并验证搬迁，请稍候…'), findsNothing);
      expect(backend.callsTo('storage.move').single, {'kind': 'sandbox', 'target': '${temporary.path}/new-sandbox'});
      for (final entry in [
        {'kind': 'sandbox', 'error': '旧版失败回执'},
        {'kind': 'sandbox', 'reasonCode': 'access_denied', 'error': '权限不足'},
        {'kind': 'database', 'reasonCode': 'sandbox_in_use', 'error': '数据库失败'},
      ]) {
        outcome = {'id': 'fallback', 'ok': false, ...entry};
        await tester.pumpWidget(frame('${entry['error']}')); await tester.pumpAndSettle();
        expect(find.text('上次搬迁失败，已回退：${entry['error']}'), findsOneWidget);
        expect(find.text(message), findsNothing, reason: 'legacy/unknown/other-kind receipts keep their own errors');
      }
      expect(tester.takeException(), isNull);
    });

    testWidgets('locations move memory with DB, leave workspace artifacts and report restart outcome in $brightness at 150%', (tester) async {
      await tester.binding.setSurfaceSize(const Size(500, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      SharedPreferences.setMockInitialValues({});
      final temporary = Directory.systemTemp.createTempSync('df-storage-locations-widget-');
      final backend = FakeBackend();
      await backend.connect();
      Json? outcome;
      var fail = false;
      var failureMessage = '目标目录已存在，请选择新目录';
      backend.handlers['storage.memory'] = (_) => {'path': '${temporary.path}/core.db', 'space': {'minimumBytes': 0}};
      backend.handlers['storage.locations'] = (_) => {
        'rows': [{'id': 'database', 'label': '后台数据库', 'layer': '应用数据', 'path': temporary.path, 'bytes': 1024, 'movable': true}],
        'artifacts': [{'path': '${temporary.path}/workspace/result.txt', 'bytes': 7, 'movable': false}], 'lastMove': outcome,
      };
      backend.handlers['storage.move'] = (_) {
        if (fail) throw CoreException('bad_request', failureMessage);
        return {'id': 'move-1', 'restarting': true};
      };
      final agent = AgentController(preferences: await Preferences.load(), sessionStore: SessionStore(sessionsDir: temporary.path), backend: backend);
      addTearDown(() { agent.dispose(); temporary.deleteSync(recursive: true); });
      await tester.pumpWidget(AgentScope(controller: agent, child: MaterialApp(
        theme: ThemeData(brightness: brightness),
        builder: (context, child) => MediaQuery(data: MediaQuery.of(context).copyWith(textScaler: const TextScaler.linear(1.5)), child: child!),
        home: const Scaffold(body: SingleChildScrollView(child: Padding(padding: EdgeInsets.all(16), child: DataStoragePanel()))),
      )));
      await tester.pumpAndSettle();
      expect(find.textContaining('产物（位于工作区'), findsOneWidget);
      expect(find.textContaining('修改产物位置'), findsNothing);
      final button = find.text('修改记忆位置（随数据库）…');
      await tester.ensureVisible(button); await tester.pumpAndSettle();
      await tester.tap(button); await tester.pumpAndSettle();
      await tester.tap(find.text('取消')); await tester.pumpAndSettle();
      await tester.pump(const Duration(milliseconds: 300));
      expect(backend.callsTo('storage.move'), isEmpty);
      await tester.tap(button); await tester.pumpAndSettle();
      await tester.enterText(find.widgetWithText(TextField, '目标新目录（绝对路径）'), '${temporary.path}/new-db');
      fail = true;
      await tester.tap(find.text('搬迁并重启')); await tester.pumpAndSettle(); await tester.pump(const Duration(milliseconds: 300)); await tester.pumpAndSettle();
      expect(find.text('目标目录已存在，请选择新目录'), findsOneWidget);
      failureMessage = '数据库位置不支持网络路径，请选择本地磁盘上的新目录';
      await tester.tap(button); await tester.pumpAndSettle();
      expect(find.textContaining('不支持网络路径或映射网络盘'), findsOneWidget);
      await tester.enterText(find.widgetWithText(TextField, '目标新目录（绝对路径）'), r'\\wsl.localhost\df-test\new-db');
      await tester.tap(find.text('搬迁并重启')); await tester.pumpAndSettle();
      await tester.pump(const Duration(milliseconds: 400)); await tester.pumpAndSettle();
      expect(find.text(failureMessage), findsOneWidget);
      expect(find.text('后台正在重启并验证搬迁，请稍候…'), findsNothing);
      expect(backend.callsTo('storage.move').last['target'], r'\\wsl.localhost\df-test\new-db');
      fail = false;
      await tester.tap(button); await tester.pumpAndSettle();
      await tester.enterText(find.widgetWithText(TextField, '目标新目录（绝对路径）'), '${temporary.path}/new-db');
      await tester.tap(find.text('搬迁并重启')); await tester.pump(const Duration(milliseconds: 600)); await tester.pump(const Duration(milliseconds: 100));
      expect(backend.callsTo('storage.move').last, {'kind': 'database', 'target': '${temporary.path}/new-db'});
      expect(find.text('后台正在重启并验证搬迁，请稍候…'), findsOneWidget);
      outcome = {'id': 'move-1', 'ok': true, 'path': '${temporary.path}/new-db', 'backup': '${temporary.path}/backup.db'};
      await tester.pump(const Duration(seconds: 1)); await tester.pumpAndSettle();
      expect(find.textContaining('搬迁完成，已在新位置启动验证'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }
}
