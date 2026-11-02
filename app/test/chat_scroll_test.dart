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
