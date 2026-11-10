import 'dart:io';
import 'dart:ui' as ui;

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/ui/memory_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;

import '../test/t87_fixture.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'T87 native memory and butterfly light dark at normal and 150 percent',
    (tester) async {
      final fixture = (await tester.runAsync(T87Fixture.create))!;
      final agent = fixture.agent;
      final capture = GlobalKey();
      final shots = Directory(
        p.join(Directory.current.path, 'build', 't87_shots'),
      )..createSync(recursive: true);
      addTearDown(() async {
        await tester.pumpWidget(const SizedBox());
        await tester.runAsync(fixture.dispose);
      });
      Future<void> wait() async {
        for (var i = 0; i < 6; i++) {
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 30)),
          );
          await tester.pump(const Duration(milliseconds: 100));
        }
        expect(tester.takeException(), isNull);
      }

      Future<void> shot(String name) async {
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 1300)),
        );
        await wait();
        await tester.runAsync(() async {
          final boundary =
              capture.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          final image = await boundary.toImage(pixelRatio: 1);
          final data = await image.toByteData(format: ui.ImageByteFormat.png);
          File(p.join(shots.path, '$name.png'))
              .writeAsBytesSync(data!.buffer.asUint8List());
          image.dispose();
        });
      }

      await tester.binding.setSurfaceSize(const Size(1000, 800));
      agent.showSection(AppSection.memory);
      await tester.pumpWidget(
        RepaintBoundary(
          key: capture,
          child: DreamFlutterApp(controller: agent),
        ),
      );
      await wait();
      for (final dark in [false, true]) {
        final color = dark ? 'dark' : 'light';
        await agent.setThemeMode(dark ? ThemeMode.dark : ThemeMode.light);
        await agent.setZoom(1);
        agent.showSection(AppSection.memory);
        await shot('memory_$color');
        await tester.tap(find.text('最近'));
        await shot('memory_recent_$color');
        await tester.tap(find.text('全部'));
        await agent.setZoom(1.5);
        await shot('memory_150_$color');
        await tester.tap(find.text('添加记忆'));
        await shot('memory_add_150_$color');
        await tester.tap(find.text('取消'));
        await wait();
        await agent.setZoom(1);
        await tester.runAsync(() => agent.openButterfly());
        agent.butterfly!.setRunPanelOpen(false);
        await shot('butterfly_home_$color');
        for (final status in ['进行中', '等你', '已完成', '没做成']) {
          expect(find.text(status), findsOneWidget);
        }
        await tester.tap(find.text('每周一整理上周的组会纪要').last);
        await wait();
        expect(find.text('交付'), findsOneWidget);
        agent.butterfly!.setRunPanelOpen(true);
        await shot('butterfly_delivery_$color');
        expect(find.text('任务进度'), findsOneWidget);
        expect(find.text('暂停'), findsOneWidget);
        await tester.tap(find.text('暂停'));
        await wait();
        expect(fixture.schedules.single['status'], 'paused');
        await tester.tap(find.text('继续'));
        await wait();
        expect(fixture.schedules.single['status'], 'active');
        await agent.setZoom(1.5);
        await shot('butterfly_delivery_150_$color');
        agent.butterfly!.setRunPanelOpen(false);
        await agent.setZoom(1);
        await tester.tap(find.byTooltip('蝶君首页'));
        await wait();
        await tester.runAsync(() => agent.butterfly!.send('整理本周的实验记录'));
        await shot('butterfly_plan_$color');
        expect(find.text('我会整理本周的实验记录'), findsOneWidget);
        await tester.tap(find.byTooltip('蝶君首页'));
        await wait();
        await agent.setZoom(1.5);
        await shot('butterfly_home_150_$color');
        await agent.setZoom(1);
        fixture.tasks.removeWhere((t) => t['id'] == 'prepared');
        fixture.backend.push({'event': 'tasks.changed'});
        await wait();
      }
      expect(find.byType(MemoryPage, skipOffstage: false), findsOneWidget);
    },
  );
}
