import 'dart:io';
import 'dart:async';
import 'dart:ui' as ui;

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/ui/close_window_dialog.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../test/fake_backend.dart';

void main([List<String> args = const []]) {
  if (args.contains('--t84-single-instance-probe') || Platform.environment['DREAMFLUTTER_T84_SINGLE_INSTANCE_PROBE'] == '1') exit(12);
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('T-84 shell light dark native screenshots', (tester) async {
    final root = Directory.systemTemp.createTempSync('df_t84_look_');
    SharedPreferences.setMockInitialValues({'workspace': root.path, 'onboarded': true});
    final now = DateTime.now();
    final parent = p.join(root.path, 'parent.jsonl');
    final backend = FakeBackend()..butterflyHome = p.join(root.path, 'butterfly');
    final sessionRows = <Json>[
      {'path': parent, 'title': '论文里的几个问题', 'cwd': root.path, 'modifiedAt': now.millisecondsSinceEpoch},
      {'path': p.join(root.path, 'fork.jsonl'), 'title': '换一种思路', 'parentSession': parent, 'cwd': root.path, 'modifiedAt': now.millisecondsSinceEpoch},
      {'path': p.join(root.path, 'yesterday.jsonl'), 'title': '整理上周的实验记录', 'cwd': root.path, 'modifiedAt': now.subtract(const Duration(days: 1)).millisecondsSinceEpoch},
      {'path': p.join(root.path, 'old.jsonl'), 'title': 'Raspberry Pi 项目计划', 'cwd': root.path, 'modifiedAt': now.subtract(const Duration(days: 20)).millisecondsSinceEpoch},
    ];
    backend.handlers['sessions.list'] = (params) => params['cwd'] == root.path ? sessionRows : <Json>[];
    backend.handlers['sessions.children'] = (params) => params['parentSession'] == parent ? [
      {'path': p.join(root.path, 'side.jsonl'), 'title': '问一下：这个公式', 'parentSession': parent, 'sessionType': 'side', 'cwd': root.path, 'modifiedAt': now.millisecondsSinceEpoch},
    ] : <Json>[];
    backend.handlers['sandbox.status'] = (_) => {'state': 'ready'};
    final agent = AgentController(preferences: await Preferences.load(), sessionStore: SessionStore(sessionsDir: root.path), backend: backend);
    final key = GlobalKey();
    final navigatorKey = GlobalKey<NavigatorState>();
    final shots = Directory(p.join(Directory.current.path, 'build', 't84_shots'))..createSync(recursive: true);
    addTearDown(() async { await tester.pumpWidget(const SizedBox()); agent.dispose(); root.deleteSync(recursive: true); });
    Future<void> wait() async {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 150)));
      for (var i = 0; i < 6; i++) { await tester.pump(const Duration(milliseconds: 100)); }
      expect(tester.takeException(), isNull);
    }
    Future<void> shot(String name) async {
      await wait();
      await tester.runAsync(() async {
        final boundary = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        final image = await boundary.toImage(pixelRatio: 1);
        final data = await image.toByteData(format: ui.ImageByteFormat.png);
        File(p.join(shots.path, '$name.png')).writeAsBytesSync(data!.buffer.asUint8List());
        image.dispose();
      });
    }
    await tester.binding.setSurfaceSize(const Size(1000, 800));
    await tester.pumpWidget(RepaintBoundary(key: key, child: DreamFlutterApp(controller: agent, navigatorKey: navigatorKey)));
    await shot('startup_light');
    await agent.setThemeMode(ThemeMode.dark);
    await shot('startup_dark');
    await tester.runAsync(agent.init);
    await tester.runAsync(agent.refreshSessions);
    await tester.runAsync(() async {
      final result = await Process.run(Platform.resolvedExecutable, ['--t84-single-instance-probe'], environment: {'DREAMFLUTTER_T84_SINGLE_INSTANCE_PROBE': '1'}).timeout(const Duration(seconds: 10));
      expect(result.exitCode, 0, reason: 'second launch must activate this runner before entering Dart');
    });
    for (final dark in [false, true]) {
      final color = dark ? 'dark' : 'light';
      await agent.setThemeMode(dark ? ThemeMode.dark : ThemeMode.light);
      await agent.setZoom(1);
      agent.showSection(AppSection.chat);
      agent.setRunPanelOpen(false);
      await shot('home_$color');
      agent.setRunPanelOpen(true);
      await shot('right_$color');
      agent.setRunPanelOpen(false);
      for (final section in [AppSection.tasks, AppSection.memory, AppSection.library, AppSection.spending, AppSection.settings]) {
        agent.showSection(section);
        await shot('${section.name}_$color');
      }
      // Settings were regrouped in T-88: appearance now lives in 通用, shown above as settings_$color.
      unawaited(chooseWindowCloseBehavior(navigatorKey.currentContext!));
      await shot('close_$color');
      await tester.tap(find.text('缩到托盘').last);
      await tester.runAsync(() => agent.openButterfly(tab: ButterflyTab.talk));
      await shot('butterfly_$color');
      agent.butterfly!.setRunPanelOpen(true);
      await shot('butterfly_right_$color');
      agent.butterfly!.setRunPanelOpen(false);
      agent.showSection(AppSection.chat);
      await agent.setZoom(1.5);
      await shot('home_150_$color');
      await tester.tap(find.byTooltip('打开侧栏'));
      await shot('drawer_150_$color');
      await tester.tapAt(const Offset(900, 250));
      await wait();
    }
  });
}
