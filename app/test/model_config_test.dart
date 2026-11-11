import 'dart:io';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/model_group_pages.dart';
import 'package:dreamflutter/ui/model_settings.dart';
import 'package:dreamflutter/ui/providers_page.dart';
import 'package:dreamflutter/ui/settings_page.dart';
import 'package:dreamflutter/ui/settings_controls.dart' show SettingMenu;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'fake_backend.dart';

class _FailingSettingsBackend extends FakeBackend {
  bool failSave = false;
  @override
  Future<Object?> call(String method, [Json params = const {}, Duration timeout = const Duration(seconds: 60)]) {
    if (method == 'settings.update' && failSave) return Future.error(CoreException('test_failure', '保存失败，请重试'));
    return super.call(method, params, timeout);
  }
}

void main() {
  late AgentController agent;
  late FakeBackend backend;
  Future<void> start(WidgetTester tester, Widget child, {FakeBackend? injected}) async {
    await tester.binding.setSurfaceSize(const Size(1000, 800));
    final dir = Directory.systemTemp.createTempSync('df_model_config_');
    SharedPreferences.setMockInitialValues({'workspace': dir.path, 'migratedToCore': true});
    backend = injected ?? FakeBackend();
    agent = AgentController(preferences: (await tester.runAsync(Preferences.load))!, sessionStore: SessionStore(sessionsDir: dir.path), backend: backend);
    await tester.runAsync(agent.init);
    await tester.pumpWidget(AgentScope(controller: agent, child: MaterialApp(theme: buildTheme(Brightness.light), home: Scaffold(body: child))));
    await tester.pumpAndSettle();
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      agent.dispose();
      dir.deleteSync(recursive: true);
      await tester.binding.setSurfaceSize(null);
    });
  }

  testWidgets('default thinking can return to following the model; session selection does not overwrite it', (tester) async {
    await start(tester, const SettingsPage(category: '模型与网关'));
    await tester.enterText(find.widgetWithText(TextField,'搜索设置'),'思考深度');await tester.pumpAndSettle();await tester.tap(find.descendant(of:find.byKey(const ValueKey('settings-search')),matching:find.byType(SettingMenu<String>)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('高').last);
    await tester.pumpAndSettle();
    expect(agent.defaultThinkingLevel, 'high');
    await tester.enterText(find.widgetWithText(TextField,'搜索设置'),'思考深度');await tester.pumpAndSettle();await tester.tap(find.descendant(of:find.byKey(const ValueKey('settings-search')),matching:find.byType(SettingMenu<String>)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('自动').last);
    await tester.pumpAndSettle();
    expect(agent.defaultThinkingLevel, isNull);
    await tester.runAsync(() => agent.selectThinkingLevel('low'));
    await tester.pumpAndSettle();
    expect(agent.defaultThinkingLevel, isNull);
    expect(backend.callsTo('settings.update').last, {'defaultThinking': null});
    expect(tester.takeException(), isNull);
  });

  testWidgets('per-model window validates, preserves other models and can restore the default', (tester) async {
    await start(tester, const ModelWindowSetting());
    await agent.updateCoreSettings({'modelContextWindows': {'another/model': 32000}});
    await tester.pumpAndSettle();
    await tester.tap(find.byType(DropdownButtonFormField<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('${agent.providerLabel(agent.models.first.provider)} · ${agent.models.first.name}').last);
    await tester.pumpAndSettle();
    final input = find.widgetWithText(TextField, '手动覆盖（单位）');
    await tester.enterText(input, '0');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(find.text('请输入大于 0 的整数'), findsOneWidget);
    await tester.enterText(input, '64000');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(backend.settings['modelContextWindows'], {'another/model': 32000, agent.models.first.key: 64000});
    await tester.tap(find.text('恢复为目录默认（未知）'));
    await tester.pumpAndSettle();
    expect(backend.settings['modelContextWindows'], {'another/model': 32000});
    expect(tester.takeException(), isNull);
  });

  testWidgets('manual relay capabilities round-trip and unknown windows stay omitted', (tester) async {
    final model = ModelEntry(id: 'unknown');
    await start(tester, SingleChildScrollView(child: ModelRow(model: model, onRemove: () {}, editThinkingLevels: true)));
    await tester.tap(find.widgetWithText(FilterChip, '关闭'));
    await tester.pumpAndSettle();
    expect(find.text('请至少选择一个档位'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilterChip, '低'));
    await tester.tap(find.widgetWithText(FilterChip, '高'));
    await tester.pumpAndSettle();
    final saved = model.toJson();
    expect(saved['thinkingLevels'], ['low', 'high']);
    expect(saved['reasoning'], isTrue);
    expect(saved.containsKey('contextWindow'), isFalse);
    expect(ModelEntry.fromJson(saved).thinkingLevels, ['low', 'high']);
    expect(tester.takeException(), isNull);
  });

  testWidgets('channel restore copy, failed save and reopening preserve the previous override at 150 percent', (tester) async {
    final failing = _FailingSettingsBackend();
    failing.handlers['gateway.modelWindow'] = (_) => {'source': 'channel', 'value': 77000};
    final panel = MediaQuery(data: const MediaQueryData(textScaler: TextScaler.linear(1.5)), child: const SingleChildScrollView(child: ModelWindowSetting()));
    await start(tester, panel, injected: failing);
    await tester.binding.setSurfaceSize(const Size(500, 900));
    await tester.pumpAndSettle();
    final key = agent.models.first.key;
    await agent.updateCoreSettings({'modelContextWindows': {key: 64000}});
    Future<void> select() async {
      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('${agent.providerLabel(agent.models.first.provider)} · ${agent.models.first.name}').last);
      await tester.pumpAndSettle();
    }
    await select();
    expect(find.text('恢复为渠道设置（77000 单位）'), findsOneWidget);
    failing.failSave = true;
    await tester.enterText(find.widgetWithText(TextField, '手动覆盖（单位）'), '88000');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(find.text('保存失败，请重试'), findsOneWidget);
    expect((backend.settings['modelContextWindows'] as Map)[key], 64000);
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(AgentScope(controller: agent, child: MaterialApp(theme: buildTheme(Brightness.dark), home: Scaffold(body: panel))));
    await tester.pumpAndSettle();
    await select();
    expect(find.text('64000'), findsOneWidget);
    failing.failSave = false;
    await tester.tap(find.text('恢复为渠道设置（77000 单位）'));
    await tester.pumpAndSettle();
    expect(backend.settings['modelContextWindows'], isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets('dragging groups sends backend order and redraws its persisted result', (tester) async {
    await start(tester, const SingleChildScrollView(child: GroupList()));
    var groups = <Json>[for (final id in ['a', 'b']) {'id': id, 'name': '组$id', 'entries': <Json>[]}];
    backend.handlers['gateway.channels'] = (_) => <Json>[];
    backend.handlers['gateway.groups'] = (_) => groups;
    backend.handlers['gateway.reorderGroups'] = (p) {
      groups = [for (final id in p['ids'] as List) groups.firstWhere((g) => g['id'] == id)];
      return {'ok': true};
    };
    await agent.refreshGateway();
    await tester.pumpAndSettle();
    final first = tester.getCenter(find.byTooltip('拖动排序').first);
    final second = tester.getCenter(find.byTooltip('拖动排序').last);
    await tester.timedDragFrom(first, Offset(0, second.dy - first.dy + 20), const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(backend.callsTo('gateway.reorderGroups').single['ids'], ['b', 'a']);
    expect(agent.modelGroups.map((g) => g.id), ['b', 'a']);
    expect(tester.getTopLeft(find.text('组b')).dy, lessThan(tester.getTopLeft(find.text('组a')).dy));
    await tester.pumpWidget(const SizedBox());
    await agent.refreshGateway();
    await tester.pumpWidget(AgentScope(controller: agent, child: MaterialApp(theme: buildTheme(Brightness.light), home: Scaffold(body: const SingleChildScrollView(child: GroupList())))));
    await tester.pumpAndSettle();
    expect(tester.getTopLeft(find.text('组b')).dy, lessThan(tester.getTopLeft(find.text('组a')).dy), reason: 'reopening reads the persisted backend order');
  });
}
