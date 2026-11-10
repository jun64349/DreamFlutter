import 'dart:io';

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/ui/backup_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';

/// Settings › 数据与迁移 (v0.3.1 backup, migration and restore).
void main() {
  late FakeBackend backend;
  late AgentController agent;
  Json? restoreResult;

  Json overview() => {
    'busy': <String>[],
    'estimate': {'data': 1000, 'sessions': 2000, 'materials': 300},
    'estimateText': '3 KB',
    'materialsCount': 1,
    'materialsWarning': false,
    'sandbox': false,
    'autoBytes': 0,
    'history': [
      {'path': r'C:\备份\a.dfbackup', 'kind': 'manual', 'createdAt': 0, 'size': 4096, 'exists': true, 'auto': false},
    ],
  };

  Future<void> openPanel(WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(1400, 1600));
    SharedPreferences.setMockInitialValues({'workspace': Directory.systemTemp.path, 'onboarded': true, 'themeMode': 'light'});
    final sessions = Directory.systemTemp.createTempSync('df_backup_');
    backend = FakeBackend();
    backend.handlers.addAll({
      'backup.overview': (_) => overview(),
      'backup.restoreResult': (_) => restoreResult,
      'backup.ackResult': (_) => {'ok': true},
      'backup.export': (p) => {'id': 'j1', 'kind': 'export', 'status': 'running'},
      'backup.inspect': (_) => {
        'appVersion': '0.3.0',
        'createdAt': 0,
        'host': 'OLD-PC',
        'user': 'old',
        'kind': 'manual',
        'needsPassword': true,
        'counts': {'session_meta': 12, 'memories': 3},
        'includes': {'sandbox': false, 'materials': 0},
        'replaces': ['后台数据库'],
        'warnings': <String>[],
        'paths': [
          {'from': r'C:\Users\old\AppData\Roaming\DreamFlutter', 'to': r'C:\Users\new\AppData\Roaming\DreamFlutter', 'kind': 'platform', 'exists': true},
          {'from': r'D:\work', 'to': r'D:\work', 'kind': 'workspace', 'exists': false},
        ],
      },
      'backup.stage': (_) => {'id': 'j2', 'kind': 'stage', 'status': 'running'},
      'backup.apply': (_) => {'id': 'j3', 'kind': 'apply', 'status': 'running'},
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
    await tester.enterText(find.widgetWithText(TextField,'搜索设置'),'备份');
    await settle(tester);
  }

  testWidgets('exports with the window preferences, and asks for a matching migration password for keys', (tester) async {
    restoreResult = null;
    chooseBackupDestination = (name) async => r'C:\备份\new.dfbackup';
    await openPanel(tester);
    // One line and two buttons; options and the record are folded (v0.3.1 test 8).
    expect(find.textContaining('预计大小'), findsNothing);
    expect(find.textContaining('手动导出'), findsNothing);
    expect(find.text('1 份'), findsOneWidget);
    await tester.tap(find.text('备份记录'));
    await tester.pumpAndSettle();
    expect(find.textContaining('手动导出'), findsOneWidget);
    await tester.tap(find.text('导出选项'));
    await tester.pumpAndSettle();
    expect(find.textContaining('预计大小'), findsOneWidget);

    await tester.tap(find.text('包含 API Key'));
    await tester.pump();
    await tester.enterText(find.widgetWithText(TextField, '迁移密码（至少 6 位）'), 'abcdef');
    await tester.enterText(find.widgetWithText(TextField, '再输一次'), 'abcdeX');
    await tester.tap(find.text('导出备份…'));
    await settle(tester);
    expect(find.text('两次输入的迁移密码不一样'), findsOneWidget);
    expect(backend.callsTo('backup.export'), isEmpty);

    await tester.enterText(find.widgetWithText(TextField, '再输一次'), 'abcdef');
    await tester.tap(find.text('导出备份…'));
    await settle(tester);
    final params = backend.callsTo('backup.export').single;
    expect(params['path'], r'C:\备份\new.dfbackup');
    expect(params['includeKeys'], isTrue);
    expect(params['password'], 'abcdef');
    expect((params['prefs'] as Map)['themeMode'], 'light');

    agent.backupJob.value = {'id': 'j1', 'kind': 'export', 'status': 'running', 'step': '复制会话'};
    await tester.pump();
    expect(find.text('正在导出：复制会话…'), findsOneWidget);
  });

  testWidgets('import: preview, password and workspace map, then stage and replace', (tester) async {
    restoreResult = null;
    chooseBackupFile = () async => r'C:\备份\old.dfbackup';
    await openPanel(tester);
    await tester.tap(find.text('导入备份…'));
    await settle(tester);
    expect(find.textContaining('OLD-PC'), findsOneWidget);
    expect(find.textContaining('对话 12'), findsOneWidget);
    await tester.enterText(find.widgetWithText(TextField, r'D:\work'), r'E:\work');
    await tester.enterText(find.widgetWithText(TextField, '迁移密码'), 'secret1');
    await tester.tap(find.text('检查并准备'));
    await settle(tester);
    final stage = backend.callsTo('backup.stage').single;
    expect(stage['password'], 'secret1');
    expect(stage['workspaces'], [
      {'from': r'D:\work', 'to': r'E:\work'},
    ]);

    agent.backupJob.value = {
      'id': 'j2',
      'kind': 'stage',
      'status': 'done',
      'result': {'sessions': 12, 'materialsRestored': 0, 'missingKeys': ['模型渠道「甲」']},
    };
    await settle(tester);
    expect(find.textContaining('模型渠道「甲」'), findsOneWidget);
    await tester.tap(find.text('替换当前数据…'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('替换并重启后台'));
    await settle(tester);
    expect(backend.callsTo('backup.apply'), hasLength(1));
  });

  testWidgets('after a restore the preferences come back once and it can be undone', (tester) async {
    restoreResult = {
      'ok': true,
      'at': 0,
      'from': {'host': 'OLD-PC', 'createdAt': 0, 'appVersion': '0.3.0'},
      'prefs': {
        'themeMode': 'dark',
        'textScale': {'double': 1.1},
      },
      'missingKeys': <String>[],
      'notRestored': ['工作区里的文件（备份只记位置）'],
      'schedulesPaused': true,
      'undoBackup': r'C:\data\backups\auto-import.dfbackup',
    };
    await openPanel(tester);
    expect(agent.preferences.themeMode, ThemeMode.dark);
    final prefs = await tester.runAsync(SharedPreferences.getInstance) as SharedPreferences;
    expect(prefs.getDouble('textScale'), 1.1);
    expect(backend.callsTo('backup.ackResult'), hasLength(1));
    expect(find.textContaining('定时任务都已暂停'), findsOneWidget);
    backend.handlers['backup.undo'] = (_) => {'id': 'j4', 'kind': 'apply', 'status': 'running'};
    await tester.tap(find.text('撤销这次恢复…'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('撤销'));
    await settle(tester);
    expect(backend.callsTo('backup.undo'), hasLength(1));
  });
}

Future<void> settle(WidgetTester tester) async {
  await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
  await tester.pumpAndSettle();
}
