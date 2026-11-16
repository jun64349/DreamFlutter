import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/home_page.dart';
import 'package:dreamflutter/ui/overlay_panel.dart';
import 'package:dreamflutter/ui/painting_art.dart';
import 'package:dreamflutter/ui/settings_controls.dart';
import 'package:dreamflutter/ui/settings_workspace.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 't87_fixture.dart';

void main() {
  testWidgets('automatic memory re-enables both settings from an older disabled configuration', (t) async {
    final f = (await t.runAsync(T87Fixture.create))!;
    addTearDown(() async { await t.pumpWidget(const SizedBox()); await t.runAsync(f.dispose); });
    const saved = {'memoryEnabled': false, 'memoryAutoExtract': true};
    f.backend.settings.addAll(saved);
    f.agent.coreSettings.addAll(saved);
    await t.pumpWidget(AgentScope(controller: f.agent, child: MaterialApp(
      theme: buildTheme(Brightness.light),
      home: const Scaffold(body: SettingsPage(category: '记忆', embedded: true)),
    )));
    final toggle = find.descendant(
      of: find.widgetWithText(SettingsSwitch, '自动记忆'),
      matching: find.byType(V1Toggle),
    );
    expect(t.widget<V1Toggle>(toggle).value, isFalse);
    await t.tap(toggle);
    await t.pumpAndSettle();
    expect(t.widget<V1Toggle>(toggle).value, isTrue);
    expect(f.backend.callsTo('settings.update').last, {'memoryEnabled': true, 'memoryAutoExtract': true});
    await t.tap(toggle);
    await t.pumpAndSettle();
    expect(t.widget<V1Toggle>(toggle).value, isFalse);
    expect(f.backend.callsTo('settings.update').last, {'memoryEnabled': false, 'memoryAutoExtract': false});
  });

  testWidgets('settings overlay has eleven pages, real theme cards and a narrow layout', (t) async {
    final f = (await t.runAsync(T87Fixture.create))!;
    addTearDown(() async { await t.pumpWidget(const SizedBox()); await t.runAsync(f.dispose); await t.binding.setSurfaceSize(null); });
    await t.binding.setSurfaceSize(const Size(1500, 920));
    await t.pumpWidget(AgentScope(controller: f.agent, child: MaterialApp(theme: buildTheme(Brightness.light), builder: (context, child) => MediaQuery(data: MediaQuery.of(context).copyWith(disableAnimations: true), child: child!), home: const HomePage())));
    await t.pump();
    f.agent.openSettings('通用');
    await t.pump(const Duration(milliseconds: 200));
    expect(find.byType(ShellOverlay), findsOneWidget);
    expect(t.getSize(find.byType(SettingsPage)), const Size(1080, 780));
    const names = ['通用', '蝶君', '记忆', '模型', '工作台', '外观', '窗口与通知', '数据与安全', '归档与回收', '关于与更新', '开发者选项'];
    for (final name in names) {
      final nav = find.byKey(ValueKey('settings-nav-$name'));
      await t.ensureVisible(nav);
      await t.tap(nav);
      await t.pump(const Duration(milliseconds: 200));
      expect(find.byKey(ValueKey('settings-$name')), findsOneWidget);
      expect(t.takeException(), isNull, reason: name);
    }
    await t.tap(find.byKey(const ValueKey('settings-nav-外观')));
    await t.pump(const Duration(milliseconds: 200));
    expect(find.descendant(of: find.byType(SettingsPage), matching: find.byType(PaintingMotif)), findsNWidgets(12));
    await t.tap(find.text('千蝶'));
    await t.pump();
    expect(f.agent.preferences.lightTheme, 'qiandie');
    await t.scrollUntilVisible(find.text('细颗粒'), 250, scrollable: find.descendant(of: find.byKey(const ValueKey('settings-外观')), matching: find.byType(Scrollable)).first);
    await t.ensureVisible(find.text('细颗粒'));
    await t.pump();
    await t.tap(find.text('细颗粒'));
    await t.pump();
    expect(f.agent.preferences.paperTexture, 'grain');
    await t.sendKeyEvent(LogicalKeyboardKey.escape);
    await t.pump(const Duration(milliseconds: 200));
    expect(find.byType(SettingsOverlay), findsNothing);
    expect(f.agent.section.name, 'chat');

    t.view.physicalSize = const Size(760, 900);
    t.view.devicePixelRatio = 1;
    addTearDown(() { t.view.resetPhysicalSize(); t.view.resetDevicePixelRatio(); });
    await t.binding.setSurfaceSize(const Size(760, 900));
    await t.pump();
    f.agent.openSettings('通用');
    await t.pump(const Duration(milliseconds: 200));
    expect(find.byType(DropdownButtonFormField<String>), findsOneWidget);
    expect(find.byKey(const ValueKey('settings-nav-通用')), findsNothing);
    expect(t.takeException(), isNull);
  });
}
