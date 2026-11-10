import 'dart:io';

import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/mentions.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/card_view.dart';
import 'package:dreamflutter/ui/web_surface.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';

void main() {
  test('documents travel as text, large ones by path for read_document', () {
    final text = composeWithMentions('总结一下', const [
      Mention(kind: MentionKind.document, title: '报告.pdf', path: r'C:\docs\报告.pdf', content: '--- 第 1 页 ---\n正文'),
      Mention(kind: MentionKind.document, title: '大表.xlsx', path: r'C:\docs\大表.xlsx'),
    ]);
    expect(text, contains('<文档 标题="报告.pdf" 路径="C:\\docs\\报告.pdf">\n--- 第 1 页 ---\n正文\n</文档>'));
    expect(text, contains('read_document'));
    final (clean, back) = splitMentions(text);
    expect(clean, '总结一下');
    expect(back.map((m) => (m.kind, m.title, m.path)), [
      (MentionKind.document, '报告.pdf', r'C:\docs\报告.pdf'),
      (MentionKind.document, '大表.xlsx', r'C:\docs\大表.xlsx'),
    ]);
    expect(back.first.content, '--- 第 1 页 ---\n正文');
    expect(back.last.content, isNull, reason: 'the large one went by path');
    expect(documentExtensions, containsAll(['pdf', 'docx', 'xlsx', 'pptx', 'md']));
  });

  test('the latest card and the one clicked are live; history waits for a touch', () async {
    final stage = CardStage();
    final transcript = Transcript();
    expect(latestCardId(transcript), isNull);
    stage.setLatest('c_new');
    stage.activate('c_old');
    expect(stage.isLive('c_new'), isTrue);
    expect(stage.isLive('c_old'), isTrue);
    expect(stage.isLive('c_other'), isFalse);
    expect(stage.armed('c_new'), isFalse, reason: 'restored from history, not touched');
    expect(stage.armed('c_old'), isTrue, reason: 'clicking it is a gesture');
    stage.markFresh('c_minted');
    expect(stage.armed('c_minted'), isTrue);
    stage.activate('c_third');
    expect(stage.isLive('c_old'), isFalse, reason: 'only one clicked card at a time');
  });

  testWidgets('a shown card loads its entity; without WebView2 it says so', (tester) async {
    SharedPreferences.setMockInitialValues({'workspace': Directory.systemTemp.path, 'onboarded': true});
    final backend = FakeBackend();
    backend.handlers['cards.get'] = (params) => {
      'id': params['id'],
      'title': '计数器',
      'origin': 'agent',
      'resident': false,
      'epoch': 1,
      'version': 1,
      'updatedAt': 0,
      'bindings': [
        {'id': 'w', 'tool': 'fetch.request', 'label': '经宿主访问网络', 'known': true, 'units': [{'kind': 'net', 'subject': 'api.example.com'}]},
      ],
    };
    WebSurfaces.create = () async => null;
    final sessions = Directory.systemTemp.createTempSync('df_cards_');
    final agent = AgentController(
      preferences: await tester.runAsync(Preferences.load) as Preferences,
      sessionStore: SessionStore(sessionsDir: sessions.path),
      backend: backend,
    );
    addTearDown(() { agent.dispose(); sessions.deleteSync(recursive: true); });
    final run = ToolRun('t1', 'show_card')
      ..args = {'title': '计数器'}
      ..status = ToolStatus.done
      ..details = {'cardId': 'c_0123456789abcdef'};
    agent.cardStage.setLatest('c_0123456789abcdef');
    await tester.pumpWidget(
      AgentScope(
        controller: agent,
        child: MaterialApp(theme: buildTheme(Brightness.light), home: Scaffold(body: SingleChildScrollView(child: CardBlock(run: run)))),
      ),
    );
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pumpAndSettle();
    expect(find.text('计数器'), findsOneWidget);
    expect(find.textContaining('WebView2'), findsOneWidget);
    expect(find.byTooltip('放大'), findsOneWidget);

    await tester.tap(find.byTooltip('更多'));
    await tester.pumpAndSettle();
    // The desk is 蝶君's 「工作」 now: workbench cards are not kept there.
    expect(find.text('收进「工作」'), findsNothing);
    expect(find.text('导出…'), findsOneWidget);
    expect(find.text('权限'), findsOneWidget);
    await tester.tapAt(Offset.zero);
    await tester.pumpAndSettle();

    // In a conversation with 蝶君 they are.
    final butterfly = AgentController(preferences: agent.preferences, sessionStore: agent.sessionStore, backend: backend, sandbox: true, parentController: agent);
    addTearDown(butterfly.dispose);
    await tester.pumpWidget(
      AgentScope(
        controller: butterfly,
        child: MaterialApp(theme: buildTheme(Brightness.light), home: Scaffold(body: SingleChildScrollView(child: CardBlock(run: run)))),
      ),
    );
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('更多'));
    await tester.pumpAndSettle();
    expect(find.text('收进「工作」'), findsOneWidget);
  });

  test('theme variables are plain values cards can read', () {
    final vars = cardThemeVars(fg: '#111111', muted: '#222222', bg: '#333333', surface: '#444444', border: '#555555', accent: '#666666', chart: ['#777777', '#888888'], dark: false);
    expect(themeCssOf(vars), startsWith(':root{--fg:#111111;'));
    expect(vars['--chart'], '#777777,#888888');
    expect(AppTokens.radius, greaterThan(0));
  });
}
