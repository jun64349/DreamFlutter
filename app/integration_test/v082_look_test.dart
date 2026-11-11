// 0.8.2 (user test of 0.8.1): look at the reworked pages in the real window at a wide and a
// small size — settings (bounded column, cards), the channel editor, 花费 charts, memory,
// the sidebar's workspace button. PowerShell (app/):
//   ./tool/test.ps1 integration_test/v082_look_test.dart --device-id=windows
// Shots go to build/v082_shots.
import 'dart:io';
import 'dart:ui' as ui;

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;

import '../test/t87_fixture.dart';
import '../test/t88_fixture.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  final shots = Directory(p.join(Directory.current.path, 'build', 'v082_shots'))..createSync(recursive: true);
  final key = GlobalKey();

  Future<void> wait(WidgetTester t) async {
    for (var i = 0; i < 5; i++) {
      await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 40)));
      await t.pump(const Duration(milliseconds: 150));
    }
    expect(t.takeException(), isNull);
  }

  Future<void> shot(WidgetTester t, String name) async {
    await wait(t);
    await t.runAsync(() async {
      final boundary = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final image = await boundary.toImage(pixelRatio: 1);
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      File(p.join(shots.path, '$name.png')).writeAsBytesSync(bytes!.buffer.asUint8List());
      image.dispose();
    });
  }

  testWidgets('v0.8.2 settings, channel editor and spending', (t) async {
    final f = (await t.runAsync(T88Fixture.create))!;
    addTearDown(() async { await t.pumpWidget(const SizedBox()); await t.runAsync(f.dispose); });
    final now = DateTime.now();
    String day(int back) { final d = now.subtract(Duration(days: back)); return '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}'; }
    f.backend.handlers['ledger.summary'] = (params) {
      final group = params['groupBy'], period = params['period'];
      if (period == 'day') {
        return {'rows': [for (final back in [0, 1, 2, 4, 5, 8, 9, 12, 15, 20, 21, 27]) {'period': day(back), 'key': '全部', 'requests': 10 + back * 3, 'amounts': {'USD': 0.02 + back * 0.013}, 'amountSources': {'price_estimate': 1}}]};
      }
      if (group == 'model') {
        return {'rows': [
          {'period': 'm', 'key': 'df-c1/flash', 'requests': 392, 'amounts': {'USD': 0.42}},
          {'period': 'm', 'key': 'df-c1/pro', 'requests': 61, 'amounts': {'USD': 0.31}},
          {'period': 'm', 'key': 'relay/gemini-3.8-flash', 'requests': 13, 'amounts': {'USD': 0.04}},
        ]};
      }
      return {'rows': [
        {'period': 'm', 'key': 'conversation', 'requests': 392, 'amounts': {'USD': 0.52}},
        {'period': 'm', 'key': 'auto_title', 'requests': 8, 'amounts': {'USD': 0.01}},
        {'period': 'm', 'key': 'memory', 'requests': 18, 'amounts': {'USD': 0.08}},
        {'period': 'm', 'key': 'compaction', 'requests': 2, 'amounts': {'USD': 0.11}},
        {'period': 'm', 'key': 'web_fetch', 'requests': 44, 'amounts': {}},
      ]};
    };
    for (final dark in [false, true]) {
      final theme = dark ? 'dark' : 'light';
      await f.agent.setThemeMode(dark ? ThemeMode.dark : ThemeMode.light);
      for (final size in [const Size(1600, 900), const Size(1000, 760)]) {
        final tag = '${size.width.round()}_$theme';
        await t.binding.setSurfaceSize(size);
        await t.pumpWidget(RepaintBoundary(key: key, child: DreamFlutterApp(controller: f.agent)));
        await wait(t);
        await shot(t, 'workbench_$tag');
        f.agent.showSection(AppSection.settings);
        await wait(t);
        for (final group in ['通用', '模型', '工作台', '归档/回收', '开发者选项']) {
          await t.tap(find.byKey(ValueKey('settings-nav-$group')));
          await wait(t);
          await shot(t, 'settings_${group.replaceAll('/', '-')}_$tag');
        }
        await t.tap(find.byKey(const ValueKey('settings-nav-模型')));
        await wait(t);
        await t.tap(find.text('DeepSeek').first);
        await wait(t);
        await shot(t, 'channel_editor_$tag');
        await t.ensureVisible(find.textContaining('· flash').first);
        await wait(t);
        await t.tap(find.textContaining('· flash').first);
        await wait(t);
        await shot(t, 'model_dialog_$tag');
        await t.tap(find.text('取消').last);
        await wait(t);
        await t.pageBack();
        await wait(t);
        f.agent.showSection(AppSection.spending);
        await wait(t);
        await shot(t, 'spending_$tag');
      }
    }
  });

  testWidgets('v0.8.2 memory page and its log', (t) async {
    final f = (await t.runAsync(T87Fixture.create))!;
    addTearDown(() async { await t.pumpWidget(const SizedBox()); await t.runAsync(f.dispose); });
    for (final dark in [false, true]) {
      final theme = dark ? 'dark' : 'light';
      await f.agent.setThemeMode(dark ? ThemeMode.dark : ThemeMode.light);
      await t.binding.setSurfaceSize(const Size(1400, 900));
      await t.pumpWidget(RepaintBoundary(key: key, child: DreamFlutterApp(controller: f.agent)));
      f.agent.showSection(AppSection.memory);
      await wait(t);
      await shot(t, 'memory_$theme');
      await t.tap(find.text('最近'));
      await wait(t);
      await shot(t, 'memory_recent_$theme');
      await t.tap(find.text('全部'));
      await wait(t);
    }
    expect(f.items, isNotEmpty);
  });
}

