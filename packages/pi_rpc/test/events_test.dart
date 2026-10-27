import 'package:pi_rpc/pi_rpc.dart';
import 'package:test/test.dart';

import 'fixtures.dart';

void main() {
  for (final name in ['queries', 'prompt', 'thinking', 'abort']) {
    test('every record in "$name" fixture parses to a known type', () {
      final records = fixtureRecords(name);
      expect(records, isNotEmpty);
      expect(records.whereType<MalformedRecord>(), isEmpty);
      final unknown = records.whereType<UnknownEvent>().map((e) => e.type).toSet();
      expect(unknown, isEmpty, reason: 'unhandled event types: $unknown');
    });
  }

  test('typed response payloads', () {
    final responses = {for (final r in fixtureRecords('prompt').whereType<RpcResponse>()) r.command: r};

    final state = SessionState.fromJson(responses['get_state']!.data as Json);
    expect(state.sessionId, isNotEmpty);
    expect(state.isStreaming, isFalse);

    final models = ((responses['get_available_models']!.data as Json)['models'] as List)
        .map((m) => PiModel.fromJson((m as Map).cast()))
        .toList();
    expect(models.map((m) => m.key), contains('cc-switch-deep-seek/deepseek-flash'));

    final model = PiModel.fromJson(responses['set_model']!.data as Json);
    expect(model.key, 'cc-switch-deep-seek/deepseek-flash');
    expect(model.contextWindow, greaterThan(0));

    final stats = SessionStats.fromJson(responses['get_session_stats']!.data as Json);
    expect(stats.contextWindow, greaterThan(0));

    expect(PromptDisposition.parse((responses['prompt']!.data as Json)['disposition']), PromptDisposition.started);
  });

  test('message_update carries deltas and tool calls', () {
    final updates = fixtureEvents('prompt').whereType<MessageUpdateEvent>().toList();
    final toolStart = updates.firstWhere((u) => u.delta.kind == AssistantDeltaKind.toolCallStart);
    expect(toolStart.delta.toolName, 'read');
    final toolEnd = updates.firstWhere((u) => u.delta.kind == AssistantDeltaKind.toolCallEnd);
    expect(toolEnd.delta.toolCall!.arguments['path'], 'hello.txt');
    final text = updates.where((u) => u.delta.kind == AssistantDeltaKind.textDelta).map((u) => u.delta.delta).join();
    expect(text, 'hello from dreamflutter');
  });
}
