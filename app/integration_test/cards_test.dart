import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/ui/card_view.dart' show CardBlock, CardView, showCardDialog;
import 'package:dreamflutter/ui/chat_view.dart' show ChatView;
import 'package:dreamflutter/ui/rich_blocks.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Real window, real core, real WebView2: cards and rich output (v0.2 stage 4).
/// Without a model: a card imported on the workbench proves embedding, isolation,
/// the permission flow and a binding; the renderer draws Mermaid and a chart.
/// With `--dart-define=CARDS_MODEL=1` the agent (DeepSeek) also makes a card
/// and pictures in a conversation. Screenshots: build/card_shots/.
const withModel = bool.fromEnvironment('CARDS_MODEL');

const isolationCard = r'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>隔离测试卡</title>
<script type="application/json" data-card-manifest>{"toolBindings":{"now":{"tool":"time.now"},"hello":{"tool":"fs.read","input":{"dirs":["."]},"description":"读 hello.txt"}}}</script>
<script type="application/json" data-card-state>{"n":0}</script>
</head>
<body>
<h3 style="color:var(--accent);font-family:var(--font-serif)">隔离测试卡</h3>
<p id="out">运行中…</p>
<script>
(async function () {
  var r = {};
  try { r.parentDoc = parent.document.body ? 'reached' : 'none'; } catch (e) { r.parentDoc = 'blocked'; }
  try { r.cookie = typeof document.cookie === 'string' ? 'readable' : 'none'; } catch (e) { r.cookie = 'blocked'; }
  try { localStorage.setItem('x', '1'); r.storage = 'readable'; } catch (e) { r.storage = 'blocked'; }
  try { await fetch('http://127.0.0.1:' + location.port + '/cards/'); r.fetch = 'reached'; } catch (e) { r.fetch = 'blocked'; }
  try { window.top.location.href = 'https://example.com/'; r.navigate = 'allowed'; } catch (e) { r.navigate = 'blocked'; }
  r.origin = String(window.origin);
  var caps = await card.capabilities();
  r.env = caps.ok ? caps.result.environment : caps.code;
  var now = await card.invoke('now');
  r.now = now.ok;
  var hello = await card.invoke('hello', { path: 'hello.txt' });
  r.hello = hello.ok ? hello.result.text : hello.code;
  await card.state.set('probe', r);
  document.getElementById('out').textContent = JSON.stringify(r);
})();
</script>
</body>
</html>
''';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  final shotKey = GlobalKey();
  final shotsDir = Directory(p.join(Directory.current.path, 'build', 'card_shots'))..createSync(recursive: true);

  Future<void> idle(WidgetTester tester, [Duration d = const Duration(milliseconds: 200)]) async {
    await tester.runAsync(() => Future<void>.delayed(d));
    await tester.pump();
  }

  Future<void> shot(WidgetTester tester, String name) async {
    await tester.pump();
    await tester.runAsync(() async {
      final boundary = shotKey.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final image = await boundary.toImage(pixelRatio: 1);
      final png = await image.toByteData(format: ui.ImageByteFormat.png);
      File(p.join(shotsDir.path, '$name.png')).writeAsBytesSync(png!.buffer.asUint8List());
    });
  }

  Future<void> waitFor(WidgetTester tester, String what, FutureOr<bool> Function() condition, {Duration timeout = const Duration(minutes: 1)}) async {
    final deadline = DateTime.now().add(timeout);
    while (true) {
      final done = await tester.runAsync(() async => await condition()) ?? false;
      if (done) return;
      if (DateTime.now().isAfter(deadline)) {
        await shot(tester, 'zz_timeout');
        fail('timed out waiting for $what');
      }
      await idle(tester);
    }
  }

  testWidgets('cards and rich output in the real window', (tester) async {
    final temp = Directory.systemTemp.createTempSync('df_cards_');
    final workspace = Directory(p.join(temp.path, 'workspace'))..createSync();
    final sessionsDir = p.join(temp.path, 'sessions');
    File(p.join(workspace.path, 'hello.txt')).writeAsStringSync('hello from the card test');
    final cardFile = File(p.join(temp.path, 'isolation.card.html'))..writeAsStringSync(isolationCard);
    SharedPreferences.setMockInitialValues({'workspace': workspace.path, 'modelKey': Preferences.defaultModelKey, 'onboarded': true});
    final agent = AgentController(
      preferences: await Preferences.load(),
      sessionStore: SessionStore(sessionsDir: sessionsDir),
      backend: CoreBackend(dataDir: p.join(temp.path, 'core'), extraArgs: ['--session-dir', sessionsDir]),
    );
    addTearDown(() => agent.shutdownCore());
    await tester.pumpWidget(RepaintBoundary(key: shotKey, child: DreamFlutterApp(controller: agent)));
    unawaited(agent.init());
    await waitFor(tester, 'ready', () => agent.isReady);

    // ---- 1. A workbench card, enlarged: embedded, isolated, asks before a binding runs.
    // (Cards kept in 蝶君's 「工作」 get nothing on this machine, so this one stays on the workbench.)
    final imported = await tester.runAsync(() => agent.backend.call('cards.import', {'path': cardFile.path, 'cwd': workspace.path}));
    final cardId = asJsonMap(imported)['id'] as String;
    final card = CardInfo.fromJson(asJsonMap(await tester.runAsync<Object?>(() => agent.backend.call('cards.get', {'id': cardId}))));
    unawaited(showCardDialog(tester.element(find.byType(ChatView)), card));
    await tester.pump();
    await waitFor(tester, 'permission question', () => find.textContaining('想要读取文件').evaluate().isNotEmpty);
    await shot(tester, '01_permission');
    expect(find.textContaining('hello.txt'), findsWidgets, reason: 'the question shows the complete call');
    await tester.tap(find.text('只这一次'));
    await tester.pump();

    Map<String, dynamic> probe = {};
    await waitFor(tester, 'card probe results', () async {
      final state = asJsonMap(await agent.backend.call('cards.request', {'id': cardId, 'capability': 'state.get', 'payload': {'key': 'probe'}}));
      final value = asJsonMap(state['result'])['value'];
      if (value is Map) probe = value.cast();
      return value is Map;
    });
    await idle(tester, const Duration(seconds: 1));
    await shot(tester, '02_card_live');
    // ignore: avoid_print
    print('isolation probe: $probe');
    expect(probe['parentDoc'], 'blocked', reason: 'the card cannot reach the host page');
    expect(probe['storage'], 'blocked', reason: 'opaque origin: no storage');
    expect(probe['cookie'], 'blocked', reason: 'opaque origin: no cookies');
    expect(probe['fetch'], 'blocked', reason: 'CSP: no connections');
    expect(probe['origin'], 'null');
    expect(probe['env'], 'host');
    expect(probe['now'], true);
    expect(probe['hello'], 'hello from the card test');
    final grants = await tester.runAsync(() => agent.backend.call('cards.grants', {'id': cardId}));
    expect(grants, isEmpty, reason: '"只这一次" is not remembered');
    await tester.tap(find.byTooltip('关闭').last);
    await tester.pumpAndSettle();

    // ---- 2. Rich output: Mermaid and a chart drawn by the hidden renderer.
    final mermaid = await tester.runAsync(() => RichRenderer.instance.render('mermaid', 'flowchart LR\n  A[提问] --> B{看懂图?}\n  B -->|能| C[直接看]\n  B -->|不能| D[转述]', css: ':root{--accent:#3f6e5e}', dark: false));
    final chart = await tester.runAsync(
      () => RichRenderer.instance.render('chart', '{"type":"bar","title":"花费","labels":["一月","二月","三月"],"series":[{"name":"元","data":[3,5,2]}]}', css: ':root{}', dark: false),
    );
    File(p.join(shotsDir.path, '03_mermaid.png')).writeAsBytesSync(mermaid!.png);
    File(p.join(shotsDir.path, '04_chart.png')).writeAsBytesSync(chart!.png);
    expect(mermaid.png.length, greaterThan(1000));
    expect(mermaid.svg, contains('<svg'));
    expect(chart.png.length, greaterThan(1000));

    if (!withModel) return;

    // ---- 3. The agent makes a card and pictures in a conversation (DeepSeek).
    await tester.tap(find.text('工作台').first);
    await tester.pumpAndSettle();
    expect(find.textContaining('想要读取文件'), findsNothing, reason: 'closing the enlarged card does not run it again');
    // This step tests cards, not approvals: let the agent act without asking.
    await tester.runAsync(() => agent.updateCoreSettings({'approvalMode': 'off'}));
    final composer = find.byWidgetPredicate((w) => w is TextField && (w.decoration?.hintText ?? '').contains('Enter 发送'));
    await tester.tap(composer);
    await tester.enterText(composer, '请做两件事，不要写任何文件：1. 直接调用 show_card 工具（卡片内容写在 html 参数里）做一张「番茄钟」卡片，有开始和重置按钮，用 card.state 记住完成次数；2. 在回复里用 ```mermaid 画一个三步的流程图，再用 ```chart 画一个三根柱子的柱状图。');
    await tester.pump();
    await tester.tap(find.byTooltip('发送'));
    await tester.pump();
    await waitFor(tester, 'agent reply', () => !agent.isRunning && agent.transcript.tools.values.any((r) => r.name == 'show_card'), timeout: const Duration(minutes: 4));
    await waitFor(tester, 'card block', () => find.byType(CardBlock).evaluate().isNotEmpty && find.byType(CardView).evaluate().isNotEmpty);
    await idle(tester, const Duration(seconds: 4));
    await shot(tester, '05_chat_card');
    final cards = await tester.runAsync(() => agent.backend.call('cards.list', {'resident': false}));
    final chatCard = (cards as List).cast<Map>().first;
    await waitFor(tester, 'snapshot of the live card', () async {
      final info = asJsonMap(await agent.backend.call('cards.get', {'id': chatCard['id']}));
      return info['snapshotAt'] != null;
    });
    // The frame follows the card's content: it does not keep growing (spec §1.7).
    final frame = tester.getSize(find.byType(CardView).first);
    // ignore: avoid_print
    final stored = await tester.runAsync<Object?>(() => agent.backend.call('cards.get', {'id': chatCard['id']}));
    // ignore: avoid_print
    print('card frame: $frame, stored height ${asJsonMap(stored)['height']}');
    expect(frame.height, lessThan(880), reason: 'the card frame shrinks to its content');
    await tester.ensureVisible(find.byType(CardView).first);
    await idle(tester, const Duration(seconds: 1));
    await shot(tester, '06_chat_card_fitted');

    // Mermaid and chart blocks in the reply are drawn as pictures.
    await waitFor(tester, 'rich blocks drawn', () {
      final blocks = find.byType(RichBlock);
      return blocks.evaluate().length >= 2 && find.descendant(of: blocks, matching: find.byType(Image)).evaluate().length >= 2;
    });
    await tester.ensureVisible(find.byType(RichBlock).first);
    await idle(tester, const Duration(seconds: 1));
    await shot(tester, '07_mermaid_in_reply');
    await tester.ensureVisible(find.byType(RichBlock).last);
    await idle(tester, const Duration(seconds: 1));
    await shot(tester, '08_chart_in_reply');
  });
}
