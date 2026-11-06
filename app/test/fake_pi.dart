import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

/// Plays Pi's side of the protocol for one core slot: answers commands from a
/// real recording and can replay its event stream.
class FakePi implements PiConnection {
  FakePi(this.target) : slotId = target.attachSlotId ?? 'slot-${++_slotCounter}' {
    sessionFile = target.sessionPath ?? _newSessionFile();
  }

  final SessionTarget target;
  final String slotId;
  static var _slotCounter = 0;
  final _stdout = StreamController<List<int>>();
  final _done = Completer<int>();
  final commands = <Json>[];
  /// Inject events before command acknowledgement (e.g. first-send approval).
  void Function(Json command)? onCommand;
  var streaming = false;
  late String sessionFile;
  String? sessionId;

  /// What `get_messages` returns (history of the current session).
  List<Json> messages = [];

  /// What `df_branches` returns.
  List<Json> branches = [];

  /// Answers for commands the recording has no example of (`df_tree`).
  final extraResponses = <String, Object?>{};
  final failures = <String, String>{};

  /// Editor text `df_navigate_tree` hands back.
  String? navigateText;

  static var _sessionCounter = 0;
  static String _newSessionFile() => p.join(Directory.systemTemp.path, 'fake-sessions', 's${++_sessionCounter}.jsonl');

  static final _fixture = File(p.join('..', 'runtime', 'fixtures', 'rpc-session-prompt.jsonl'))
      .readAsLinesSync()
      .map((l) => (jsonDecode(l) as Map).cast<String, dynamic>())
      .toList();

  static Object? _recorded(String command) => _fixture.firstWhere((r) => r['command'] == command)['data'];

  static List<Json> get recordedEvents => _fixture.where((r) => r['type'] != 'response').toList();

  Iterable<String> sent(String type) => commands.where((c) => c['type'] == type).map(jsonEncode);

  void emit(Json record) {
    if (!_stdout.isClosed) _stdout.add(utf8.encode('${jsonEncode(record)}\n'));
  }

  /// A run that has started and shown the user's message.
  void startRun(String text) {
    streaming = true;
    emit({'type': 'agent_start'});
    final message = {'role': 'user', 'content': text, 'timestamp': 1};
    emit({'type': 'message_start', 'message': message});
    emit({'type': 'message_end', 'message': message});
  }

  void finishRun() {
    streaming = false;
    emit({'type': 'agent_settled', 'aborted': false});
  }

  @override
  void write(String data) {
    for (final line in const LineSplitter().convert(data)) {
      final command = (jsonDecode(line) as Map).cast<String, dynamic>();
      commands.add(command);
      onCommand?.call(command);
      if (command['type'] == 'extension_ui_response') continue;
      final error = failures[command['type']];
      if (error != null) {
        scheduleMicrotask(() => emit({'type': 'response', 'id': command['id'], 'command': command['type'], 'success': false, 'error': error}));
        continue;
      }
      switch (command['type']) {
        case 'new_session':
          sessionFile = _newSessionFile();
        case 'switch_session':
          sessionFile = command['sessionPath'] as String;
      }
      switch (command['type']) {
        case 'fork' || 'clone':
          sessionFile = _newSessionFile();
      }
      final data = extraResponses.containsKey(command['type']) ? extraResponses[command['type']] : switch (command['type']) {
        'get_state' => {...(_recorded('get_state') as Json), 'isStreaming': streaming, 'sessionFile': sessionFile, 'sessionId': ?sessionId},
        'set_model' => _recorded('set_model'),
        'prompt' => {'disposition': streaming ? 'queued' : 'started'},
        'new_session' || 'switch_session' || 'clone' => {'cancelled': false},
        'get_messages' => {'messages': messages},
        'get_tree' => {
          'leafId': messages.isEmpty ? null : messages.last['entryId'] ?? 'entry-${messages.length - 1}',
          'tree': [for (final (i, message) in messages.indexed) {'entry': {'id': message['entryId'] ?? 'entry-$i', 'parentId': i == 0 ? null : messages[i - 1]['entryId'] ?? 'entry-${i - 1}', 'type': 'message', 'message': message}, 'children': <Object>[] }],
        },
        'get_fork_messages' => {
          'messages': [
            for (final (i, m) in messages.where((m) => m['role'] == 'user').indexed) {'entryId': 'e$i', 'text': m['content']},
          ],
        },
        'fork' => {'cancelled': false, 'text': 'edited later'},
        'df_branches' => {'branches': branches},
        'df_navigate_tree' => {'cancelled': false, 'editorText': navigateText},
        'df_export' => {'path': command['outputPath']},
        'compact' => {'tokensBefore': 150000, 'estimatedTokensAfter': 32000},
        'abort' || 'set_auto_compaction' || 'set_session_name' || 'set_thinking_level' => null,
        final type => _recorded(type as String),
      };
      scheduleMicrotask(
        () => emit({'type': 'response', 'id': command['id'], 'command': command['type'], 'success': true, 'data': ?data}),
      );
    }
  }

  /// The slot closed (code 0) or the core connection dropped (-1).
  void crash({int code = 1}) {
    if (_done.isCompleted) return;
    _done.complete(code);
    _stdout.close();
  }

  @override
  Stream<List<int>> get stdout => _stdout.stream;

  @override
  Future<void> close() async {
    if (!_done.isCompleted) _done.complete(0);
    await _stdout.close();
  }

  @override
  Future<int> get done => _done.future;
}
