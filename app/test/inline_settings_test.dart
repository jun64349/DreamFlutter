import 'dart:async';

import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/gateway_pages.dart';
import 'package:dreamflutter/ui/settings_workspace.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';

import 't87_fixture.dart';

class _Routes extends NavigatorObserver {
  int pushes = 0;
  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) { pushes++; }
}

void main() {
  late T87Fixture f;
  late _Routes routes;
  late List<Json> channels;
  late List<Json> groups;
  var reject = false;
  var closed = false;

  Future<void> start(WidgetTester t) async {
    f = (await t.runAsync(T87Fixture.create))!;
    addTearDown(() async { await t.pumpWidget(const SizedBox()); await t.runAsync(f.dispose); await t.binding.setSurfaceSize(null); });
    await t.binding.setSurfaceSize(const Size(1500, 1100));
    channels = [{'id':'c1','source':'df','provider':'df-c1','name':'现有渠道','kind':'relay','api':'openai-completions','baseUrl':'https://example.com/v1','enabled':true,'keys':<Json>[],'models':[{'id':'m1','name':'测试模型'}]}];
    groups = [];
    reject = false;
    closed = false;
    f.backend.handlers.addAll({
      'gateway.channels': (_) => channels,
      'gateway.groups': (_) => groups,
      'gateway.platforms': (_) => <Json>[],
      'gateway.saveChannel': (input) {
        if (reject) throw StateError('保存失败');
        channels.add({...input, 'id':'new-channel','source':'df','provider':'df-new','enabled':true});
        return {'id':'new-channel'};
      },
      'gateway.saveGroup': (input) {
        if (reject) throw StateError('保存失败');
        groups.add({...input, 'id':'new-group'});
        return {'id':'new-group'};
      },
    });
    await t.runAsync(() => f.agent.refreshGateway(models: true));
    routes = _Routes();
    await t.pumpWidget(AgentScope(controller:f.agent, child:MaterialApp(
      theme:buildTheme(Brightness.light), navigatorObservers:[routes],
      home:Scaffold(body:SettingsOverlay(category:'模型', onClose:(){closed=true;})),
    )));
    await t.pumpAndSettle();
  }

  Future<void> tapVisible(WidgetTester t, Finder target) async {
    await t.scrollUntilVisible(target, 250, scrollable:find.descendant(of:find.byKey(const ValueKey('settings-模型')), matching:find.byType(Scrollable)).first);
    await t.ensureVisible(target);
    await t.pumpAndSettle();
    await t.tap(target);
    await t.pumpAndSettle();
  }
  Finder field(String label) => find.byWidgetPredicate((w) => w is TextField && w.decoration?.labelText == label);
  Future<void> channelDraft(WidgetTester t) async {
    await tapVisible(t, find.text('添加渠道'));
    await t.enterText(field('渠道名称'), '新渠道');
    await t.pumpAndSettle();
  }
  Future<void> groupDraft(WidgetTester t) async {
    await tapVisible(t, find.text('新建模型组'));
    await t.enterText(find.byKey(const ValueKey('group-name')), '新组');
    await tapVisible(t, find.byKey(const ValueKey('group-add')));
    await t.tap(find.text('测试模型'));
    await t.pumpAndSettle();
    await t.tap(find.text('添加 1 个'));
    await t.pumpAndSettle();
  }

  testWidgets('新建渠道留在设置页，保存刷新列表，失败保留草稿', (t) async {
    await start(t);
    final before = routes.pushes;
    await channelDraft(t);
    expect(routes.pushes, before);
    reject = true;
    await tapVisible(t, find.widgetWithText(FilledButton, '保存'));
    expect(find.textContaining('没有保存'), findsOneWidget);
    expect(t.widget<TextField>(field('渠道名称')).controller!.text, '新渠道');
    reject = false;
    await tapVisible(t, find.widgetWithText(FilledButton, '保存'));
    expect(field('渠道名称'), findsNothing);
    expect(find.text('新渠道'), findsOneWidget);
    expect(routes.pushes, before);
  });

  testWidgets('新建模型组留在设置页，保存刷新列表，失败保留草稿', (t) async {
    await start(t);
    final before = routes.pushes;
    await groupDraft(t);
    expect(routes.pushes, before + 1, reason:'只打开选模型对话框');
    reject = true;
    await tapVisible(t, find.byKey(const ValueKey('group-save')));
    expect(find.textContaining('没有保存'), findsOneWidget);
    expect(t.widget<TextField>(find.byKey(const ValueKey('group-name'))).controller!.text, '新组');
    reject = false;
    await tapVisible(t, find.byKey(const ValueKey('group-save')));
    expect(find.byKey(const ValueKey('group-name')), findsNothing);
    expect(find.text('新组'), findsOneWidget);
  });

  testWidgets('现有渠道在设置内编辑，保存时保留原密钥和模型高级字段', (t) async {
    await start(t);
    channels.first['keys'] = [{'id': 'saved-key', 'enabled': true, 'label': '原备注', 'hint': '1234'}];
    channels.first['models'] = [{'id': 'm1', 'name': '测试模型', 'compat': {'supportsStore': false}}];
    await t.runAsync(f.agent.refreshGateway);
    await t.pumpAndSettle();
    final before = routes.pushes;
    await tapVisible(t, find.text('现有渠道'));
    expect(routes.pushes, before);
    expect(t.widget<TextField>(field('渠道名称')).controller!.text, '现有渠道');
    expect(find.text('已保存 · 尾号 1234'), findsOneWidget);
    await t.enterText(field('渠道名称'), '修改后');
    await tapVisible(t, find.widgetWithText(FilledButton, '保存'));
    final saved = f.backend.callsTo('gateway.saveChannel').single;
    expect(saved['id'], 'c1');
    expect(saved['keys'], [{'id': 'saved-key', 'enabled': true, 'label': '原备注'}]);
    expect(saved['models'], channels.first['models']);
    expect(field('渠道名称'), findsNothing);
  });

  testWidgets('手输已知模型预览能力，手动覆盖后仍保留自动上下文', (t) async {
    await start(t);
    f.backend.handlers['gateway.modelDefaults'] = (input) => input['id'] == 'gemini-3.1-pro-preview'
        ? {'contextWindow': 1048576, 'maxTokens': 65536, 'input': ['text', 'image', 'video'], 'reasoning': true, 'thinkingLevels': ['low', 'medium', 'high']}
        : null;
    await tapVisible(t, find.text('添加渠道'));
    await tapVisible(t, find.text('手动添加'));
    await t.enterText(field('模型 ID'), 'gemini-3.1-pro-preview');
    await t.pump(const Duration(milliseconds: 200));
    await t.pumpAndSettle();
    final image = find.widgetWithText(SwitchListTile, '能看图');
    final video = find.widgetWithText(SwitchListTile, '模型支持视频');
    expect(t.widget<SwitchListTile>(image).value, isTrue);
    expect(t.widget<SwitchListTile>(video).value, isTrue);
    expect(t.widget<TextField>(field('上下文长度')).decoration!.hintText, '1048576');
    final off = find.widgetWithText(FilterChip, '关闭');
    expect(t.widget<FilterChip>(off).selected, isFalse);
    await t.tap(image);
    await t.pumpAndSettle();
    await t.tap(find.text('确定'));
    await t.pumpAndSettle();
    await tapVisible(t, find.widgetWithText(FilledButton, '保存'));
    expect(f.backend.callsTo('gateway.saveChannel').single['models'], [
      {'id': 'gemini-3.1-pro-preview', 'name': '', 'input': ['text', 'video']},
    ]);
  });

  testWidgets('收起和切换分类先确认，可继续编辑或放弃', (t) async {
    await start(t);
    await channelDraft(t);
    await tapVisible(t, find.text('收起'));
    await t.tap(find.text('继续编辑')); await t.pumpAndSettle();
    expect(t.widget<TextField>(field('渠道名称')).controller!.text, '新渠道');
    await t.tap(find.byKey(const ValueKey('settings-nav-通用'))); await t.pumpAndSettle();
    await t.tap(find.text('继续编辑')); await t.pumpAndSettle();
    expect(field('渠道名称'), findsOneWidget);
    await t.tap(find.byKey(const ValueKey('settings-nav-通用'))); await t.pumpAndSettle();
    await t.tap(find.text('不保存')); await t.pumpAndSettle();
    expect(find.byKey(const ValueKey('settings-通用')), findsOneWidget);
    expect(f.backend.callsTo('gateway.saveChannel'), isEmpty);
  });

  testWidgets('关闭设置先确认，可继续编辑或放弃', (t) async {
    await start(t);
    await channelDraft(t);
    await t.sendKeyEvent(LogicalKeyboardKey.escape); await t.pumpAndSettle();
    await t.tap(find.text('继续编辑')); await t.pumpAndSettle();
    expect(closed, isFalse);
    expect(t.widget<TextField>(field('渠道名称')).controller!.text, '新渠道');
    await t.sendKeyEvent(LogicalKeyboardKey.escape); await t.pumpAndSettle();
    await t.tap(find.text('不保存')); await t.pumpAndSettle();
    expect(closed, isTrue);
    expect(f.backend.callsTo('gateway.saveChannel'), isEmpty);
  });
  testWidgets('清除搜索时确认草稿，继续编辑保留查询', (t) async {
    await start(t);
    final search = find.widgetWithText(TextField, '搜索设置');
    await t.enterText(search, '渠道'); await t.pumpAndSettle();
    await t.tap(find.text('添加渠道')); await t.pumpAndSettle();
    await t.enterText(field('渠道名称'), '搜索草稿'); await t.pumpAndSettle();
    await t.tap(find.byTooltip('清除')); await t.pumpAndSettle();
    await t.tap(find.text('继续编辑')); await t.pumpAndSettle();
    expect(t.widget<TextField>(search).controller!.text, '渠道');
    expect(t.widget<TextField>(field('渠道名称')).controller!.text, '搜索草稿');
    await t.tap(find.byTooltip('清除')); await t.pumpAndSettle();
    await t.tap(find.text('不保存')); await t.pumpAndSettle();
    expect(t.widget<TextField>(search).controller!.text, isEmpty);
    expect(field('渠道名称'), findsNothing);
  });

  testWidgets('保存进行时不能关闭设置', (t) async {
    await start(t);
    final pending = Completer<Object?>();
    f.backend.handlers['gateway.saveChannel'] = (_) => pending.future;
    await channelDraft(t);
    final save = find.widgetWithText(FilledButton, '保存');
    await t.ensureVisible(save);
    await t.pumpAndSettle();
    await t.tap(save); await t.pump();
    expect(f.backend.callsTo('gateway.saveChannel'), hasLength(1));
    expect(t.widget<FilledButton>(find.descendant(of: find.byType(ChannelEditorPage), matching: find.byType(FilledButton))).onPressed, isNull);
    await t.sendKeyEvent(LogicalKeyboardKey.escape); await t.pump();
    expect(closed, isFalse);
    expect(field('渠道名称'), findsOneWidget);
    pending.complete({'id':'new-channel'});
    await t.pumpAndSettle();
  });

}
