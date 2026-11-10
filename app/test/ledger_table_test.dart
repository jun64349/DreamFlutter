import 'dart:io';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/gateway_pages.dart' show describeQuota;
import 'package:dreamflutter/ui/ledger_table.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'fake_backend.dart';

void main() {
  for (final brightness in Brightness.values) {
    testWidgets('ledger range and groups expose currencies, sources, missing usage and history at 150% $brightness', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1300, 1000));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      SharedPreferences.setMockInitialValues({});
      final root = Directory.systemTemp.createTempSync('df-t68-widget-'), backend = FakeBackend();
      var fail = false, empty = false;
      backend.handlers['ledger.summary'] = (p) {
        expect((p['until'] as num) > (p['since'] as num), isTrue);
        if (fail) throw CoreException('synthetic', '合成查询失败，请重试');
        return {'timeZone': 'Asia/Taipei', 'rows': empty ? <Json>[] : [
          {'period': '2026-11-07', 'key': p['groupBy'] == 'purpose' ? 'compaction' : 'synthetic/model', 'requests': 3, 'successRate': 0.5, 'knownStatuses': 2,
            'input': 100, 'output': 30, 'cacheRead': 20, 'cacheWrite': 10, 'reasoning': 12, 'tokenKnown': 2, 'reasoningKnown': 1,
            'amounts': {'USD': 0.00412, 'CNY': 0.005}, 'amountSources': {'provider_actual': 1, 'price_estimate': 1, 'missing': 1},
            'allowance': {'USD:provider': 0.12, 'GLM_POINTS:local_estimate': 15.75}, 'historical': 1, 'missingUsage': 1, 'ttftMs': 321, 'latencyCount': 1},
        ]};
      };
      backend.handlers['ledger.entries']=(_)=>empty?<Json>[]:[{'requested_at':DateTime(2026,11,7).millisecondsSinceEpoch,'purpose':'compaction','provider':'synthetic','model':'model','amount':0.00412,'currency':'USD','amount_source':'price_estimate'}];
      final agent = AgentController(preferences: await Preferences.load(), sessionStore: SessionStore(sessionsDir: root.path), backend: backend);
      addTearDown(() { agent.dispose(); root.deleteSync(recursive: true); });
      const capture = bool.fromEnvironment('T68_CAPTURE');
      if (capture) {
        await tester.runAsync(() async { final loader = FontLoader('T68Capture')..addFont(Future.value(ByteData.sublistView(await File('C:/Windows/Fonts/msyh.ttc').readAsBytes()))); await loader.load(); });
      }
      final theme = buildTheme(brightness);
      await tester.pumpWidget(AgentScope(controller: agent, child: MaterialApp(
        theme: capture ? theme.copyWith(textTheme: theme.textTheme.apply(fontFamily: 'T68Capture')) : theme,
        builder: (context, child) => MediaQuery(data: MediaQuery.of(context).copyWith(textScaler: const TextScaler.linear(1.5)), child: child!),
        home: const Scaffold(body: SingleChildScrollView(child: Padding(padding: EdgeInsets.all(16), child: LedgerTable()))),
      )));
      await tester.pumpAndSettle();
      expect(find.byType(DataTable),findsOneWidget);expect(tester.widget<DataTable>(find.byType(DataTable)).columns.length,4);expect(find.text('输入'),findsNothing);expect(find.text('时间归组'),findsNothing);
      await tester.ensureVisible(find.text('高级'));await tester.tap(find.text('高级'));await tester.pumpAndSettle();
      expect(find.text('整理上下文'), findsWidgets); expect(find.text('USD 0.00412\nCNY 0.005'), findsOneWidget);
      expect(find.textContaining('按价格估算 1 笔'), findsOneWidget); expect(find.textContaining('1 次计量缺失'), findsOneWidget);
      expect(find.textContaining('GLM_POINTS 15.75'), findsOneWidget); expect(find.text('历史导入'), findsOneWidget);
      if (capture) { await expectLater(find.byType(Scaffold), matchesGoldenFile('../../Claude Codex Bridge/T68-ledger-${brightness.name}-150.png')); }
      await tester.drag(find.byKey(const ValueKey('ledger-horizontal')), const Offset(-2300, 0)); await tester.pumpAndSettle();
      if (capture) { await expectLater(find.byType(Scaffold), matchesGoldenFile('../../Claude Codex Bridge/T68-ledger-${brightness.name}-150-money.png')); }
      await tester.tap(find.byType(DropdownButtonFormField<String>).first); await tester.pumpAndSettle(); await tester.tap(find.text('按月').last); await tester.pumpAndSettle();
      expect(backend.callsTo('ledger.summary').last['period'], 'month');
      await tester.tap(find.byType(DropdownButtonFormField<String>).last); await tester.pumpAndSettle(); await tester.tap(find.text('模型').last); await tester.pumpAndSettle();
      expect(backend.callsTo('ledger.summary').last['groupBy'], 'model');
      fail = true; await tester.tap(find.text('刷新账目')); await tester.pumpAndSettle();
      expect(find.textContaining('合成查询失败'), findsOneWidget);
      fail = false; empty = true; await tester.tap(find.text('刷新账目')); await tester.pumpAndSettle();
      expect(find.text('这个时间范围内没有请求记录'), findsOneWidget); expect(tester.takeException(), isNull);
    });
  }

  test('quota copy never calls unknown values zero and lists every currency without inferring plan remaining', () {
    final bad = ChannelStatus.fromJson({'id': 'bad', 'kind': 'plan', 'remaining': 100, 'quota': {'type': 'plan', 'windows': [{'label': '5 小时', 'usedPercent': null}]}});
    expect(describeQuota(bad), contains('未知')); expect(describeQuota(bad), isNot(contains('0%')));
    final multi = ChannelStatus.fromJson({'id': 'multi', 'quota': {'type': 'balance', 'amount': 8, 'currency': 'CNY', 'balances': [{'amount': 8, 'currency': 'CNY'}, {'amount': 2, 'currency': 'USD'}]}});
    expect(describeQuota(multi), contains('CNY')); expect(describeQuota(multi), contains('USD'));
    final missing = ChannelStatus.fromJson({'id': 'missing', 'quota': {'type': 'balance', 'amount': null, 'currency': 'CNY'}});
    expect(describeQuota(missing), contains('未知'));
    final plan = ChannelStatus.fromJson({'id': 'plan', 'kind': 'plan', 'remaining': 100}); expect(describeQuota(plan), isNot(contains('剩余')));
  });
}
