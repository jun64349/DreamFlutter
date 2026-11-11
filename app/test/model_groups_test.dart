import 'dart:io';

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/model_group_pages.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';

/// 0.8.3 model groups in the window (docs/design/model-groups.md): the lists put groups first and
/// show only a channel's common models, a switch shows as one line in the conversation, the group
/// editor saves the queue, and a channel's common models can be chosen.
void main() {
  late Directory root;
  late FakeBackend backend;
  late AgentController agent;

  final group = <String, dynamic>{'id': 'daily', 'name': '日常', 'provider': 'dreamflutter', 'reasoning': false, 'input': ['text'], 'contextWindow': 200000, 'maxTokens': 4096};
  Json model(String provider, String id, String name) => {'id': id, 'name': name, 'provider': provider, 'reasoning': false, 'input': ['text'], 'contextWindow': 200000, 'maxTokens': 4096};
  final models = [group, model('df-ca', 'a1', 'A 一号'), model('df-ca', 'a2', 'A 二号'), model('df-ca', 'a3', 'A 三号'), model('df-cb', 'b1', 'GPT 甲')];
  final channels = <Json>[
    {'id': 'ca', 'provider': 'df-ca', 'name': '中转 A', 'kind': 'relay', 'models': [{'id': 'a1', 'name': 'A 一号'}, {'id': 'a2', 'name': 'A 二号'}, {'id': 'a3', 'name': 'A 三号'}], 'keys': <Json>[], 'common': ['a1']},
    {'id': 'cb', 'provider': 'df-cb', 'name': 'ChatGPT', 'kind': 'plan', 'models': [{'id': 'b1', 'name': 'GPT 甲'}], 'keys': <Json>[]},
  ];
  final groups = <Json>[
    {'id': 'daily', 'name': '日常', 'entries': [{'channel': 'cb', 'model': 'b1', 'priority': 0}, {'channel': 'ca', 'model': 'a1', 'priority': 1}], 'allowPaidOverflow': true},
  ];

  Future<void> settle(WidgetTester tester) async {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 40)));
    await tester.pumpAndSettle();
  }

  Future<void> start(WidgetTester tester, {Widget? child}) async {
    await tester.binding.setSurfaceSize(const Size(1400, 900));
    root = Directory.systemTemp.createTempSync('df_model_groups_');
    SharedPreferences.setMockInitialValues({'workspace': root.path, 'onboarded': true});
    backend = FakeBackend()..sessionRows = [];
    backend.handlers['gateway.channels'] = (_) => channels;
    backend.handlers['gateway.groups'] = (_) => groups;
    backend.onLaunch = (pi) {
      pi.sessionId = 'mg-session';
      pi.extraResponses.addAll({
        'get_state': {'sessionFile': pi.sessionFile, 'sessionId': 'mg-session', 'model': group, 'thinkingLevel': 'off', 'isStreaming': false},
        'get_available_models': {'models': models},
        'get_available_thinking_levels': {'levels': ['off']},
        'df_agent_state': {'agentMode': 'standard', 'planMode': false, 'todos': <Object>[]},
      });
    };
    agent = AgentController(preferences: (await tester.runAsync(Preferences.load))!, backend: backend, sessionStore: SessionStore(sessionsDir: root.path));
    if (child == null) {
      await tester.pumpWidget(DreamFlutterApp(controller: agent));
    }
    await tester.runAsync(agent.init);
    await tester.runAsync(() => agent.refreshGateway(models: true));
    if (child != null) {
      await tester.pumpWidget(AgentScope(controller: agent, child: MaterialApp(theme: buildTheme(Brightness.light), home: Scaffold(body: child))));
    }
    await settle(tester);
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      agent.dispose();
      try { root.deleteSync(recursive: true); } catch (_) {}
      await tester.binding.setSurfaceSize(null);
    });
  }

  testWidgets('model lists put groups first and show a channel\'s common models; 「更多模型…」 finds the rest', (tester) async {
    await start(tester);
    expect([for (final s in agent.modelSections()) s.title], ['模型组', '中转 A', 'ChatGPT']);
    expect([for (final m in agent.modelSections()[1].models) m.id], ['a1'], reason: 'a channel shows only its common models');
    expect(agent.hasMoreModels, isTrue);
    // User 0.8.3: the chip read 「Fau…」 with room to spare; it says the whole name and where it comes from.
    final label = find.descendant(of: find.byKey(const ValueKey('composer-model')), matching: find.text('日常 · 模型组'));
    expect(label, findsOneWidget);
    expect(tester.renderObject<RenderParagraph>(label).didExceedMaxLines, isFalse);

    await tester.tap(find.byKey(const ValueKey('composer-model')));
    await tester.pumpAndSettle();
    expect(find.text('模型组'), findsOneWidget);
    expect(find.text('A 一号'), findsOneWidget);
    expect(find.text('A 二号'), findsNothing);
    await tester.tap(find.text('更多模型…'));
    await settle(tester);
    expect(find.text('所有模型'), findsOneWidget);
    await tester.tap(find.text('A 二号'));
    await settle(tester);
    final setModel = backend.pis.single.commands.lastWhere((c) => c['type'] == 'set_model');
    expect([setModel['provider'], setModel['modelId']], ['df-ca', 'a2']);
  });

  testWidgets('a switch shows as one line in the conversation; the gateway\'s own retry line does not; the member shows on the model button', (tester) async {
    await start(tester);
    final pi = backend.pis.single;
    pi.startRun('你好');
    final failed = {'role': 'assistant', 'content': <Json>[], 'timestamp': 2, 'stopReason': 'error', 'errorMessage': 'You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.', 'provider': 'df-cb', 'model': 'b1'};
    pi.emit({'type': 'message_start', 'message': failed});
    pi.emit({'type': 'message_end', 'message': failed});
    pi.emit({'type': 'auto_retry_start', 'attempt': 1, 'maxAttempts': 3, 'delayMs': 0, 'errorMessage': '渠道「ChatGPT」额度用完，换下一个渠道（service temporarily unavailable）'});
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    backend.push({'event': 'gateway.switched', 'sessionId': 'mg-session', 'group': '日常', 'from': 'ChatGPT · b1', 'to': '中转 A · a1', 'reason': '额度用完，16:20 恢复', 'toPaid': true});
    final ok = {'role': 'assistant', 'content': [{'type': 'text', 'text': '你好呀。'}], 'timestamp': 3, 'stopReason': 'stop', 'provider': 'df-ca', 'model': 'a1'};
    pi.emit({'type': 'message_start', 'message': ok});
    pi.emit({'type': 'message_end', 'message': ok});
    pi.emit({'type': 'auto_retry_end', 'success': true});
    pi.finishRun();
    await settle(tester);

    expect(find.textContaining('ChatGPT · b1 额度用完，16:20 恢复，换到 中转 A · a1'), findsOneWidget);
    expect(find.textContaining('正在重试'), findsNothing, reason: 'the gateway moving to another channel is not an error to retry');
    expect(find.textContaining('service temporarily unavailable'), findsNothing);
    expect(find.text('你好呀。'), findsOneWidget);
    expect(agent.currentGroupMember, '中转 A · A 一号');
    expect(find.byTooltip('模型组「日常」：现在用 中转 A · A 一号'), findsOneWidget);
  });

  testWidgets('the group editor adds several models at once, shares a tier, and saves the queue', (tester) async {
    await start(tester, child: Builder(builder: (context) => TextButton(onPressed: () => GroupList.open(context, null), child: const Text('打开'))));
    backend.handlers['gateway.saveGroup'] = (_) => {'id': 'g-new'};
    await tester.tap(find.text('打开'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('group-name')), 'GPT 主力');
    await tester.tap(find.byKey(const ValueKey('group-add')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('GPT 甲'));
    await tester.tap(find.text('A 三号'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('添加 2 个'));
    await tester.pumpAndSettle();
    expect(find.text('ChatGPT'), findsOneWidget);
    expect(find.text('中转 A'), findsOneWidget);

    // Leaving with unsaved changes asks first.
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.text('改动还没保存'), findsOneWidget);
    await tester.tap(find.text('继续编辑'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('高级'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('group-share-1')));
    await tester.tap(find.byKey(const ValueKey('group-allow-paid')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('group-save')));
    await settle(tester);
    final saved = backend.calls.lastWhere((c) => c.method == 'gateway.saveGroup').params;
    expect(saved['name'], 'GPT 主力');
    expect(saved['allowPaidOverflow'], isFalse);
    expect(saved['entries'], [
      {'channel': 'cb', 'model': 'b1', 'priority': 0, 'weight': 1},
      {'channel': 'ca', 'model': 'a3', 'priority': 0, 'weight': 1},
    ], reason: 'members join in the order they were ticked; 和上一个轮流用 puts both in one tier sharing by weight');
    expect(find.text('打开'), findsOneWidget, reason: 'a new group closes its page once saved');
  });

  testWidgets('a channel\'s common models can be chosen, and go back to the default', (tester) async {
    await start(tester, child: Builder(builder: (context) => TextButton(onPressed: () => showDialog<void>(context: context, builder: (_) => CommonModelsDialog(channel: agent.gatewayChannels.first)), child: const Text('打开'))));
    backend.handlers['gateway.setCommonModels'] = (_) => {'ok': true};
    await tester.tap(find.text('打开'));
    await tester.pumpAndSettle();
    expect(find.text('保存（1 个）'), findsOneWidget);
    await tester.tap(find.text('A 二号'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('保存（2 个）'));
    await settle(tester);
    expect(backend.calls.lastWhere((c) => c.method == 'gateway.setCommonModels').params, {'channel': 'ca', 'models': ['a1', 'a2']});
    await tester.tap(find.text('打开'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('恢复默认'));
    await settle(tester);
    expect(backend.calls.lastWhere((c) => c.method == 'gateway.setCommonModels').params, {'channel': 'ca', 'models': null});
  });
}
