import 'package:dreamflutter/desktop_shell.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:tray_manager/tray_manager.dart';

import 'fake_backend.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('first close remembers a choice; tray exit checks background work and can be cancelled', (tester) async {
    final native = <String>[];
    for (final name in ['window_manager', 'tray_manager']) {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(MethodChannel(name), (call) async {
        native.add('$name.${call.method}');
        if (call.method == 'isFocused') return true;
        return null;
      });
      addTearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(MethodChannel(name), null));
    }
    SharedPreferences.setMockInitialValues({});
    final backend = FakeBackend();
    backend.handlers['app.exitState'] = (_) => {'busy': true};
    final preferences = await tester.runAsync(Preferences.load) as Preferences;
    final agent = AgentController(preferences: preferences, backend: backend);
    addTearDown(agent.dispose);
    var choices = 0, confirmations = 0, allowQuit = false;
    final shell = DesktopShell(agent, chooseCloseBehavior: () async { choices++; return 'tray'; }, confirmExit: () async { confirmations++; return allowQuit; });
    await tester.runAsync(shell.init);
    shell.onWindowClose();
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
    expect(preferences.closeBehaviorChoice, 'tray');
    expect(native, contains('window_manager.hide'));
    shell.onWindowClose();
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
    expect(choices, 1);
    shell.onTrayMenuItemClick(MenuItem(key: 'quit_all'));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
    expect(confirmations, 1);
    expect(backend.callsTo('core.shutdown'), isEmpty);
    expect(native, isNot(contains('window_manager.close')));
    allowQuit = true;
    shell.onTrayMenuItemClick(MenuItem(key: 'quit_all'));
    for (var i = 0; i < 20 && !native.contains('window_manager.close'); i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
      await tester.pump();
    }
    expect(confirmations, 2);
    expect(backend.callsTo('core.shutdown'), hasLength(1));
    expect(native, contains('window_manager.close'));
  });
}
