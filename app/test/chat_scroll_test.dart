import 'dart:io';

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';
import 'fake_pi.dart';

/// The conversation stays at its end in every painted frame (extra test 7:
/// the window shook when a message was sent or a queued one went out).
void main() {
  late FakeBackend backend;
  late AgentController agent;
  late Directory sessions;
  late FakePi pi;
  var ts = 10;

  Future<void> startApp(WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(1400, 900));
    SharedPreferences.setMockInitialValues({'workspace': Directory.systemTemp.path, 'onboarded': true});
    sessions = Directory.systemTemp.createTempSync('df_scroll_');
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

  Future<void> longConversation(WidgetTester tester) async {
    for (var i = 0; i < 6; i++) {
      pi.startRun('question $i');
      reply(List.filled(12, 'Line of the answer number $i that goes on for a while.').join('\n\n'));
      pi.finishRun();
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pumpAndSettle();
    }
  }

  ScrollPosition listPosition() => find
      .byType(Scrollable)
      .evaluate()
      .map((e) => (e as StatefulElement).state as ScrollableState)
      .firstWhere((s) => s.position.maxScrollExtent > 1000)
      .position;

  /// Distance from the end in each frame as painted, until [stopRecording].
  /// Persistent frame callbacks cannot be removed, so a flag ends it.
  var recording = false;
  void stopRecording() => recording = false;

  List<double> recordGaps(ScrollPosition position) {
    final gaps = <double>[];
    recording = true;
    SchedulerBinding.instance.addPersistentFrameCallback((_) {
      if (!recording) return;
      gaps.add(position.maxScrollExtent - position.pixels);
    });
    return gaps;
  }

  Finder input() => find.byWidgetPredicate((w) => w is TextField && (w.decoration?.hintText ?? '').contains('Enter 发送'));

  testWidgets('typing, sending and the reply never paint the conversation away from its end', (tester) async {
    await startApp(tester);
    await longConversation(tester);
    final gaps = recordGaps(listPosition());

    await tester.enterText(input(), List.filled(6, 'a long multi-line message').join('\n'));
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    for (var f = 0; f < 3; f++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    pi.startRun('the sent message');
    for (var f = 0; f < 3; f++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    reply('A short answer.');
    pi.finishRun();
    await tester.pumpAndSettle();
    stopRecording();

    expect(gaps, isNotEmpty);
    expect(gaps.where((g) => g.abs() > 0.5), isEmpty, reason: 'gaps per frame: $gaps');
  });

  /// An assistant message that calls [count] tools, all finished.
  void toolTurn(String prefix, int count) {
    final message = {
      'role': 'assistant',
      'content': [
        for (var i = 0; i < count; i++)
          {
            'type': 'toolCall',
            'id': '$prefix$i',
            'name': 'read',
            'arguments': {'path': 'file$i.txt'},
          },
      ],
      'stopReason': 'toolUse',
      'timestamp': ts++,
    };
    pi.emit({'type': 'message_start', 'message': message});
    pi.emit({'type': 'message_end', 'message': message});
    for (var i = 0; i < count; i++) {
      pi.emit({
        'type': 'tool_execution_start',
        'toolCallId': '$prefix$i',
        'toolName': 'read',
        'args': {'path': 'file$i.txt'},
      });
      pi.emit({
        'type': 'tool_execution_end',
        'toolCallId': '$prefix$i',
        'toolName': 'read',
        'result': {
          'content': [
            {'type': 'text', 'text': 'ok'},
          ],
        },
        'isError': false,
        'durationMs': 5,
      });
    }
  }

  Future<void> frames(WidgetTester tester, int count) async {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 60)));
    for (var f = 0; f < count; f++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
  }

  // v0.3.3 test: after a queued message went out the conversation jumped up.
  testWidgets('a queued message going out and the work folding never paint away from the end', (tester) async {
    await startApp(tester);
    await longConversation(tester);
    pi.startRun('do some work');
    toolTurn('t', 10);
    await frames(tester, 40);
    final position = listPosition();
    expect(position.maxScrollExtent - position.pixels, lessThan(0.5));
    final gaps = recordGaps(position);

    pi.emit({'type': 'queue_update', 'steering': ['插入的话'], 'followUp': <String>[]});
    await frames(tester, 10);
    final steer = {'role': 'user', 'content': '插入的话', 'timestamp': ts++};
    pi.emit({'type': 'message_start', 'message': steer});
    pi.emit({'type': 'message_end', 'message': steer});
    pi.emit({'type': 'queue_update', 'steering': <String>[], 'followUp': <String>[]});
    await frames(tester, 40);
    toolTurn('s', 3);
    await frames(tester, 10);
    pi.finishRun();
    await frames(tester, 40);
    stopRecording();

    expect(gaps, isNotEmpty);
    expect(gaps.where((g) => g.abs() > 0.5), isEmpty, reason: 'gaps per frame: $gaps');
  });

  testWidgets('a reader who scrolled up stays where they are while the reply grows', (tester) async {
    await startApp(tester);
    await longConversation(tester);
    final position = listPosition();
    // The reader scrolls back up to an earlier question.
    final reading = find.descendant(of: find.byType(SelectionArea), matching: find.text('question 3'));
    await tester.dragUntilVisible(reading, find.descendant(of: find.byType(SelectionArea), matching: find.byType(ListView)), const Offset(0, 200));
    await tester.pumpAndSettle();
    expect(position.maxScrollExtent - position.pixels, greaterThan(500));
    final before = tester.getTopLeft(reading).dy;

    pi.startRun('another');
    reply('A new answer at the end.');
    pi.finishRun();
    await tester.pumpAndSettle();
    expect(tester.getTopLeft(reading).dy, moreOrLessEquals(before, epsilon: 0.5));

    // Back at the end, it follows again.
    position.jumpTo(position.maxScrollExtent);
    await tester.pump();
    pi.startRun('and another');
    reply('Followed.');
    pi.finishRun();
    await tester.pumpAndSettle();
    expect(position.maxScrollExtent - position.pixels, lessThan(0.5));
  });
}
