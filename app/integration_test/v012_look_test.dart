import 'dart:io';
import 'dart:ui' as ui;
import 'package:dreamflutter/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import '../test/t87_fixture.dart';
import '../test/v012_fixture.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/goal_conversation.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('v012 incremental frontend scenes in a native window', (tester) async {
    final fixture = (await tester.runAsync(T87Fixture.create))!;
    final capture = GlobalKey();
    final shots = Directory('build/v012_shots')..createSync(recursive: true);
    addTearDown(() async { await tester.pumpWidget(const SizedBox()); await tester.runAsync(fixture.dispose); });
    Future<void> shot(String name) async {
      for (var i = 0; i < 6; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 40)));
        await tester.pump(const Duration(milliseconds: 150));
      }
      expect(tester.takeException(), isNull);
      await tester.runAsync(() async {
        final boundary = capture.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        final image = await boundary.toImage(pixelRatio: 1);
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        File('${shots.path}/$name.png').writeAsBytesSync(bytes!.buffer.asUint8List());
        image.dispose();
      });
    }
    for (final dark in [false, true]) {
      await fixture.agent.setThemeMode(dark ? ThemeMode.dark : ThemeMode.light);
      for (final width in [1600.0, 1000.0]) {
        await tester.binding.setSurfaceSize(Size(width, 900));
        await tester.pumpWidget(RepaintBoundary(key: capture, child: DreamFlutterApp(controller: fixture.agent)));
        await tester.runAsync(() => fixture.agent.openButterfly());
        fixture.agent.butterfly!.setRunPanelOpen(false);
        await shot('t136_butterfly_${width.toInt()}_${dark ? 'dark' : 'light'}');
        expect(find.text('交给我吧，你去忙别的'), findsOneWidget);
      }
    }
  });
  testWidgets('v012 goal conversation wide narrow light dark', (tester) async {
    final f = (await tester.runAsync(T87Fixture.create))!;
    await tester.runAsync(() => f.agent.openButterfly());
    final worker = f.agent.butterfly!;
    final api = V012Fixtures(f.backend, sessionFile: worker.currentSessionPath!, slotId: worker.active!.slotId!)..goals();
    final pi = f.backend.pis.last;
    pi.startRun('三款一起对比，下午之前给我一份报告');
    pi.emit({'type': 'message_end', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': '好，这件事我按目标来推进，做完会核对交付再告诉你。'}], 'model': 'fixture-model', 'provider': 'fixture', 'stopReason': 'stop', 'timestamp': DateTime.now().millisecondsSinceEpoch, 'dfProactiveRef': 'sample'}});
    pi.emit({'type': 'agent_end', 'messages': []});
    for (final event in api.events('slot.record')) {
      final record = event['record'];
      if (record is Map && record['type'] == 'df_agent_state') pi.emit(record.cast<String, dynamic>());
    }
    worker.setRunPanelOpen(true);
    final key = GlobalKey();
    final dir = Directory('build/v012_shots')..createSync(recursive: true);
    addTearDown(() async { await tester.pumpWidget(const SizedBox()); await tester.runAsync(f.dispose); });
    for (final dark in [false, true]) {
      await f.agent.setThemeMode(dark ? ThemeMode.dark : ThemeMode.light);
      for (final width in [1600.0, 1000.0]) {
        await tester.binding.setSurfaceSize(Size(width, 900));
        await tester.pumpWidget(RepaintBoundary(key: key, child: DreamFlutterApp(controller: f.agent)));
        for (var i = 0; i < 8; i++) { await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50))); await tester.pump(const Duration(milliseconds: 150)); }
        expect(tester.takeException(), isNull);
        expect(find.text('目标'), findsOneWidget);
        await tester.runAsync(() async {
          final image = await (key.currentContext!.findRenderObject()! as RenderRepaintBoundary).toImage(pixelRatio: 1);
          final data = await image.toByteData(format: ui.ImageByteFormat.png);
          File('${dir.path}/t137_goal_${width.toInt()}_${dark ? 'dark' : 'light'}.png').writeAsBytesSync(data!.buffer.asUint8List()); image.dispose();
        });
      }
    }
  });
  testWidgets('v012 calendar inbox and butterfly settings', (tester) async {
    final f = (await tester.runAsync(T87Fixture.create))!;
    await tester.runAsync(() => f.agent.openButterfly());
    final worker=f.agent.butterfly!;
    final api=V012Fixtures(f.backend,sessionFile:worker.currentSessionPath!,slotId:worker.active!.slotId!)..schedules()..use('attention.list','attention.list.groups')..use('attention.prioritized','attention.prioritized.groups')..use('patrol.status','patrol.status.cooldown');
    await f.agent.attention.refresh();
    final key=GlobalKey(), dir=Directory('build/v012_shots')..createSync(recursive:true);
    addTearDown(() async { await tester.pumpWidget(const SizedBox()); await tester.runAsync(f.dispose); });
    for(final scene in ['schedule','inbox','settings']) {
      if(scene=='schedule') { scheduleNavigationRequest.value=(api.bind(V012Fixtures.read('schedules.get')) as Map)['id']; f.agent.showSection(AppSection.schedules); }
      if(scene=='inbox') f.agent.showSection(AppSection.tasks);
      if(scene=='settings') f.agent.openSettings('蝶君');
      for(final dark in [false,true]) {
        await f.agent.setThemeMode(dark?ThemeMode.dark:ThemeMode.light);
        for(final width in [1600.0,1000.0]) {
          await tester.binding.setSurfaceSize(Size(width,1000));
          await tester.pumpWidget(RepaintBoundary(key:key,child:DreamFlutterApp(controller:f.agent)));
          for(var i=0;i<6;i++) { await tester.runAsync(()=>Future<void>.delayed(const Duration(milliseconds:40))); await tester.pump(const Duration(milliseconds:150)); }
          expect(tester.takeException(),isNull);
          await tester.runAsync(() async { final image=await (key.currentContext!.findRenderObject()! as RenderRepaintBoundary).toImage(pixelRatio:1); final bytes=await image.toByteData(format:ui.ImageByteFormat.png); File('${dir.path}/t138_${scene}_${width.toInt()}_${dark?'dark':'light'}.png').writeAsBytesSync(bytes!.buffer.asUint8List()); image.dispose(); });
        }
      }
    }
  });
  testWidgets('v012 T-139 settings, skills and workbench scenes', (tester) async {
    final f = (await tester.runAsync(T87Fixture.create))!;
    f.backend.settings = (V012Fixtures.read('settings.get.t139') as Map).cast<String, dynamic>();
    f.agent.coreSettings = {...f.backend.settings};
    f.backend.handlers['settings.get'] = (_) => f.backend.settings;
    for (final m in ['persona.presets', 'selfwork.longGoals.list', 'selfwork.history', 'selfwork.skills.list', 'voice.keyStatus', 'uninstall.preservedData', 'autonomy.rules.list', 'patrol.status', 'patrol.log', 'schedules.defaults']) { f.backend.useFixture(m); }
    final key = GlobalKey(), dir = Directory('build/v012_shots')..createSync(recursive: true);
    addTearDown(() async { await tester.pumpWidget(const SizedBox()); await tester.runAsync(f.dispose); });
    for (final scene in ['set_butterfly', 'set_general', 'set_data', 'skills', 'workbench']) {
      if (scene == 'set_butterfly') f.agent.openSettings('蝶君');
      if (scene == 'set_general') f.agent.openSettings('通用');
      if (scene == 'set_data') f.agent.openSettings('数据与安全');
      if (scene == 'skills') f.agent.showSection(AppSection.library);
      if (scene == 'workbench') f.agent.showSection(AppSection.chat);
      for (final dark in [false, true]) {
        await f.agent.setThemeMode(dark ? ThemeMode.dark : ThemeMode.light);
        for (final width in [1600.0, 1000.0]) {
          await tester.binding.setSurfaceSize(Size(width, 1000));
          await tester.pumpWidget(RepaintBoundary(key: key, child: DreamFlutterApp(controller: f.agent)));
          for (var i = 0; i < 6; i++) { await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 40))); await tester.pump(const Duration(milliseconds: 150)); }
          expect(tester.takeException(), isNull);
          await tester.runAsync(() async { final image = await (key.currentContext!.findRenderObject()! as RenderRepaintBoundary).toImage(pixelRatio: 1); final bytes = await image.toByteData(format: ui.ImageByteFormat.png); File('${dir.path}/t139_${scene}_${width.toInt()}_${dark ? 'dark' : 'light'}.png').writeAsBytesSync(bytes!.buffer.asUint8List()); image.dispose(); });
        }
      }
    }
  });
}
