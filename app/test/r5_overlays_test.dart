import 'dart:io';

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/attention_page.dart';
import 'package:dreamflutter/ui/garden_details.dart';
import 'package:dreamflutter/ui/garden_page.dart';
import 'package:dreamflutter/ui/library_page.dart';
import 'package:dreamflutter/ui/memory_page.dart';
import 'package:dreamflutter/ui/mini_charts.dart';
import 'package:dreamflutter/ui/spending_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';

import 't87_fixture.dart';
import 't89_fixture.dart';

Future<void> settleR5(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  testWidgets('R5 overlays preserve the page underneath and close with Escape', (tester) async {
    final fixture = (await tester.runAsync(T87Fixture.create))!;
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(fixture.dispose);
    });
    fixture.backend.handlers['ledger.summary'] = (_) => {'rows': <Json>[]};
    await tester.binding.setSurfaceSize(const Size(1100, 850));
    await tester.pumpWidget(DreamFlutterApp(controller: fixture.agent));
    await settleR5(tester);
    fixture.agent.showSection(AppSection.tasks);
    await settleR5(tester);
    expect(find.byType(AttentionPage), findsOneWidget);
    for (final (section, type) in [(AppSection.memory, MemoryOverlay), (AppSection.library, LibraryOverlay), (AppSection.spending, SpendingOverlay)]) {
      fixture.agent.showSection(section);
      await settleR5(tester);
      expect(find.byType(type), findsOneWidget);
      expect(find.byType(AttentionPage), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await settleR5(tester);
      expect(find.byType(type), findsNothing);
      expect(fixture.agent.section, AppSection.tasks);
    }
  });

  testWidgets('R5 memory keeps search, groups, logs and real settings in three tabs', (tester) async {
    final fixture = (await tester.runAsync(T87Fixture.create))!;
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(fixture.dispose);
    });
    await tester.binding.setSurfaceSize(const Size(760, 850));
    await tester.pumpWidget(AgentScope(controller: fixture.agent, child: MaterialApp(theme: buildTheme(Brightness.light), home: const Scaffold(body: MemoryPage()))));
    await settleR5(tester);
    expect(find.text('梦君记'), findsOneWidget);
    expect(find.text('今天'), findsWidgets);
    await tester.enterText(find.widgetWithText(TextField, '搜索记忆'), 'GB/T');
    await settleR5(tester);
    expect(find.byKey(const ValueKey('memory-content-own')), findsOneWidget);
    expect(find.byKey(const ValueKey('memory-content-you')), findsNothing);
    await tester.tap(find.byTooltip('清除'));
    await tester.pump();
    await tester.tap(find.byTooltip('项目 2'));
    await settleR5(tester);
    expect(find.byKey(const ValueKey('memory-content-project')), findsOneWidget);
    expect(find.byKey(const ValueKey('memory-content-own')), findsNothing);
    await tester.tap(find.text('日志'));
    await settleR5(tester);
    expect(find.text('记住了'), findsOneWidget);
    await tester.tap(find.text('设置'));
    await settleR5(tester);
    expect(find.byKey(const ValueKey('memory-settings')), findsOneWidget);
    expect(find.widgetWithText(TextField, '搜索设置'), findsNothing);
    expect(find.text('自动记忆'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('R5 skills order pending first, read real files and retain narrow navigation', (tester) async {
    final fixture = (await tester.runAsync(T89Fixture.create))!;
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(fixture.dispose);
    });
    final source = File(fixture.skills.first['filePath'] as String);
    await tester.runAsync(() async {
      await source.parent.create(recursive: true);
      await source.writeAsString('# 文献整理\n\n读取论文并保留引用页码。');
      await File('${source.parent.path}/extract.py').writeAsString('print("ok")');
    });
    await tester.binding.setSurfaceSize(const Size(1100, 850));
    await tester.pumpWidget(AgentScope(controller: fixture.agent, child: MaterialApp(theme: buildTheme(Brightness.light), home: const Scaffold(body: GardenPage()))));
    await settleR5(tester);
    expect(find.text('百工'), findsOneWidget);
    expect(tester.getTopLeft(find.text('检查引用')).dy, lessThan(tester.getTopLeft(find.text('文献整理').first).dy));
    final preview = find.byType(SkillSourcePreview);
    expect(preview, findsOneWidget, reason: '${fixture.skills.first}');
    await tester.runAsync(() => tester.widget<FutureBuilder<({List<String> files, String text})>>(find.descendant(of: preview, matching: find.byType(FutureBuilder<({List<String> files, String text})>))).future!.timeout(const Duration(seconds: 2)));
    await tester.pump();
    expect(find.text('暂时读不到这份技能文件'), findsNothing);
    expect(find.textContaining('读取论文并保留引用页码。', findRichText: true), findsOneWidget);
    expect(find.text('extract.py'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, '连接的服务'));
    await settleR5(tester);
    await tester.tap(find.text('实验室资料库').first);
    await settleR5(tester);
    expect(find.text('蝶君能用'), findsOneWidget);
    expect(find.text('测试连接'), findsOneWidget);
    await tester.binding.setSurfaceSize(const Size(620, 850));
    await settleR5(tester);
    expect(find.byTooltip('返回技能列表'), findsOneWidget);
    await tester.tap(find.byTooltip('返回技能列表'));
    await settleR5(tester);
    expect(find.text('实验室资料库'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('R5 spending shows the real limit and keeps both rings usable at overlay width', (tester) async {
    final fixture = (await tester.runAsync(T89Fixture.create))!;
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(fixture.dispose);
    });
    fixture.agent.coreSettings['monthlyBudgetUsd'] = 40;
    final today = DateTime.now();
    final day = '${today.year}-${today.month.toString().padLeft(2, '0')}-${today.day.toString().padLeft(2, '0')}';
    fixture.backend.handlers['ledger.summary'] = (params) => {'rows': [
      {'period': day, 'key': params['groupBy'] == 'model' ? 'test/model' : 'conversation', 'requests': 4, 'amounts': {'USD': 1.25}},
    ]};
    await tester.binding.setSurfaceSize(const Size(1040, 850));
    await tester.pumpWidget(AgentScope(controller: fixture.agent, child: MaterialApp(theme: buildTheme(Brightness.light), home: const Scaffold(body: SpendingPage()))));
    await settleR5(tester);
    expect(find.text('每月上限'), findsOneWidget);
    expect(find.text(r'$40.00'), findsOneWidget);
    final rings = tester.widgetList<DonutChart>(find.byType(DonutChart)).toList();
    expect(rings.map((r) => r.values), [[1.25], [1.25]]);
    expect(tester.getCenter(find.byType(DonutChart).first).dy, closeTo(tester.getCenter(find.byType(DonutChart).last).dy, 1));
    await tester.tap(find.text('次数'));
    await settleR5(tester);
    expect(find.byType(DayBarChart), findsOneWidget);
    expect(tester.widget<DayBarChart>(find.byType(DayBarChart)).values.last, 4);
    await tester.binding.setSurfaceSize(const Size(760, 850));
    await settleR5(tester);
    expect(tester.takeException(), isNull);
  });
}
