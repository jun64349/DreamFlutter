import 'dart:async';
import 'dart:convert';

import 'package:pi_rpc/pi_rpc.dart';
import 'package:test/test.dart';

/// In-memory connection: records what the client writes and lets the test
/// play Pi's side.
class FakeConnection implements PiConnection {
  final _stdout = StreamController<List<int>>();
  final _done = Completer<int>();
  final written = <Json>[];
  void Function(Json command)? onCommand;

  @override
  Stream<List<int>> get stdout => _stdout.stream;

  @override
  void write(String data) {
    for (final line in const LineSplitter().convert(data)) {
      final command = (jsonDecode(line) as Map).cast<String, dynamic>();
      written.add(command);
      onCommand?.call(command);
    }
  }

  void emit(Json record) => _stdout.add(utf8.encode('${jsonEncode(record)}\n'));

  void exit(int code) {
    if (!_done.isCompleted) _done.complete(code);
    _stdout.close();
  }

  @override
  Future<void> close() async => exit(0);

  @override
  Future<int> get done => _done.future;
}

void main() {
  late FakeConnection pi;
  late PiRpcClient client;

  setUp(() {
    pi = FakeConnection();
    client = PiRpcClient(pi);
  });

  test('correlates responses by id regardless of order', () async {
    final pending = <Json>[];
    pi.onCommand = pending.add;
    final state = client.getState();
    final levels = client.getAvailableThinkingLevels();
    await Future<void>.delayed(Duration.zero);

    pi.emit({'type': 'response', 'id': pending[1]['id'], 'command': 'get_available_thinking_levels', 'success': true, 'data': {'levels': ['off', 'high']}});
    pi.emit({'type': 'response', 'id': pending[0]['id'], 'command': 'get_state', 'success': true, 'data': {'sessionId': 's1', 'thinkingLevel': 'high'}});

    expect(await levels, ['off', 'high']);
    expect((await state).sessionId, 's1');
  });

  test('failed commands throw PiRpcException with the error text', () async {
    pi.onCommand = (c) => pi.emit({'type': 'response', 'id': c['id'], 'command': c['type'], 'success': false, 'error': 'Model not found: x/y'});
    expect(
      client.setModel('x', 'y'),
      throwsA(isA<PiRpcException>().having((e) => e.message, 'message', contains('Model not found'))),
    );
  });

  test('prompt sends streamingBehavior only when given and parses disposition', () async {
    pi.onCommand = (c) => pi.emit({'type': 'response', 'id': c['id'], 'command': 'prompt', 'success': true, 'data': {'disposition': 'queued'}});
    expect(await client.prompt('hi', streamingBehavior: 'steer'), PromptDisposition.queued);
    expect(pi.written.last['streamingBehavior'], 'steer');
    await client.prompt('again');
    expect(pi.written.last.containsKey('streamingBehavior'), isFalse);
  });

  test('routes events and extension UI requests to separate streams', () async {
    final events = <PiEvent>[];
    final requests = <ExtensionUiRequest>[];
    client.events.listen(events.add);
    client.uiRequests.listen(requests.add);
    pi.emit({'type': 'agent_start'});
    pi.emit({'type': 'extension_ui_request', 'id': 'ui-1', 'method': 'confirm', 'title': 'Run rm?', 'message': 'sure?'});
    await Future<void>.delayed(Duration.zero);
    expect(events.single, isA<AgentStartEvent>());
    expect(requests.single.isDialog, isTrue);

    client.respondToUi('ui-1', confirmed: true);
    expect(pi.written.last, {'type': 'extension_ui_response', 'id': 'ui-1', 'confirmed': true});
  });

  test('outstanding commands fail when the process exits', () async {
    final state = client.getState();
    pi.exit(1);
    await expectLater(state, throwsA(isA<PiConnectionClosedException>()));
    expect(client.isClosed, isTrue);
    expect(client.exitCode, 1);
    await expectLater(client.getState(), throwsA(isA<PiConnectionClosedException>()));
  });

  test('times out commands that never get a response', () async {
    await expectLater(
      client.send('get_state', const {}, const Duration(milliseconds: 20)),
      throwsA(isA<PiRpcException>().having((e) => e.message, 'message', contains('timed out'))),
    );
  });
}
