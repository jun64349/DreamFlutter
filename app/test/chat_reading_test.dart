import 'dart:io';

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/ui/card_view.dart';
import 'package:dreamflutter/ui/motion.dart';
import 'package:dreamflutter/ui/web_surface.dart';
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

  Finder messageList() => find.byKey(const ValueKey('conversation-list'));

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

  /// A reply that shows a card [height] pixels tall; the card's details come
  /// from the core a moment after the row is built.
  void cardReply(String id, double height) {
    backend.handlers['cards.get'] = (params) => {
      'id': params['id'],
      'title': '体检报告',
      'origin': 'agent',
      'resident': false,
      'epoch': 1,
      'version': 1,
      'updatedAt': 0,
      'height': height,
      'bindings': <Object>[],
    };
    WebSurfaces.create = () async => null;
    final message = {
      'role': 'assistant',
      'content': [
        {
          'type': 'toolCall',
          'id': 'call-$id',
          'name': 'show_card',
          'arguments': {'title': '体检报告'},
        },
      ],
      'stopReason': 'toolUse',
      'timestamp': ts++,
    };
    pi.emit({'type': 'message_start', 'message': message});
    pi.emit({'type': 'message_end', 'message': message});
    pi.emit({'type': 'tool_execution_start', 'toolCallId': 'call-$id', 'toolName': 'show_card', 'args': {'title': '体检报告'}});
    pi.emit({
      'type': 'tool_execution_end',
      'toolCallId': 'call-$id',
      'toolName': 'show_card',
      'result': {
        'content': [
          {'type': 'text', 'text': 'shown'},
        ],
        'details': {'cardId': id},
      },
      'isError': false,
      'durationMs': 5,
    });
  }

  /// The first question on screen and where it is.
  (String, double)? questionOnScreen(WidgetTester tester) {
    final list = tester.getRect(messageList());
    for (var i = 0; i < 20; i++) {
      final finder = find.descendant(of: messageList(), matching: find.text('question $i'));
      if (finder.evaluate().isEmpty) continue;
      final top = tester.getTopLeft(finder).dy;
      if (top > list.top + 20 && top < list.bottom - 40) return ('question $i', top);
    }
    return null;
  }

  // v0.3.3 test: 「时不时往上弹」. Scrolling up builds rows again; a card first
  // shows a short placeholder, then grows to its height, and pushed the text
  // being read down.
  testWidgets('a row above growing while the reader scrolls up does not move the text they read', (tester) async {
    await startApp(tester);
    pi.startRun('show me the report');
    cardReply('c_report', 700);
    reply('The report is above.');
    pi.finishRun();
    await settle(tester);
    await earlierAnswers(tester, 6);
    final center = tester.getCenter(messageList());
    final position = listPosition(tester);
    // As after a restart: nothing remembered about the card, so it opens short.
    agent.cardStage.forget('c_report');
    final callsBefore = backend.callsTo('cards.get').length;

    var loaded = false;
    for (var step = 0; step < 120 && !loaded; step++) {
      await tester.sendEventToBinding(PointerScrollEvent(position: center, scrollDelta: const Offset(0, -120)));
      await tester.pump();
      if (backend.callsTo('cards.get').length == callsBefore) continue;
      loaded = true;
      final before = questionOnScreen(tester);
      expect(before, isNotNull);
      final pixels = position.pixels;
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump();
      await tester.pump();
      expect(find.text('体检报告', skipOffstage: false), findsWidgets, reason: 'the card has its details now');
      final after = tester.getTopLeft(find.descendant(of: messageList(), matching: find.text(before!.$1))).dy;
      expect(after, moreOrLessEquals(before.$2, epsilon: 0.5), reason: 'the text being read stays put');
      expect(position.pixels, greaterThan(pixels + 300), reason: 'the offset took the growth');
    }
    expect(loaded, isTrue);
  });

  testWidgets('a card built again after scrolling away comes back at its height', (tester) async {
    await startApp(tester);
    pi.startRun('show me the report');
    cardReply('c_again', 700);
    reply('The report is above.');
    pi.finishRun();
    await settle(tester);
    expect(find.text('正在打开…'), findsNothing);
    final card = find.byType(CardBlock, skipOffstage: false);
    final height = tester.getSize(card).height;
    expect(height, greaterThan(700));

    await earlierAnswers(tester, 8);
    expect(card, findsNothing, reason: 'scrolled away and gone');
    listPosition(tester).jumpTo(0);
    await tester.pump();
    expect(find.text('正在打开…'), findsNothing, reason: 'no placeholder on the way back');
    expect(tester.getSize(card).height, height);
  });

  testWidgets('rows built again while a run goes on do not play their entrance again', (tester) async {
    await startApp(tester);
    await earlierAnswers(tester, 6);
    final delta = await streamReply(tester);
    await delta('Working on it. ');
    listPosition(tester).jumpTo(0);
    await tester.pump();
    await delta('more. ');
    final animating = tester.widgetList<FadeSlideIn>(find.byType(FadeSlideIn, skipOffstage: false)).where((w) => w.animate);
    expect(animating, isEmpty, reason: 'the first rows were there before');
    pi.finishRun();
    await settle(tester);
  });

  testWidgets('sending a message while scrolled up goes back to the end', (tester) async {
    await startApp(tester);
    await earlierAnswers(tester, 6);
    final position = listPosition(tester);
    position.jumpTo(position.maxScrollExtent - 1500);
    await tester.pump();
    final input = find.byWidgetPredicate((w) => w is TextField && w.decoration?.hintText == '说点什么…');
    await tester.enterText(input, 'a new question');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await settle(tester);
    pi.startRun('a new question');
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 60)));
    for (var f = 0; f < 5; f++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(position.maxScrollExtent - position.pixels, lessThan(0.5));
    pi.finishRun();
    await settle(tester);
  });

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
