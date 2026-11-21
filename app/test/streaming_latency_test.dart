import 'package:dreamflutter/ui/motion.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';

import 'composer_layout_fixture.dart';

const _frame = Duration(milliseconds: 16);

void main() {
  testWidgets('workbench sends immediately and updates streaming replies without rebuilding the shell', (t) async {
    final fixture = await startComposerLayout(t);
    final backend = fixture.backend;
    final agent = fixture.agent;
    final pi = backend.pis.single;
    Future<void> tick() async {
      // The slot is launched in runAsync and its event subscription uses wall
      // time. Advance that clock as well as the controlled rendering clock.
      await t.runAsync(() => Future<void>.delayed(_frame));
      await t.pump(_frame);
    }
    const question = 'QA streaming dispatch';
    final editor = find.byWidgetPredicate((w) => w is TextField && w.decoration?.hintText == '说点什么…');
    final now = t.binding.clock.now;
    DateTime? dispatched;
    pi.onCommand = (command) {
      if (command['type'] == 'prompt') dispatched = now();
    };
    await t.enterText(editor, question);
    await t.pumpAndSettle();
    final keyAt = now();
    await t.sendKeyEvent(LogicalKeyboardKey.enter);
    expect(pi.sent('prompt'), hasLength(1));
    final keyToWire = dispatched!.difference(keyAt).inMilliseconds;

    pi.startRun(question);
    final acceptedAt = now();
    int? userPaintMs;
    for (var i = 0; i < 14; i++) {
      await tick();
      if (userPaintMs == null && find.text(question, findRichText: true).evaluate().isNotEmpty) {
        userPaintMs = now().difference(acceptedAt).inMilliseconds;
      }
    }
    const assistant = {'role': 'assistant', 'content': [], 'timestamp': 2, 'stopReason': 'stop'};
    pi.emit({'type': 'turn_start'});
    pi.emit({'type': 'message_start', 'message': assistant});
    void delta(String text) => pi.emit({
      'type': 'message_update',
      'message': assistant,
      'assistantMessageEvent': {'type': 'text_delta', 'contentIndex': 0, 'delta': text},
    });
    Finder reply(String text) => find.textContaining(text, findRichText: true);
    final firstAt = now();
    delta('First visible reply. ');
    int? firstPaintMs;
    var animatedFirstReply = false;
    double? initialOpacity;
    for (var i = 0; i < 6; i++) {
      await tick();
      if (firstPaintMs == null && reply('First visible reply.').evaluate().isNotEmpty) {
        firstPaintMs = now().difference(firstAt).inMilliseconds;
        final entry = find.ancestor(of: reply('First visible reply.'), matching: find.byType(FadeSlideIn)).first;
        animatedFirstReply = t.widget<FadeSlideIn>(entry).animate;
        final fade = find.descendant(of: entry, matching: find.byType(FadeTransition)).first;
        initialOpacity = t.widget<FadeTransition>(fade).opacity.value;
      }
    }

    var shellNotifications = 0;
    void count() => shellNotifications++;
    agent.addListener(count);
    var nextFrame = 0;
    final paintElapsed = Stopwatch()..start();
    for (var i = 0; i < 18; i++) {
      final sentinel = 'fragment-$i;';
      delta(sentinel);
      await tick();
      if (reply(sentinel).evaluate().isNotEmpty) nextFrame++;
    }
    paintElapsed.stop();
    agent.removeListener(count);
    final finalText = 'First visible reply. ${List.generate(18, (i) => 'fragment-$i;').join()}';
    pi.emit({'type': 'message_end', 'message': {...assistant, 'content': [{'type': 'text', 'text': finalText}]}});
    pi.finishRun();
    await t.pumpAndSettle();
    expect(reply(finalText), findsOneWidget);
    expect(agent.transcript.items.whereType<AssistantItem>().single.streaming, isFalse);

    debugPrint('workbench stream: keyToWire=${keyToWire}ms ackToUser=${userPaintMs}ms '
        'firstDeltaToText=${firstPaintMs}ms animatedEntry=$animatedFirstReply initialOpacity=$initialOpacity '
        'nextFrame=$nextFrame/18 shellNotifications=$shellNotifications wall=${paintElapsed.elapsedMilliseconds}ms');
    if (!const bool.fromEnvironment('STREAM_PROBE_BASELINE')) {
      expect(keyToWire, 0);
      expect(userPaintMs, 16);
      expect(firstPaintMs, 16);
      expect(animatedFirstReply, isTrue);
      expect(initialOpacity, greaterThanOrEqualTo(0.8));
      expect(nextFrame, 18);
      expect(shellNotifications, 0);
    }
  });
}
