import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:dreamflutter/ui/providers_page.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/theme.dart';
import 'package:flutter/material.dart';
import 'fake_backend.dart';
import 't87_fixture.dart';

void main() {
  testWidgets('legacy channel route tests and saves through documented gateway parameters', (tester) async {
    final f = (await tester.runAsync(T87Fixture.create))!;
    addTearDown(() async { await tester.pumpWidget(const SizedBox()); await tester.runAsync(f.dispose); });
    f.backend.useFixture('gateway.channels');
    f.backend.useFixture('gateway.testChannel');
    f.backend.useFixture('gateway.saveChannel');
    f.backend.handlers['piMigration.status'] = (_) => {'status': 'pending'};
    await tester.binding.setSurfaceSize(const Size(1600, 1000));
    await tester.pumpWidget(AgentScope(controller: f.agent, child: MaterialApp(theme: buildTheme(Brightness.light), home: const ProvidersPage(legacyOnly: true))));
    await tester.pumpAndSettle();
    final channel = (jsonDecode(File('test/fixtures/api/gateway.channels.json').readAsStringSync()) as List).first as Map;
    await tester.tap(find.text('测试连接').first); await tester.pumpAndSettle();
    expect(f.backend.callsTo('gateway.testChannel').single, {'channel': channel['id']});
    await tester.tap(find.text('编辑').first); await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextField, '显示名称'), '改名');
    await tester.tap(find.text('保存').first); await tester.pumpAndSettle();
    final saved = f.backend.callsTo('gateway.saveChannel').single;
    expect(saved['id'], channel['id']); expect(saved['name'], '改名');
    expect(saved['baseUrl'], channel['baseUrl']); expect(saved['api'], channel['api']);
    expect((saved['models'] as List).map((m) => m['id']).toList(), (channel['models'] as List).map((m) => m['id']).toList());
    expect(saved['keys'], [for (final key in channel['keys'] as List) {'id': key['id'], 'label': key['label'], 'enabled': key['enabled']}]);
  });
  test('recorded responses are fresh copies and explicit handlers remain usable', () async {
    final backend = FakeBackend()..useFixture('goals.get');
    addTearDown(backend.dispose);
    final first = await backend.call('goals.get', {'id': 'goal'}) as Map;
    final title = first['title'];
    first['title'] = 'edited by test';
    expect((await backend.call('goals.get', {'id': 'goal'}) as Map)['title'], title);
    expect(backend.callsTo('goals.get').last, {'id': 'goal'});
    backend.handlers['goals.get'] = (_) => null;
    expect(await backend.call('goals.get'), isNull);
  });
  test('gateway channel round trip preserves settings and existing key references', () {
    final rows = jsonDecode(File('test/fixtures/api/gateway.channels.json').readAsStringSync()) as List;
    final channel = ProviderEntry.fromJson((rows.first as Map).cast<String, dynamic>());
    final saved = channel.withKeys(channel.retainedKeys);
    for (final key in ['id', 'name', 'platform', 'kind', 'api', 'baseUrl', 'models', 'authHeader', 'enabled']) {
      expect(saved[key], channel.configuration[key], reason: key);
    }
    expect(saved['keys'], isNotEmpty);
    expect((saved['keys'] as List).first, isNot(contains('secret')));
  });
  test('recorded fixtures contain no host paths or fixture credentials', () {
    for (final file in Directory('test/fixtures/api').listSync(recursive: true).whereType<File>()) {
      final text = file.readAsStringSync();
      expect(text, isNot(contains('fixture-not-a-real-key')), reason: file.path);
      expect(RegExp(r'(?<![A-Za-z])[A-Za-z]:[\\/]').hasMatch(text), isFalse, reason: file.path);
      expect(text, isNot(contains('21669')), reason: file.path);
    }
  });
}
