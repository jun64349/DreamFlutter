import 'dart:io';
import 'dart:ui' as ui;

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../test/fake_backend.dart';

/// 「入门 5 课」in the real window (route step 4): one shot per kind of step, light and dark.
/// Shots go to build/onboarding_shots.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('onboarding lessons native screenshots', (tester) async {
    final root = Directory.systemTemp.createTempSync('df_tour_look_');
    SharedPreferences.setMockInitialValues({'workspace': root.path, 'onboarded': true});
    final backend = FakeBackend()..butterflyHome = p.join(root.path, 'butterfly');
    backend.handlers['sandbox.status'] = (_) => {'state': 'absent', 'online': true};
    final agent = AgentController(preferences: await Preferences.load(), sessionStore: SessionStore(sessionsDir: root.path), backend: backend);
    final key = GlobalKey();
    final shots = Directory(p.join(Directory.current.path, 'build', 'onboarding_shots'))..createSync(recursive: true);
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      agent.dispose();
      root.deleteSync(recursive: true);
    });
    Future<void> wait() async {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 150)));
      for (var i = 0; i < 8; i++) {
        await tester.pump(const Duration(milliseconds: 300));
      }
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
    void go(int lesson, int step) {
      final tour = agent.tour;
      tour.lesson = lesson;
      tour.step = step;
      tour.start(agent);
    }

    await tester.binding.setSurfaceSize(const Size(1280, 800));
    await tester.pumpWidget(RepaintBoundary(key: key, child: DreamFlutterApp(controller: agent)));
    await tester.runAsync(agent.init);
    for (final dark in [false, true]) {
      final c = dark ? 'dark' : 'light';
      await agent.setThemeMode(dark ? ThemeMode.dark : ThemeMode.light);
      agent.showSection(AppSection.chat);
      agent.tour.leave();
      agent.tour.lesson = 0;
      agent.tour.step = 0;
      await shot('0_sidebar_card_$c');
      go(0, 0);
      await shot('1-1_read_$c');
      go(0, 1);
      await shot('1-2_place_switch_$c');
      go(1, 1);
      await shot('2-2_settings_gear_$c');
      agent.showSection(AppSection.settings);
      go(1, 2);
      await shot('2-3_settings_nav_$c');
      await tester.tap(find.byKey(const ValueKey('settings-nav-模型')));
      await shot('2-3b_add_channel_$c');
      agent.showSection(AppSection.chat);
      go(2, 1);
      await shot('3-2_composer_$c');
      go(3, 0);
      await shot('4-1_workspace_$c');
      go(3, 1);
      await shot('4-2_ask_first_$c');
      go(3, 4);
      await shot('4-5_details_$c');
      go(4, 0);
      await shot('5-1_butterfly_$c');
      agent.showSection(AppSection.butterfly);
      go(4, 1);
      await shot('5-2_sandbox_$c');
      go(4, 2);
      await shot('5-3_composer_$c');
      go(4, 4);
      await shot('5-5_attention_$c');
      agent.showSection(AppSection.tasks);
      await shot('5-5b_attention_page_$c');
      agent.tour.leave();
    }
  });
}
