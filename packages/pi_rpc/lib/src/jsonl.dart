/// Strict JSONL framing for Pi's stdout (see Pi docs: rpc.md#framing).
///
/// Records are split on LF bytes only, with an optional trailing CR stripped.
/// Splitting happens on raw bytes before UTF-8 decoding, so U+2028/U+2029
/// inside JSON strings are never treated as record boundaries and multi-byte
/// characters split across chunks are reassembled correctly.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'events.dart';
import 'json.dart';

class JsonlDecoder extends StreamTransformerBase<List<int>, PiRecord> {
  const JsonlDecoder();

  @override
  Stream<PiRecord> bind(Stream<List<int>> stream) {
    final controller = StreamController<PiRecord>(sync: true);
    final pending = BytesBuilder(copy: false);

    void emitLine(List<int> bytes) {
      var end = bytes.length;
      if (end > 0 && bytes[end - 1] == 0x0d) end--;
      if (end == 0) return;
      final line = utf8.decode(bytes.sublist(0, end), allowMalformed: true);
      if (line.trim().isEmpty) return;
      try {
        final decoded = jsonDecode(line);
        controller.add(
          decoded is Map ? PiRecord.fromJson(decoded.cast<String, dynamic>()) : MalformedRecord(line, 'not an object'),
        );
      } catch (error) {
        controller.add(MalformedRecord(line, error));
      }
    }

    late final StreamSubscription<List<int>> subscription;
    controller
      ..onListen = () {
        subscription = stream.listen(
          (chunk) {
            var start = 0;
            for (var i = 0; i < chunk.length; i++) {
              if (chunk[i] != 0x0a) continue;
              if (pending.isEmpty) {
                emitLine(chunk.sublist(start, i));
              } else {
                pending.add(chunk.sublist(start, i));
                emitLine(pending.takeBytes());
              }
              start = i + 1;
            }
            if (start < chunk.length) pending.add(chunk.sublist(start));
          },
          onError: controller.addError,
          onDone: () {
            if (pending.isNotEmpty) emitLine(pending.takeBytes());
            controller.close();
          },
        );
      }
      ..onPause = (() => subscription.pause())
      ..onResume = (() => subscription.resume())
      ..onCancel = (() => subscription.cancel());
    return controller.stream;
  }
}

/// Encodes one command as a single JSONL record.
String encodeRecord(Json record) => '${jsonEncode(record)}\n';
