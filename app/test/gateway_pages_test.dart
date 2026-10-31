import 'dart:io';

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/ui/dashboard_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';

final _channels = [
  {
    'id': 'cglm',
    'source': 'df',
    'provider': 'df-cglm',
    'name': '智谱套餐',
    'platform': 'glm-coding',
    'kind': 'plan',
    'api': 'anthropic-messages',
    'baseUrl': 'https://open.bigmodel.cn/api/anthropic',
    'models': [
      {'id': 'glm-5.3'},
    ],
    'enabled': true,
    'keys': [
      {'id': 'k1', 'label': '', 'enabled': true, 'hint': 'abcd'},
    ],
    'unavailable': {'kind': 'quota', 'message': '1316', 'until': DateTime.now().add(const Duration(hours: 2)).millisecondsSinceEpoch},
  },
  {
    'id': 'pi:ds',
    'source': 'pi',
    'provider': 'ds',
    'name': 'DeepSeek',
    'platform': 'deepseek',
    'kind': 'payg',
    'api': 'openai-completions',
    'baseUrl': 'https://api.deepseek.com/v1',
    'models': [
      {'id': 'deepseek-flash'},
    ],
    'enabled': true,
    'keys': [
      {'id': 'pi', 'label': 'Pi 配置', 'enabled': true, 'hint': ''},
    ],
    'unavailable': null,
  },
  {
    'id': 'crelay',
    'source': 'df',
    'provider': 'df-crelay',
    'name': '随想中转',
    'platform': 'openai-relay',
    'kind': 'relay',
    'api': 'openai-completions',
    'baseUrl': 'https://relay.example.com/v1',
    'models': [
      {'id': 'deepseek-flash'},
    ],
    'enabled': true,
    'keys': [
      {'id': 'k2', 'label': '', 'enabled': true, 'hint': 'wxyz'},
    ],
    'unavailable': null,
  },
];

void main() {
  late FakeBackend backend;
  late AgentController agent;

  Future<void> startApp(WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(1500, 1100));
    SharedPreferences.setMockInitialValues({'workspace': Directory.systemTemp.path});
    final sessions = Directory.systemTemp.createTempSync('df_gw_');
    backend = FakeBackend();
    final groups = <Json>[];
    backend.handlers.addAll({
      'gateway.channels': (_) => _channels,
      'gateway.groups': (_) => groups,
      'gateway.saveGroup': (params) {
        groups
          ..clear()
          ..add({...params, 'id': 'g1'});
        return {'id': 'g1'};
      },
      'gateway.status': (_) => [
        {
          'id': 'cglm',
          'name': '智谱套餐',
          'kind': 'plan',
          'source': 'df',
          'unavailable': _channels[0]['unavailable'],
          'quota': {
            'type': 'plan',
            'windows': [
              {'label': '5 小时', 'usedPercent': 100, 'resetAt': DateTime.now().add(const Duration(hours: 2)).millisecondsSinceEpoch},
            ],
            'checkedAt': DateTime.now().millisecondsSinceEpoch,
          },
          'canQuery': true,
          'today': {'requests': 12, 'failures': 1, 'cost': 0, 'avgFirstTokenMs': 900},
          'last5h': {'requests': 12, 'tokens': 40000},
          'spent': 0,
          'remaining': null,
          'lastError': {'at': DateTime.now().millisecondsSinceEpoch, 'kind': 'quota', 'message': '已达到 5 小时使用上限'},
        },
        {
          'id': 'pi:ds',
          'name': 'DeepSeek',
          'kind': 'payg',
          'source': 'pi',
          'unavailable': null,
          'quota': {'type': 'balance', 'amount': 5.27, 'currency': 'CNY', 'checkedAt': DateTime.now().millisecondsSinceEpoch},
          'canQuery': true,
          'today': {'requests': 30, 'failures': 0, 'cost': 0.12, 'avgFirstTokenMs': 1100},
          'last5h': {'requests': 30, 'tokens': 90000},
          'spent': 0.12,
          'remaining': null,
          'lastError': null,
        },
      ],
      'usage.summary': (params) => params['groupBy'] == 'day'
          ? [
              {'key': _day(DateTime.now()), 'label': '', 'input': 1000, 'output': 200, 'cacheRead': 4000, 'cost': 0.5, 'responses': 4},
            ]
          : params['groupBy'] == 'model'
          ? [
              {'key': 'ds/deepseek-flash', 'label': 'ds/deepseek-flash', 'input': 1000, 'output': 200, 'cacheRead': 4000, 'cost': 0.5, 'responses': 4},
            ]
          : const <Json>[],
    });
    agent = AgentController(
      preferences: await tester.runAsync(Preferences.load) as Preferences,
      sessionStore: SessionStore(sessionsDir: sessions.path),
      backend: backend,
    );
    addTearDown(() {
      agent.dispose();
      sessions.deleteSync(recursive: true);
    });
    await tester.pumpWidget(DreamFlutterApp(controller: agent));
    await tester.runAsync(agent.init);
    await tester.pumpAndSettle();
  }

  Future<void> settle(WidgetTester tester) async {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pumpAndSettle();
  }

  testWidgets('settings list the channels and build a model group with a split tier', (tester) async {
    await startApp(tester);
    expect(agent.providerLabel('df-cglm'), '智谱套餐');
    expect(agent.providerLabel('dreamflutter'), '模型组');

    await tester.tap(find.text('设置'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('模型与网关'));
    await tester.pumpAndSettle();
    expect(find.text('智谱套餐'), findsOneWidget);
    expect(find.textContaining('额度用完'), findsOneWidget, reason: 'a resting channel says why and until when');
    expect(find.text('来自 Pi 配置'), findsOneWidget);

    await tester.tap(find.text('新建模型组'));
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextField, '名称'), '主力');
    for (final label in ['智谱套餐 · glm-5.3', 'DeepSeek · deepseek-flash', '随想中转 · deepseek-flash']) {
      await tester.tap(find.text('＋ 添加模型'));
      await tester.pumpAndSettle();
      await tester.tap(find.text(label).last);
      await tester.pumpAndSettle();
    }
    expect(find.text('套餐用完后允许转到付费渠道'), findsOneWidget, reason: 'a group with a plan offers the switch');
    await tester.tap(find.text('高级：按比例分流'));
    await tester.pumpAndSettle();
    // The relay shares DeepSeek's tier.
    await tester.tap(find.byType(Checkbox).last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('保存'));
    await settle(tester);

    final saved = backend.callsTo('gateway.saveGroup').single;
    expect(saved['name'], '主力');
    expect(saved['allowPaidOverflow'], true);
    final entries = [for (final e in saved['entries'] as List) e as Map];
    expect([for (final e in entries) e['priority']], [0, 1, 1]);
    expect([for (final e in entries) e['weight']], [0.0, 1.0, 1.0], reason: 'weights only in the split tier');
  });

  testWidgets('the dashboard shows channels, allowances and the period totals', (tester) async {
    await startApp(tester);
    await tester.tap(find.text('仪表盘'));
    await settle(tester);
    expect(find.byType(DashboardPage), findsOneWidget);
    expect(find.text('5 小时'), findsOneWidget);
    expect(find.text('100%'), findsOneWidget);
    expect(find.text('余额 5.27 CNY'), findsOneWidget);
    expect(find.textContaining('今天 30 次请求'), findsOneWidget);
    expect(find.text('\$0.50'), findsWidgets);
    await tester.tap(find.text('模型').last);
    await tester.pumpAndSettle();
    expect(find.text('deepseek-flash · DeepSeek'), findsOneWidget, reason: 'models carry their channel name');

    backend.push({'event': 'gateway.switched', 'from': '智谱套餐 · glm-5.3', 'to': 'DeepSeek · deepseek-flash', 'reason': '额度用完', 'toPaid': true});
    await settle(tester);
    expect(find.textContaining('已转到付费渠道「DeepSeek · deepseek-flash」'), findsOneWidget);
  });

  testWidgets('the settings search looks through every category', (tester) async {
    await startApp(tester);
    await tester.tap(find.text('设置'));
    await tester.pumpAndSettle();
    expect(find.text('每月花费上限'), findsNothing, reason: 'the general category opens first');
    await tester.enterText(find.widgetWithText(TextField, '搜索设置'), '花费上限');
    await tester.pumpAndSettle();
    expect(find.text('每天花费上限'), findsOneWidget);
    expect(find.text('每月花费上限'), findsOneWidget);
    expect(find.text('运行上限'), findsWidgets);
    await tester.enterText(find.widgetWithText(TextField, '搜索设置'), '没有这一项');
    await tester.pumpAndSettle();
    expect(find.textContaining('没有找到'), findsOneWidget);
  });
}

String _day(DateTime d) => '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
