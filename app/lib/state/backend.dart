import 'dart:async';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

/// The background service the window talks to. [CoreBackend] is the real
/// one; tests substitute a fake.
abstract interface class AgentBackend {
  /// Connects (starting the core when needed) and returns `core.hello`.
  Future<Json> connect();

  bool get isConnected;

  /// Completes when the current connection drops.
  Future<void> get disconnected;

  /// Opens or attaches to a session hosted by the core.
  LaunchedSession launch(SessionTarget target);

  Future<Object?> call(String method, [Json params = const {}, Duration timeout = const Duration(seconds: 60)]);

  /// Messages pushed by the core (`slot.changed`, `settings.changed`, ...),
  /// across reconnects.
  Stream<Json> get events;

  Future<void> dispose();
}

class CoreBackend implements AgentBackend {
  CoreBackend({this.dataDir, this.extraArgs = const [], this.environment = const {}, List<String>? searchRoots})
    : searchRoots = searchRoots ?? [p.dirname(Platform.resolvedExecutable), Directory.current.path];

  /// Core data directory; null = `%APPDATA%\DreamFlutter`.
  final String? dataDir;

  /// Extra core arguments (tests: `--session-dir`, `--agent-dir`).
  final List<String> extraArgs;
  final Map<String, String> environment;
  final List<String> searchRoots;

  CoreClient? _client;
  StreamSubscription<Json>? _sub;
  final _events = StreamController<Json>.broadcast();
  var _disconnected = Completer<void>();

  CoreClient get client {
    final client = _client;
    if (client == null || client.isClosed) throw CoreDisconnectedException();
    return client;
  }

  @override
  bool get isConnected => _client != null && !_client!.isClosed;

  @override
  Future<void> get disconnected => _disconnected.future;

  @override
  Future<Json> connect() async {
    if (_disconnected.isCompleted) _disconnected = Completer<void>();
    await _sub?.cancel();
    final client = await CoreLocator.ensureRunning(
      searchRoots: searchRoots,
      dataDir: dataDir,
      extraArgs: extraArgs,
      environment: environment,
    );
    _client = client;
    _sub = client.events.listen(_events.add);
    client.closed.then((_) {
      if (identical(client, _client) && !_disconnected.isCompleted) _disconnected.complete();
    });
    return asJsonMap(await client.call('core.hello'));
  }

  @override
  LaunchedSession launch(SessionTarget target) => launchInCore(client, target);

  @override
  Future<Object?> call(String method, [Json params = const {}, Duration timeout = const Duration(seconds: 60)]) =>
      client.call(method, params, timeout);

  @override
  Stream<Json> get events => _events.stream;

  @override
  Future<void> dispose() async {
    await _sub?.cancel();
    final client = _client;
    _client = null;
    await client?.close();
    await _events.close();
  }
}

Json asJsonMap(Object? value) => value is Map ? value.cast<String, dynamic>() : <String, dynamic>{};
