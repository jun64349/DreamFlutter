import 'dart:convert';

import 'package:pi_rpc/pi_rpc.dart';
import 'package:test/test.dart';

Future<List<PiRecord>> decode(List<List<int>> chunks) => Stream.fromIterable(chunks).transform(const JsonlDecoder()).toList();

void main() {
  test('splits records on LF across arbitrary chunk boundaries', () async {
    final bytes = utf8.encode('{"type":"agent_start"}\n{"type":"turn_start"}\n');
    final chunks = [for (var i = 0; i < bytes.length; i += 3) bytes.sublist(i, (i + 3).clamp(0, bytes.length))];
    final records = await decode(chunks);
    expect(records.map((r) => (r as PiEvent).type), ['agent_start', 'turn_start']);
  });

  test('strips CR from CRLF line endings', () async {
    final records = await decode([utf8.encode('{"type":"agent_start"}\r\n')]);
    expect(records.single, isA<AgentStartEvent>());
  });

  test('keeps U+2028 / U+2029 inside JSON strings', () async {
    final line = '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"a b c"}}\n';
    final records = await decode([utf8.encode(line)]);
    final update = records.single as MessageUpdateEvent;
    expect(update.delta.delta, 'a b c');
  });

  test('reassembles multi-byte UTF-8 split across chunks', () async {
    final bytes = utf8.encode('{"type":"session_info_changed","name":"你好世界"}\n');
    final split = bytes.indexOf(0xe4) + 1; // inside the first CJK character
    final records = await decode([bytes.sublist(0, split), bytes.sublist(split)]);
    expect((records.single as SessionInfoChangedEvent).name, '你好世界');
  });

  test('reports malformed lines without stopping the stream', () async {
    final records = await decode([utf8.encode('not json\n{"type":"agent_start"}\n')]);
    expect(records.first, isA<MalformedRecord>());
    expect(records.last, isA<AgentStartEvent>());
  });

  test('flushes a final record without trailing newline', () async {
    final records = await decode([utf8.encode('{"type":"agent_start"}')]);
    expect(records.single, isA<AgentStartEvent>());
  });
}
