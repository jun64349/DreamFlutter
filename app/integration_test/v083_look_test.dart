// 0.8.3 model groups: look at the new parts in the real window at a wide and a small size, day and
// night — the 模型组 card, the group editor, adding members, a channel's common models, the input
// box's model menu, and the line a switch leaves in the conversation. PowerShell (app/):
//   ./tool/test.ps1 integration_test/v083_look_test.dart --device-id=windows
// Shots go to build/v083_shots.
import 'dart:io';
import 'dart:ui' as ui;

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../test/fake_backend.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  final shots = Directory(p.join(Directory.current.path, 'build', 'v083_shots'))..createSync(recursive: true);
  final key = GlobalKey();

  Json model(String provider, String id, String name, {bool image = false}) => {'id': id, 'name': name, 'provider': provider, 'reasoning': true, 'input': ['text', if (image) 'image'], 'contextWindow': 400000, 'maxTokens': 8192};
  final chatGpt = [
    for (final (id, name) in [('gpt-4o', 'GPT-4o'), ('gpt-4.1', 'GPT-4.1'), ('gpt-4.1-mini', 'GPT-4.1 mini'), ('gpt-5', 'GPT-5'), ('gpt-5-mini', 'GPT-5 Mini'), ('gpt-5.2', 'GPT-5.2'), ('gpt-5.3-codex', 'GPT-5.3 Codex'), ('gpt-5.4', 'GPT-5.4'), ('gpt-5.5', 'GPT-5.5'), ('gpt-5.5-pro', 'GPT-5.5 Pro'), ('gpt-6-astra', 'GPT-6 Astra'), ('gpt-6-luna', 'GPT-6 Luna'), ('gpt-6-sol', 'GPT-6 Sol'), ('gpt-6.1-sol', 'GPT-6.1 Sol'), ('daybreak-blue', 'Daybreak Blue')])
      (id: id, name: name),
  ];
  final models = <Json>[
    {'id': 'gpt-pool', 'name': 'GPT 主力', 'provider': 'dreamflutter', 'reasoning': true, 'input': ['text', 'image'], 'contextWindow': 400000, 'maxTokens': 8192},
    {'id': 'daily', 'name': '日常', 'provider': 'dreamflutter', 'reasoning': true, 'input': ['text'], 'contextWindow': 128000, 'maxTokens': 8192},
    for (final m in chatGpt) model('openai', m.id, m.name, image: true),
    model('df-ra', 'gpt-6.1-sol', 'GPT-6.1 Sol'), model('df-rb', 'gpt-6.1-sol', 'GPT-6.1 Sol'),
    model('df-ds', 'deepseek-v4', 'DeepSeek V4'), model('df-ds', 'deepseek-v4-flash', 'DeepSeek V4 Flash'),
    model('df-glm', 'glm-5.3', 'GLM-5.3'),
  ];
  final now = DateTime.now().millisecondsSinceEpoch;
  Json channel(String id, String provider, String name, String kind, List<({String id, String name})> ms, {bool oauth = false, Json? down, List<String>? common}) => {
    'id': id, 'provider': provider, 'name': name, 'kind': kind, 'oauth': oauth, 'source': oauth ? 'pi' : 'df', 'api': 'openai-completions', 'baseUrl': 'https://api.example.invalid',
    'models': [for (final m in ms) {'id': m.id, 'name': m.name}], 'keys': <Json>[], 'enabled': true, 'unavailable': ?down, 'common': ?common,
  };
  final channels = <Json>[
    channel('pi:openai', 'openai', 'ChatGPT', 'plan', chatGpt, oauth: true, down: {'kind': 'quota', 'message': '', 'until': now + 42 * 60000}, common: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol']),
    channel('glm', 'df-glm', '智谱套餐', 'plan', [(id: 'glm-5.3', name: 'GLM-5.3')]),
    channel('ra', 'df-ra', '中转 A', 'relay', [(id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol')]),
    channel('rb', 'df-rb', '中转 B', 'relay', [(id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol')], down: {'kind': 'balance', 'message': ''}),
    channel('ds', 'df-ds', 'DeepSeek', 'payg', [(id: 'deepseek-v4', name: 'DeepSeek V4'), (id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash')]),
  ];
  final groups = <Json>[
    {'id': 'gpt-pool', 'name': 'GPT 主力', 'allowPaidOverflow': true, 'entries': [
      {'channel': 'pi:openai', 'model': 'gpt-6.1-sol', 'priority': 0},
      {'channel': 'ra', 'model': 'gpt-6.1-sol', 'priority': 1, 'weight': 1},
      {'channel': 'rb', 'model': 'gpt-6.1-sol', 'priority': 1, 'weight': 1},
    ]},
    {'id': 'daily', 'name': '日常', 'allowPaidOverflow': false, 'entries': [
      {'channel': 'glm', 'model': 'glm-5.3', 'priority': 0},
      {'channel': 'ds', 'model': 'deepseek-v4-flash', 'priority': 1},
    ]},
  ];

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

  /// A dialog closes with Escape.
  Future<void> close(WidgetTester t) async {
    await t.sendKeyEvent(LogicalKeyboardKey.escape);
    await wait(t);
  }

  /// A menu closes with a click on empty ground (the title bar).
  Future<void> closeMenu(WidgetTester t) async {
    final size = t.view.physicalSize / t.view.devicePixelRatio;
    await t.tapAt(Offset(size.width - 240, 22));
    await wait(t);
  }

  testWidgets('v0.8.3 model groups', (t) async {
    final root = Directory.systemTemp.createTempSync('df_v083_look_');
    SharedPreferences.setMockInitialValues({'workspace': root.path, 'onboarded': true, 'migratedToCore': true, 'themeMode': 'light'});
    final backend = FakeBackend()..sessionRows = [];
    backend.handlers['gateway.channels'] = (_) => channels;
    backend.handlers['gateway.groups'] = (_) => groups;
    backend.onLaunch = (pi) {
      pi.sessionId = 'look-session';
      pi.extraResponses.addAll({
        'get_state': {'sessionFile': pi.sessionFile, 'sessionId': 'look-session', 'model': models.first, 'thinkingLevel': 'medium', 'isStreaming': false},
        'get_available_models': {'models': models},
        'get_available_thinking_levels': {'levels': ['off', 'low', 'medium', 'high']},
        'df_agent_state': {'agentMode': 'standard', 'planMode': false, 'todos': <Object>[]},
      });
    };
    final agent = AgentController(preferences: (await t.runAsync(Preferences.load))!, backend: backend, sessionStore: SessionStore(sessionsDir: root.path));
    addTearDown(() async {
      await t.pumpWidget(const SizedBox());
      agent.dispose();
      try { root.deleteSync(recursive: true); } catch (_) {}
    });
    await t.binding.setSurfaceSize(const Size(1600, 900));
    await t.pumpWidget(RepaintBoundary(key: key, child: DreamFlutterApp(controller: agent)));
    await t.runAsync(agent.init);
    await t.runAsync(() => agent.refreshGateway(models: true));
    await wait(t);

    // A conversation that moved from the used-up subscription to a relay.
    final pi = backend.pis.single;
    pi.startRun(['帮我把这周的实验记录整理成表格。', for (var i = 1; i <= 14; i++) '第 $i 组：温度、湿度和读数都在附件里，按日期排好，标出异常值。'].join('\n'));
    final failed = {'role': 'assistant', 'content': <Json>[], 'timestamp': now, 'stopReason': 'error', 'errorMessage': 'You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.', 'provider': 'openai', 'model': 'gpt-6.1-sol'};
    pi.emit({'type': 'message_start', 'message': failed});
    pi.emit({'type': 'message_end', 'message': failed});
    pi.emit({'type': 'auto_retry_start', 'attempt': 1, 'maxAttempts': 3, 'delayMs': 0, 'errorMessage': '渠道「ChatGPT」额度用完，换下一个渠道（service temporarily unavailable）'});
    await wait(t);
    backend.push({'event': 'gateway.switched', 'sessionId': 'look-session', 'group': 'GPT 主力', 'from': 'ChatGPT · GPT-6.1 Sol', 'to': '中转 A · GPT-6.1 Sol', 'reason': '额度用完，${DateTime.fromMillisecondsSinceEpoch(now + 42 * 60000).hour.toString().padLeft(2, '0')}:${DateTime.fromMillisecondsSinceEpoch(now + 42 * 60000).minute.toString().padLeft(2, '0')} 恢复', 'toPaid': true});
    final ok = {'role': 'assistant', 'content': [{'type': 'text', 'text': '整理好了：三组实验结果一致，第二组需要复测。表格放在 report.md 里。'}], 'timestamp': now + 1, 'stopReason': 'stop', 'provider': 'df-ra', 'model': 'gpt-6.1-sol', 'usage': {'input': 1200, 'output': 260, 'cacheRead': 0, 'cacheWrite': 0, 'totalTokens': 1460, 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': 0}}};
    pi.emit({'type': 'message_start', 'message': ok});
    pi.emit({'type': 'message_end', 'message': ok});
    pi.emit({'type': 'auto_retry_end', 'success': true});
    pi.finishRun();
    await wait(t);

    for (final dark in [false, true]) {
      final theme = dark ? 'dark' : 'light';
      await agent.setThemeMode(dark ? ThemeMode.dark : ThemeMode.light);
      for (final size in [const Size(1600, 900), const Size(1000, 760)]) {
        final tag = '${size.width.round()}_$theme';
        await t.binding.setSurfaceSize(size);
        agent.showSection(AppSection.chat);
        await wait(t);
        await shot(t, 'conversation_switch_$tag');
        await t.tap(find.byKey(const ValueKey('composer-model')));
        await wait(t);
        await shot(t, 'composer_menu_$tag');
        await close(t);

        agent.showSection(AppSection.settings);
        await wait(t);
        await t.tap(find.byKey(const ValueKey('settings-nav-模型')));
        await wait(t);
        // The page keeps its scroll from the previous round: back to the top.
        await t.scrollUntilVisible(find.byKey(const ValueKey('model-menu-对话模型')), -300, scrollable: find.descendant(of: find.byKey(const ValueKey('settings-模型')), matching: find.byType(Scrollable)).first);
        await wait(t);
        await t.tap(find.byKey(const ValueKey('model-menu-对话模型')));
        await wait(t);
        await shot(t, 'settings_model_menu_$tag');
        await closeMenu(t);
        await t.scrollUntilVisible(find.text('新建模型组'), 200, scrollable: find.descendant(of: find.byKey(const ValueKey('settings-模型')), matching: find.byType(Scrollable)).first);
        await wait(t);
        await shot(t, 'settings_groups_$tag');

        await t.ensureVisible(find.text('GPT 主力').first);
        await wait(t);
        await t.tap(find.text('GPT 主力').first);
        await wait(t);
        if (find.text('订阅用完后，转到按量付费的渠道').evaluate().isEmpty) await t.tap(find.text('高级').last);
        await wait(t);
        await shot(t, 'group_editor_$tag');
        await t.tap(find.byKey(const ValueKey('group-add')));
        await wait(t);
        await shot(t, 'group_add_$tag');
        await close(t);
        await t.pageBack();
        await wait(t);

        await t.scrollUntilVisible(find.text('常用模型').first, 200, scrollable: find.descendant(of: find.byKey(const ValueKey('settings-模型')), matching: find.byType(Scrollable)).first);
        await t.tap(find.text('常用模型').first);
        await wait(t);
        await shot(t, 'common_models_$tag');
        await close(t);
      }
    }
  });
}
