import 'dart:io';

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';
import 'fake_pi.dart';

/// Reading a conversation while it grows, and copying from it (v0.3.2 test):
/// the wheel could not scroll up while a reply streamed, and under interface
/// zoom a drag selected text paragraphs below the mouse, or nothing.
void main() {
  late FakeBackend backend;
  late AgentController agent;
  late Directory sessions;
  late FakePi pi;
  var ts = 10;

  Future<void> startApp(WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(1400, 900));
    SharedPreferences.setMockInitialValues({'workspace': Directory.systemTemp.path, 'onboarded': true});
    sessions = Directory.systemTemp.createTempSync('df_reading_');
    backend = FakeBackend();
    agent = AgentController(
      preferences: await tester.runAsync(Preferences.load) as Preferences,
      sessionStore: SessionStore(sessionsDir: sessions.path),
      backend: backend,
    );
    await tester.pumpWidget(DreamFlutterApp(controller: agent));
    await tester.runAsync(agent.init);
    await tester.pumpAndSettle();
    pi = backend.pis.single;
  }

  tearDown(() {
    agent.dispose();
    sessions.deleteSync(recursive: true);
  });

  void reply(String text) {
    final message = {
      'role': 'assistant',
      'content': [
        {'type': 'text', 'text': text},
      ],
      'stopReason': 'stop',
      'timestamp': ts++,
    };
    pi.emit({'type': 'message_start', 'message': message});
    pi.emit({'type': 'message_end', 'message': message});
  }

  Future<void> settle(WidgetTester tester) async {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
    await tester.pumpAndSettle();
  }

  Future<void> earlierAnswers(WidgetTester tester, int count) async {
    for (var i = 0; i < count; i++) {
      pi.startRun('question $i');
      reply(List.filled(10, 'Filler line $i that goes on for a while.').join('\n\n'));
      pi.finishRun();
      await settle(tester);
    }
  }

  /// Starts a streamed reply; [delta] adds to it and lets one frame pass.
  Future<Future<void> Function(String)> streamReply(WidgetTester tester) async {
    pi.startRun('stream');
    pi.emit({
      'type': 'message_start',
      'message': {'role': 'assistant', 'content': <Object>[], 'timestamp': ts++},
    });
    pi.emit({
      'type': 'message_update',
      'assistantMessageEvent': {'type': 'text_start', 'contentIndex': 0},
    });
    return (text) async {
      pi.emit({
        'type': 'message_update',
        'assistantMessageEvent': {'type': 'text_delta', 'contentIndex': 0, 'delta': text},
      });
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 2)));
      await tester.pump(const Duration(milliseconds: 16));
    };
  }

  Finder messageList() => find.descendant(of: find.byType(SelectionArea), matching: find.byType(ListView));

  ScrollPosition listPosition(WidgetTester tester) => tester.state<ScrollableState>(find.descendant(of: messageList(), matching: find.byType(Scrollable)).first).position;

  testWidgets('one wheel notch up while a reply streams lets go of the end, and the button takes it back', (tester) async {
    await startApp(tester);
    await earlierAnswers(tester, 4);
    final delta = await streamReply(tester);
    final position = listPosition(tester);
    final center = tester.getCenter(messageList());
    expect(find.byTooltip('回到底部，并跟着新内容'), findsNothing);

    await delta('The answer begins. ');
    // A single notch (Windows sends about 50 pixels), between two tokens.
    await tester.sendEventToBinding(PointerScrollEvent(position: center, scrollDelta: const Offset(0, -50)));
    final reading = position.pixels;
    for (var f = 0; f < 30; f++) {
      await delta('word $f and more. ');
    }
    expect(position.pixels, moreOrLessEquals(reading, epsilon: 0.5), reason: 'the reader stays where the wheel put them');
    expect(position.maxScrollExtent - position.pixels, greaterThan(40));

    // The arrow: back to the end, and following again.
    await tester.tap(find.byTooltip('回到底部，并跟着新内容'));
    await tester.pump();
    for (var f = 0; f < 10; f++) {
      await delta('more $f. ');
    }
    expect(position.maxScrollExtent - position.pixels, lessThan(0.5));
    expect(find.byTooltip('回到底部，并跟着新内容'), findsNothing);
    pi.finishRun();
    await settle(tester);
  });

  testWidgets('a click after dragging the list up does not jump back to the end', (tester) async {
    await startApp(tester);
    await earlierAnswers(tester, 4);
    final delta = await streamReply(tester);
    final position = listPosition(tester);
    await delta('The answer begins. ');
    await tester.drag(messageList(), const Offset(0, 300));
    await delta('more. ');
    final reading = position.pixels;
    await tester.tapAt(tester.getCenter(messageList()));
    for (var f = 0; f < 10; f++) {
      await delta('word $f. ');
    }
    expect(position.pixels, moreOrLessEquals(reading, epsilon: 0.5));
    pi.finishRun();
    await settle(tester);
  });

  for (final zoomSteps in [0, 2]) {
    for (final streamed in [false, true]) {
      testWidgets('a drag copies the text under the mouse (zoom steps $zoomSteps, streamed $streamed)', (tester) async {
        await startApp(tester);
        for (var i = 0; i < zoomSteps; i++) {
          agent.stepZoom(1);
        }
        await tester.pumpAndSettle();
        String? copied;
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
          if (call.method == 'Clipboard.setData') copied = (call.arguments as Map)['text'] as String?;
          return null;
        });
        // Far enough down that the scroll offset is large.
        await earlierAnswers(tester, 3);
        const text = 'Alphaword first paragraph here.\n\nBravoword second paragraph.\n\nCharlieword third paragraph.';
        if (streamed) {
          final delta = await streamReply(tester);
          for (final chunk in RegExp(r'.{1,6}', dotAll: true).allMatches(text)) {
            await delta(chunk.group(0)!);
          }
          pi.emit({
            'type': 'message_end',
            'message': {
              'role': 'assistant',
              'content': [
                {'type': 'text', 'text': text},
              ],
              'stopReason': 'stop',
              'timestamp': ts++,
            },
          });
        } else {
          pi.startRun('last');
          reply(text);
        }
        pi.finishRun();
        await settle(tester);
        expect(listPosition(tester).pixels, greaterThan(1000));

        final box = tester.getRect(find.textContaining('Alphaword', findRichText: true).last);
        final gesture = await tester.startGesture(box.centerLeft + const Offset(1, 0), kind: PointerDeviceKind.mouse);
        await tester.pump();
        await gesture.moveTo(box.center);
        await tester.pump();
        await gesture.moveTo(box.centerRight - const Offset(1, 0));
        await tester.pump();
        await gesture.up();
        await tester.pumpAndSettle();
        await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
        await tester.sendKeyEvent(LogicalKeyboardKey.keyC);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
        await tester.pumpAndSettle();
        expect(copied, startsWith('Alphaword first paragraph'));
        expect(copied, isNot(contains('Bravo')));
      });
    }
  }

  testWidgets('a drag can still select across two messages', (tester) async {
    await startApp(tester);
    agent.stepZoom(1);
    await tester.pumpAndSettle();
    String? copied;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') copied = (call.arguments as Map)['text'] as String?;
      return null;
    });
    await earlierAnswers(tester, 2);
    pi.startRun('Questionword');
    reply('Answerword short.');
    pi.finishRun();
    await settle(tester);
    final from = tester.getRect(find.text('Questionword'));
    final to = tester.getRect(find.textContaining('Answerword', findRichText: true).last);
    final gesture = await tester.startGesture(from.centerLeft + const Offset(1, 0), kind: PointerDeviceKind.mouse);
    await tester.pump();
    await gesture.moveTo(to.center);
    await tester.pump();
    await gesture.moveTo(to.centerRight - const Offset(1, 0));
    await tester.pump();
    await gesture.up();
    await tester.pumpAndSettle();
    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyC);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pumpAndSettle();
    expect(copied, contains('Questionword'));
    expect(copied, contains('Answerword short'));
  });
}
