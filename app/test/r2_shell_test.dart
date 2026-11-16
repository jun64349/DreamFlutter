import 'dart:io';

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/ui/sidebar.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';

Future<AgentController> startR2Shell(WidgetTester tester) async {
  final root = Directory.systemTemp.createTempSync('df_r2_shell_');
  SharedPreferences.setMockInitialValues({'workspace': root.path, 'onboarded': true});
  final agent = AgentController(preferences: (await tester.runAsync(Preferences.load))!, sessionStore: SessionStore(sessionsDir: root.path), backend: FakeBackend());
  addTearDown(() async {
    await tester.pumpWidget(const SizedBox());
    agent.dispose();
    root.deleteSync(recursive: true);
    await tester.binding.setSurfaceSize(null);
  });
  await tester.binding.setSurfaceSize(const Size(1200, 800));
  await tester.pumpWidget(DreamFlutterApp(controller: agent));
  await tester.runAsync(agent.init);
  await tester.pumpAndSettle();
  return agent;
}

void main() {
  testWidgets('sidebar collapses by pointer and Ctrl+B, and remains a narrow drawer', (tester) async {
    await startR2Shell(tester);
    expect(find.byType(Sidebar), findsOneWidget);
    await tester.tap(find.byTooltip('收起侧栏（Ctrl + B）'));
    await tester.pumpAndSettle();
    expect(find.byType(Sidebar), findsNothing);
    expect(find.byTooltip('展开侧栏（Ctrl + B）'), findsOneWidget);

    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyB);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pumpAndSettle();
    expect(find.byType(Sidebar), findsOneWidget);

    await tester.binding.setSurfaceSize(const Size(700, 700));
    await tester.pumpAndSettle();
    expect(find.byTooltip('打开侧栏'), findsOneWidget);
    await tester.tap(find.byTooltip('打开侧栏'));
    await tester.pumpAndSettle();
    expect(find.byType(Sidebar), findsOneWidget);
    await tester.tap(find.byTooltip('收起侧栏（Ctrl + B）'));
    await tester.pumpAndSettle();
    expect(find.byType(Sidebar), findsNothing);
  });

  testWidgets('home hints rotate only while idle and unfocused', (tester) async {
    await startR2Shell(tester);
    expect(find.byWidgetPredicate((widget) => widget is TextField && widget.decoration?.hintText == '说点什么…'), findsOneWidget);
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 4600));
    expect(find.byWidgetPredicate((widget) => widget is TextField && widget.decoration?.hintText == '试试把一个表格文件拖进来'), findsOneWidget);

    await tester.enterText(find.byWidgetPredicate((widget) => widget is TextField && widget.decoration?.hintText == '试试把一个表格文件拖进来'), '不动');
    await tester.pump(const Duration(milliseconds: 4600));
    expect(find.byWidgetPredicate((widget) => widget is TextField && widget.decoration?.hintText == '试试把一个表格文件拖进来'), findsOneWidget);
  });
}
