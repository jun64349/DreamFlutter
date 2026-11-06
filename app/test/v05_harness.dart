import 'dart:io';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/zoom.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'fake_backend.dart';
import 'memory_v05_fixture.dart';

class V05Harness {
  V05Harness(this.agent, this.backend, this.fixture, this.directory);
  final AgentController agent;
  final FakeBackend backend;
  final MemoryV05Fixture fixture;
  final Directory directory;
  final capture = GlobalKey();
  final navigator = GlobalKey<NavigatorState>();
  Future<void> mount(WidgetTester tester, Widget child, {Brightness brightness = Brightness.light, double textScale = 1, double zoom = 1}) async {
    await tester.pumpWidget(AgentScope(controller: agent, child: MaterialApp(navigatorKey: navigator, debugShowCheckedModeBanner: false, theme: buildTheme(brightness), builder: (context, child) => RepaintBoundary(key: capture, child: AppZoom(controller: agent, zoom: zoom, textScale: textScale, child: child!)), home: Scaffold(body: child))));
    await settleV05(tester);
  }
}

Future<V05Harness> startV05(WidgetTester tester) async {
  await tester.binding.setSurfaceSize(const Size(1200, 1600));
  final directory = Directory.systemTemp.createTempSync('df_t10_');
  SharedPreferences.setMockInitialValues({'workspace': directory.path, 'onboarded': true});
  final backend = FakeBackend();
  final fixture = MemoryV05Fixture(backend, directory.path);
  final agent = AgentController(preferences: await tester.runAsync(Preferences.load) as Preferences, sessionStore: SessionStore(sessionsDir: directory.path), backend: backend);
  final harness = V05Harness(agent, backend, fixture, directory);
  await harness.mount(tester, const SizedBox());
  await tester.runAsync(agent.init);
  await tester.runAsync(agent.active!.refreshHistory);
  await settleV05(tester);
  addTearDown(() async {
    await tester.pumpWidget(const SizedBox());
    agent.dispose();
    if (directory.existsSync()) directory.deleteSync(recursive: true);
  });
  return harness;
}

Future<void> settleV05(WidgetTester tester) async {
  // A modal can intentionally keep its parent busy until it closes. Advance
  // both the IO and widget queues without waiting for its progress animation.
  for (var i = 0; i < 6; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
    await tester.pump(const Duration(milliseconds: 100));
  }
}
