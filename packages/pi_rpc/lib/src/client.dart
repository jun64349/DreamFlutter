/// Long-lived connection to one `pi --mode rpc` child process.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'events.dart';
import 'json.dart';
import 'jsonl.dart';
import 'messages.dart';
import 'models.dart';

/// A command failed (`success: false`) or could not be delivered.
class PiRpcException implements Exception {
  PiRpcException(this.command, this.message);
  final String command;
  final String message;

  @override
  String toString() => 'PiRpcException($command): $message';
}

/// The Pi process went away while a command was outstanding.
class PiConnectionClosedException extends PiRpcException {
  PiConnectionClosedException(String command) : super(command, 'Pi process exited');
}

/// Byte-level transport. [ProcessConnection] is the real one; tests supply
/// fakes so the client can be exercised without a Pi process.
abstract interface class PiConnection {
  Stream<List<int>> get stdout;
  void write(String data);
  Future<void> close();

  /// Completes when the other side is gone, with its exit code (or -1).
  Future<int> get done;
}

class ProcessConnection implements PiConnection {
  ProcessConnection(this.process, {this.stderrTailLines = 200}) {
    process.stderr.transform(utf8.decoder).transform(const LineSplitter()).listen((line) {
      _stderrTail.add(line);
      if (_stderrTail.length > stderrTailLines) _stderrTail.removeAt(0);
    });
  }

  final Process process;
  final int stderrTailLines;
  final List<String> _stderrTail = [];

  /// The most recent stderr lines; Pi writes diagnostics there, never protocol data.
  List<String> get stderrTail => List.unmodifiable(_stderrTail);

  @override
  Stream<List<int>> get stdout => process.stdout;

  @override
  void write(String data) => process.stdin.add(utf8.encode(data));

  @override
  Future<void> close() async {
    // Closing stdin asks Pi for an orderly shutdown (it disposes the runtime first).
    try {
      await process.stdin.close();
    } catch (_) {}
    final exited = await process.exitCode.timeout(const Duration(seconds: 5), onTimeout: () => -1);
    if (exited == -1) process.kill();
  }

  @override
  Future<int> get done => process.exitCode;
}

/// How to start Pi.
class PiLaunchConfig {
  const PiLaunchConfig({
    required this.cliPath,
    required this.workingDirectory,
    this.nodeExecutable = 'node',
    this.extraArgs = const [],
    this.environment = const {},
  });

  /// Path to `@earendil-works/pi-coding-agent/dist/bundle/cli.js`.
  final String cliPath;

  /// The agent's workspace: tool paths, project resources and session grouping.
  final String workingDirectory;
  final String nodeExecutable;

  /// E.g. `['--session', path]` to open an existing session at startup.
  final List<String> extraArgs;

  /// Merged over the parent environment.
  final Map<String, String> environment;

  List<String> get arguments => [cliPath, '--mode', 'rpc', ...extraArgs];
}

class PiRpcClient {
  PiRpcClient(this.connection) {
    _subscription = connection.stdout
        .transform(const JsonlDecoder())
        .listen(_onRecord, onDone: _onClosed, onError: (Object e) => _diagnostics.add('stdout error: $e'));
    connection.done.then((code) {
      exitCode = code;
      _onClosed();
    });
  }

  static Future<PiRpcClient> launch(PiLaunchConfig config) async {
    final process = await Process.start(
      config.nodeExecutable,
      config.arguments,
      workingDirectory: config.workingDirectory,
      environment: config.environment,
    );
    return PiRpcClient(ProcessConnection(process));
  }

  final PiConnection connection;
  late final StreamSubscription<PiRecord> _subscription;
  final _events = StreamController<PiEvent>.broadcast(sync: true);
  final _uiRequests = StreamController<ExtensionUiRequest>.broadcast(sync: true);
  final _diagnostics = StreamController<String>.broadcast();
  final _pending = <String, ({String command, Completer<Object?> completer})>{};
  final _closed = Completer<void>();
  var _nextId = 0;

  /// Set once the process exits.
  int? exitCode;

  /// Session events (message streaming, tools, run lifecycle, ...).
  Stream<PiEvent> get events => _events.stream;

  /// Extension UI requests. Dialogs must be answered with [respondToUi].
  Stream<ExtensionUiRequest> get uiRequests => _uiRequests.stream;

  /// Malformed stdout lines and stray responses, for logging.
  Stream<String> get diagnostics => _diagnostics.stream;

  bool get isClosed => _closed.isCompleted;
  Future<void> get closed => _closed.future;

  List<String> get stderrTail => switch (connection) {
    ProcessConnection c => c.stderrTail,
    _ => const [],
  };

  void _onRecord(PiRecord record) {
    switch (record) {
      case RpcResponse(:final id) when id != null && _pending.containsKey(id):
        final entry = _pending.remove(id)!;
        if (record.success) {
          entry.completer.complete(record.data);
        } else {
          entry.completer.completeError(PiRpcException(record.command, record.error ?? 'unknown error'));
        }
      case RpcResponse():
        _diagnostics.add('unmatched response: ${jsonEncode(record.raw)}');
      case ExtensionUiRequest():
        _uiRequests.add(record);
      case PiEvent():
        _events.add(record);
      case MalformedRecord(:final line, :final error):
        _diagnostics.add('malformed line ($error): $line');
    }
  }

  void _onClosed() {
    if (_closed.isCompleted) return;
    _closed.complete();
    for (final entry in _pending.values) {
      entry.completer.completeError(PiConnectionClosedException(entry.command));
    }
    _pending.clear();
  }

  /// Sends one command and resolves with its response `data`.
  Future<Object?> send(String type, [Json params = const {}, Duration timeout = const Duration(seconds: 30)]) {
    if (isClosed) return Future.error(PiConnectionClosedException(type));
    final id = 'df-${++_nextId}';
    final completer = Completer<Object?>();
    _pending[id] = (command: type, completer: completer);
    try {
      connection.write(encodeRecord({...params, 'type': type, 'id': id}));
    } catch (e) {
      _pending.remove(id);
      return Future.error(PiRpcException(type, 'write failed: $e'));
    }
    return completer.future.timeout(
      timeout,
      onTimeout: () {
        _pending.remove(id);
        throw PiRpcException(type, 'timed out after ${timeout.inSeconds}s');
      },
    );
  }

  // --- Prompting -----------------------------------------------------------

  /// While a run is streaming, [streamingBehavior] must be `steer` or `followUp`.
  Future<PromptDisposition> prompt(String message, {List<ImageBlock> images = const [], String? streamingBehavior}) async {
    final data = await send('prompt', {
      'message': message,
      if (images.isNotEmpty) 'images': images.map((i) => i.toJson()).toList(),
      'streamingBehavior': ?streamingBehavior,
    });
    return PromptDisposition.parse(asJson(data)['disposition']);
  }

  Future<void> abort() => send('abort', const {}, const Duration(seconds: 60));

  // --- State and model -----------------------------------------------------

  Future<SessionState> getState() async => SessionState.fromJson(asJson(await send('get_state')));

  Future<List<PiModel>> getAvailableModels() async =>
      asJsonList(asJson(await send('get_available_models'))['models']).map(PiModel.fromJson).toList();

  Future<PiModel> setModel(String provider, String modelId) async =>
      PiModel.fromJson(asJson(await send('set_model', {'provider': provider, 'modelId': modelId})));

  Future<List<String>> getAvailableThinkingLevels() async =>
      asStringList(asJson(await send('get_available_thinking_levels'))['levels']);

  Future<void> setThinkingLevel(String level) => send('set_thinking_level', {'level': level});

  Future<SessionStats> getSessionStats() async => SessionStats.fromJson(asJson(await send('get_session_stats')));

  Future<List<SlashCommand>> getCommands() async =>
      asJsonList(asJson(await send('get_commands'))['commands']).map(SlashCommand.fromJson).toList();

  // --- Session -------------------------------------------------------------

  Future<List<AgentMessage>> getMessages() async =>
      asJsonList(asJson(await send('get_messages'))['messages']).map(AgentMessage.fromJson).toList();

  /// Returns false if an extension cancelled the switch.
  Future<bool> newSession() async =>
      !asBool(asJson(await send('new_session', const {}, const Duration(seconds: 60)))['cancelled']);

  /// Returns false if an extension cancelled the switch.
  Future<bool> switchSession(String sessionPath) async => !asBool(
    asJson(await send('switch_session', {'sessionPath': sessionPath}, const Duration(seconds: 60)))['cancelled'],
  );

  Future<void> setSessionName(String name) => send('set_session_name', {'name': name});

  /// User messages on the active branch, in order, that can be forked from.
  Future<List<ForkPoint>> getForkMessages() async =>
      asJsonList(asJson(await send('get_fork_messages'))['messages']).map(ForkPoint.fromJson).toList();

  /// Starts a new session branching off just before [entryId] and switches to
  /// it. Returns the forked message text (for editing), or null if cancelled.
  Future<String?> fork(String entryId) async {
    final data = asJson(await send('fork', {'entryId': entryId}, const Duration(seconds: 60)));
    return asBool(data['cancelled']) ? null : (asString(data['text']) ?? '');
  }

  /// Duplicates the active branch into a new session and switches to it.
  Future<bool> clone() async => !asBool(asJson(await send('clone', const {}, const Duration(seconds: 60)))['cancelled']);

  // --- Context -------------------------------------------------------------

  /// Summarizes older history to free context. Runs a model call, so it can
  /// take a while.
  Future<CompactionResult> compact({String? customInstructions}) async => CompactionResult.fromJson(
    asJson(
      await send('compact', {
        if (customInstructions != null && customInstructions.trim().isNotEmpty) 'customInstructions': customInstructions,
      }, const Duration(minutes: 10)),
    ),
  );

  Future<void> setAutoCompaction(bool enabled) => send('set_auto_compaction', {'enabled': enabled});

  Future<void> setAutoRetry(bool enabled) => send('set_auto_retry', {'enabled': enabled});

  // --- Extension UI --------------------------------------------------------

  /// Answers a dialog request. Pass exactly one of [value], [confirmed] or
  /// [cancelled].
  void respondToUi(String id, {String? value, bool? confirmed, bool cancelled = false}) {
    if (isClosed) return;
    connection.write(
      encodeRecord({
        'type': 'extension_ui_response',
        'id': id,
        if (cancelled) 'cancelled': true else if (confirmed != null) 'confirmed': confirmed else 'value': value ?? '',
      }),
    );
  }

  /// Closes stdin (orderly shutdown), waits briefly, then kills.
  Future<void> dispose() async {
    await connection.close();
    _onClosed();
    await _subscription.cancel();
    await _events.close();
    await _uiRequests.close();
    await _diagnostics.close();
  }
}
