import 'dart:io';

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';

void main() {
  testWidgets('MCP page lists servers, checks connections and saves a new server', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1400, 1000));
    SharedPreferences.setMockInitialValues({'workspace': Directory.systemTemp.path});
    final sessions = Directory.systemTemp.createTempSync('df_mcp_');
    final backend = FakeBackend();
    backend.handlers.addAll({
      'mcp.list': (_) => {
        'file': r'C:\Users\me\.pi\agent\mcp.json',
        'servers': [
          {
            'name': 'github',
            'scope': 'user',
            'transport': 'http',
            'url': 'https://api.example.com/mcp',
            'headers': {
              'Authorization': {'value': '', 'secret': true},
            },
            'enabled': true,
          },
        ],
      },
      'mcp.status': (_) => {
        'servers': [
          {
            'name': 'github',
            'state': 'connected',
            'tools': [
              {'name': 'search_code'},
              {'name': 'get_issue'},
            ],
          },
        ],
      },
    });
    final agent = AgentController(
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
    Future<void> settle() async {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
      await tester.pumpAndSettle();
    }

    await tester.tap(find.text('设置'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('MCP 服务'));
    await settle();
    expect(find.text('github'), findsOneWidget);

    await tester.tap(find.text('检查连接'));
    await settle();
    expect(find.text('已连接 · 2 个工具'), findsOneWidget);
    expect(find.text('search_code'), findsOneWidget);

    await tester.tap(find.text('添加服务'));
    await settle();
    await tester.enterText(find.widgetWithText(TextField, '名称（字母、数字、横线、下划线）'), 'fs');
    await tester.enterText(find.widgetWithText(TextField, '命令（只写程序名，例如 npx、uvx）'), 'npx');
    await tester.enterText(find.widgetWithText(TextField, '参数（每行一个）'), '-y\n@modelcontextprotocol/server-filesystem\n' r'D:\docs');
    await tester.tap(find.text('添加').first);
    await tester.pump();
    await tester.enterText(find.widgetWithText(TextField, '名称，例如 API_KEY'), 'TOKEN');
    await tester.enterText(find.widgetWithText(TextField, r'值，可写 ${环境变量}'), 'abc');
    await tester.tap(find.widgetWithText(FilterChip, '加密'));
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, '保存'));
    await settle();
    final saved = backend.callsTo('mcp.save').single['server'] as Map;
    expect(saved['name'], 'fs');
    expect(saved['args'], ['-y', '@modelcontextprotocol/server-filesystem', r'D:\docs']);
    expect(saved['env'], {
      'TOKEN': {'value': 'abc', 'secret': true},
    });
    expect(find.text('现在重新加载'), findsOneWidget);
  });
}
