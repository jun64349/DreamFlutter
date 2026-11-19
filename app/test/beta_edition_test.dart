// 内测版（第 6 步朋友内测，用户 2026-11-19 定，docs/design/beta-pool.md）。
// 只在打内测包的开关下跑：flutter test --dart-define=DREAMFLUTTER_BETA=true test/beta_edition_test.dart
import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/beta_edition.dart';
import 'package:dreamflutter/ui/beta_activation.dart';
import 'package:dreamflutter/ui/about_panel.dart';
import 'package:dreamflutter/ui/conversation_cards.dart' show explainModelError;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 't88_fixture.dart';

void main() {
  if (!kBetaEdition) {
    test('内测版测试只在 DREAMFLUTTER_BETA=true 下跑', () {}, skip: '普通版');
    return;
  }

  testWidgets('激活：只有一张卡片，坏激活码说不对，好激活码成功后进入，四个用途写死', (t) async {
    final f = (await t.runAsync(T88Fixture.create))!;
    await t.binding.setSurfaceSize(const Size(1000, 800));
    addTearDown(() async { await t.pumpWidget(const SizedBox()); await t.runAsync(f.dispose); });
    var good = false;
    f.backend.handlers['gateway.saveChannel'] = (_) => 'c9';
    f.backend.handlers['gateway.channels'] = (_) => [{'id': 'c9', 'name': betaChannelName, 'provider': 'df-c9', 'platform': 'openai-relay', 'kind': 'relay', 'api': 'openai-completions', 'baseUrl': betaBaseUrl, 'models': betaModels(), 'keys': [{'id': 'k', 'label': '', 'enabled': true, 'hint': 'abcd'}], 'enabled': true}];
    f.backend.handlers['setup.testChannel'] = (_) => good ? {'ok': true} : {'ok': false, 'error': 'API Key 无效或没有权限（401）'};
    var completed = false;
    await t.pumpWidget(DreamFlutterApp(controller: f.agent, home: BetaActivation(status: {'dataRoot': f.root.path}, onComplete: () => completed = true)));
    await t.pumpAndSettle();
    expect(find.text('输入激活码'), findsOneWidget);
    expect(find.text('下一步'), findsNothing);
    expect(find.text('跳过'), findsNothing);

    await t.enterText(find.byKey(const ValueKey('beta-activation-key')), 'sk-bad');
    await t.pump(const Duration(milliseconds: 400));
    await t.pumpAndSettle();
    expect(find.text('激活码不对或已经停用'), findsOneWidget);
    await t.tap(find.text('进入'));
    await t.pumpAndSettle();
    expect(completed, isFalse);

    good = true;
    await t.enterText(find.byKey(const ValueKey('beta-activation-key')), 'sk-good');
    await t.pump(const Duration(milliseconds: 400));
    await t.pumpAndSettle();
    expect(find.text('激活成功'), findsOneWidget);
    await t.tap(find.text('进入'));
    await t.pumpAndSettle();
    expect(completed, isTrue);

    final saved = f.backend.callsTo('gateway.saveChannel').last;
    expect(saved['baseUrl'], betaBaseUrl);
    expect((saved['keys'] as List).single, {'secret': 'sk-good'});
    final done = f.backend.callsTo('setup.complete').single;
    expect(done['models'], {'conversation': 'df-c9/$betaTerra', 'small': 'df-c9/$betaTerra', 'large': 'df-c9/$betaSol', 'vision': 'df-c9/$betaTerra'});
    expect(done['userName'], '');
    expect(done['defaultWorkspace'], isNull);
  });

  test('额度用完和 Key 停用：激活和对话里都说明白（随想 2026-11-19 实测的原文）', () {
    const quota = '请求太频繁或额度用完了（429: {"code":"API_KEY_QUOTA_EXHAUSTED","message":"API key 额度已用完"}）';
    const invalid = 'API Key 无效或没有权限（401: {"code":"INVALID_API_KEY","message":"您的 API Key 无效或已停用"}）';
    expect(betaActivationError(StateError(quota)), '这个激活码的额度已经用完');
    expect(betaActivationError(StateError(invalid)), '激活码不对或已经停用');
    expect(betaActivationError(StateError('fetch failed')), '暂时连不上，检查网络后再试');
    expect(explainModelError('429: {"code":"API_KEY_QUOTA_EXHAUSTED","message":"API key 额度已用完"}'), '激活码的额度用完了，请找发给你激活码的人');
    expect(explainModelError('401: {"code":"INVALID_API_KEY"}'), '激活码不对或已经停用，请找发给你激活码的人');
    expect(explainModelError('request timed out'), '模型太久没有回应，这次请求超时了');
  });

  testWidgets('不露出中转站：模型只写名字，Terra 和 Sol 后面标用途', (t) async {
    final f = (await t.runAsync(T88Fixture.create))!;
    addTearDown(() async { await t.runAsync(f.dispose); });
    expect(f.agent.providerLabel('df-c1'), '');
    expect(f.agent.modelWithProvider('GPT-6.1 Terra', 'df-c1'), 'GPT-6.1 Terra');
    expect(f.agent.memberLabel('df-c1', 'flash'), 'DeepSeek-V4.1-Flash');
    expect(betaChannelName, isNot(contains('随想')));
    expect(betaModelNote(betaTerra), '日常对话、工作任务');
    expect(betaModelNote(betaSol), '困难、深度任务');
  });

  testWidgets('关于：写内测版，有反馈按钮，没有检查更新', (t) async {
    final f = (await t.runAsync(T88Fixture.create))!;
    await t.binding.setSurfaceSize(const Size(1000, 800));
    addTearDown(() async { await t.pumpWidget(const SizedBox()); await t.runAsync(f.dispose); });
    f.backend.handlers['updates.status'] = (_) => {'state': 'idle', 'application': {'version': '1.0.0-preview.1'}};
    await t.pumpWidget(DreamFlutterApp(controller: f.agent, home: const Scaffold(body: SingleChildScrollView(child: AboutPanel()))));
    await t.pumpAndSettle();
    expect(find.text('反馈问题 ↗'), findsOneWidget);
    expect(find.text('检查更新'), findsNothing);
    expect(find.text('自动检查更新'), findsNothing);
  });
}
