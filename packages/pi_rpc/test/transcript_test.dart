import 'package:pi_rpc/pi_rpc.dart';
import 'package:test/test.dart';

import 'fixtures.dart';

Transcript replay(Iterable<PiEvent> events) {
  final transcript = Transcript();
  events.forEach(transcript.apply);
  return transcript;
}

List<AssistantItem> assistants(Transcript t) => t.items.whereType<AssistantItem>().toList();

void main() {
  group('read tool run (prompt fixture)', () {
    final events = fixtureEvents('prompt');

    test('folds into user + two assistant turns with a finished tool card', () {
      final t = replay(events);
      expect(t.isRunning, isFalse);
      expect(t.items.first, isA<UserItem>());
      expect((t.items.first as UserItem).text, contains('hello.txt'));

      final turns = assistants(t);
      expect(turns, hasLength(2));
      final call = turns.first.parts.single as ToolCallPart;
      final run = t.tool(call.toolCallId)!;
      expect(run.name, 'read');
      expect(run.args['path'], 'hello.txt');
      expect(run.status, ToolStatus.done);
      expect(run.outputText, 'hello from dreamflutter\n');

      expect((turns.last.parts.single as TextPart).text, 'hello from dreamflutter');
      expect(turns.last.stopReason, 'stop');
      expect(turns.last.streaming, isFalse);
    });

    test('system messages never become items', () {
      expect(events.whereType<MessageStartEvent>().where((e) => e.message is SystemMessage), isNotEmpty);
      final t = replay(events);
      expect(t.items.whereType<AssistantItem>().length + t.items.whereType<UserItem>().length, t.items.length);
    });

    test('shows partial text while streaming', () {
      final cut = events.indexWhere((e) => e is MessageUpdateEvent && e.delta.delta == ' from');
      final t = replay(events.take(cut + 1));
      expect(t.isRunning, isTrue);
      final last = assistants(t).last;
      expect(last.streaming, isTrue);
      expect((last.parts.single as TextPart).text, 'hello from');
    });

    test('tool card is drafting while arguments stream, pending once complete', () {
      final startIndex = events.indexWhere((e) => e is MessageUpdateEvent && e.delta.kind == AssistantDeltaKind.toolCallStart);
      final t = replay(events.take(startIndex + 4));
      final run = t.tool((assistants(t).last.parts.single as ToolCallPart).toolCallId)!;
      expect(run.status, ToolStatus.drafting);
      expect(run.argsDraft, isNotEmpty);

      final endIndex = events.indexWhere((e) => e is MessageEndEvent && e.message is AssistantMessage);
      final t2 = replay(events.take(endIndex + 1));
      expect(t2.tools.values.single.status, ToolStatus.pending);
    });
  });

  group('thinking + bash (thinking fixture)', () {
    final events = fixtureEvents('thinking');

    test('keeps thinking separate from text and streams bash output', () {
      final t = replay(events);
      final finalTurn = assistants(t).last;
      expect(finalTurn.parts.first, isA<ThinkingPart>());
      expect((finalTurn.parts.first as ThinkingPart).text, isNotEmpty);
      expect(finalTurn.parts.whereType<TextPart>(), isNotEmpty);

      final bash = t.tools.values.singleWhere((r) => r.name == 'bash');
      expect(bash.status, ToolStatus.done);
      expect(bash.outputText, contains('hello.txt'));
    });

    test('tool_execution_update replaces partial output', () {
      final firstUpdate = events.indexWhere((e) => e is ToolExecutionUpdateEvent && e.partialContent.isNotEmpty);
      final t = replay(events.take(firstUpdate + 1));
      final bash = t.tools.values.singleWhere((r) => r.name == 'bash');
      expect(bash.status, ToolStatus.running);
      expect(bash.outputText, isNotEmpty);
    });
  });

  group('abort (abort fixture)', () {
    test('marks the interrupted turn as aborted and stops running', () {
      final t = replay(fixtureEvents('abort'));
      expect(t.isRunning, isFalse);
      final last = assistants(t).last;
      expect(last.aborted, isTrue);
      expect(last.streaming, isFalse);
      expect(t.tools.values.where((r) => r.isActive), isEmpty);
    });

    test('settling mid-stream interrupts active tools', () {
      final events = fixtureEvents('abort');
      final midTool = events.indexWhere((e) => e is ToolExecutionStartEvent);
      final t = replay([...events.take(midTool + 1), AgentSettledEvent(const {'type': 'agent_settled', 'aborted': true}, aborted: true)]);
      expect(t.tools.values.where((r) => r.status == ToolStatus.interrupted), isNotEmpty);
    });
  });

  test('loadHistory rebuilds the same view as live replay', () {
    final events = fixtureEvents('thinking');
    final live = replay(events);
    final messages = events.whereType<MessageEndEvent>().map((e) => e.message);
    final history = Transcript()..loadHistory(messages);

    String shape(Transcript t) => t.items
        .map((i) => switch (i) {
              UserItem() => 'user',
              AssistantItem(:final parts) => 'assistant(${parts.map((p) => p.runtimeType).join(',')})',
              NoticeItem(:final kind) => 'notice($kind)',
            })
        .join(' ');
    expect(shape(history), shape(live));
    expect(history.tools.values.map((r) => r.status), everyElement(ToolStatus.done));
  });

  test('retry and compaction events become notices', () {
    final t = Transcript()
      ..apply(PiEvent.fromJson({'type': 'auto_retry_start', 'attempt': 1, 'maxAttempts': 3, 'delayMs': 2000, 'errorMessage': '529 overloaded'}))
      ..apply(PiEvent.fromJson({'type': 'compaction_start', 'reason': 'threshold'}));
    expect(t.isCompacting, isTrue);
    t.apply(PiEvent.fromJson({'type': 'compaction_end', 'reason': 'threshold', 'result': {'tokensBefore': 150000}, 'aborted': false, 'willRetry': false}));
    final kinds = t.items.whereType<NoticeItem>().map((n) => n.kind).toList();
    expect(kinds, [NoticeKind.retry, NoticeKind.compaction]);
    expect(t.isCompacting, isFalse);
  });
}
