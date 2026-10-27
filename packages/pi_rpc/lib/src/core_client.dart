/// Client for the DreamFlutter core: the background service that hosts Pi
/// sessions in-process and serves them over a local WebSocket.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

import 'json.dart';
import 'launcher.dart';

class CoreException implements Exception {
  CoreException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => message;
}

class CoreDisconnectedException extends CoreException {
  CoreDisconnectedException() : super('disconnected', '与后台的连接已断开');
}

/// Contents of `core.json`, written by a running core.
class CoreInfo {
  const CoreInfo({required this.pid, required this.port, required this.token, required this.version});

  factory CoreInfo.fromJson(Json json) => CoreInfo(
    pid: asInt(json['pid']),
    port: asInt(json['port']),
    token: asString(json['token']) ?? '',
    version: asString(json['version']) ?? '',
  );

  final int pid;
  final int port;
  final String token;
  final String version;
}

/// JSON-RPC-style connection: `{id, method, params}` → `{id, result|error}`,
/// plus `{event, ...}` messages pushed by the core.
class CoreClient {
  CoreClient._(this._socket) {
    _socket.listen(_onMessage, onDone: _onDone, onError: (_) => _onDone(), cancelOnError: true);
  }

  static Future<CoreClient> connect({required int port, required String token, Duration timeout = const Duration(seconds: 5)}) async {
    final socket = await WebSocket.connect(
      'ws://127.0.0.1:$port',
      headers: {'Authorization': 'Bearer $token'},
    ).timeout(timeout);
    socket.pingInterval = const Duration(seconds: 20);
    return CoreClient._(socket);
  }

  final WebSocket _socket;
  final _events = StreamController<Json>.broadcast(sync: true);
  final _pending = <int, Completer<Object?>>{};
  final _closed = Completer<void>();
  var _nextId = 0;

  /// Messages the core pushes (`slot.record`, `slot.changed`, ...).
  Stream<Json> get events => _events.stream;
  Future<void> get closed => _closed.future;
  bool get isClosed => _closed.isCompleted;

  Future<Object?> call(String method, [Json params = const {}, Duration timeout = const Duration(seconds: 60)]) {
    if (isClosed) return Future.error(CoreDisconnectedException());
    final id = ++_nextId;
    final completer = Completer<Object?>();
    _pending[id] = completer;
    _socket.add(jsonEncode({'id': id, 'method': method, 'params': params}));
    return completer.future.timeout(
      timeout,
      onTimeout: () {
        _pending.remove(id);
        throw CoreException('timeout', '后台响应超时（$method）');
      },
    );
  }

  void _onMessage(Object? data) {
    if (data is! String) return;
    final Json message;
    try {
      message = asJson(jsonDecode(data));
    } catch (_) {
      return;
    }
    final id = message['id'];
    if (id is int && _pending.containsKey(id)) {
      final completer = _pending.remove(id)!;
      final error = message['error'];
      if (error is Map) {
        final e = asJson(error);
        completer.completeError(CoreException(asString(e['code']) ?? 'error', asString(e['message']) ?? '后台出错'));
      } else {
        completer.complete(message['result']);
      }
      return;
    }
    if (message['event'] is String && !_events.isClosed) _events.add(message);
  }

  void _onDone() {
    if (_closed.isCompleted) return;
    _closed.complete();
    for (final completer in _pending.values) {
      completer.completeError(CoreDisconnectedException());
    }
    _pending.clear();
    unawaited(_events.close());
  }

  Future<void> close() async {
    await _socket.close();
    _onDone();
  }
}

/// Finds, starts and connects to the core.
class CoreLocator {
  /// Relative location of the core entry point in the repository.
  static const mainRelativePath = 'core/src/main.ts';

  static String defaultDataDir() {
    final appData = Platform.environment['APPDATA'] ?? p.join(Platform.environment['USERPROFILE'] ?? '.', 'AppData', 'Roaming');
    return p.join(appData, 'DreamFlutter');
  }

  /// `DREAMFLUTTER_CORE_MAIN`, else `core/src/main.ts` found walking up from
  /// each of [searchRoots].
  static String? findMain(List<String> searchRoots) {
    final override = Platform.environment['DREAMFLUTTER_CORE_MAIN'];
    if (override != null && File(override).existsSync()) return override;
    for (final root in searchRoots) {
      var dir = p.normalize(p.absolute(root));
      for (var depth = 0; depth < 8; depth++) {
        final candidate = p.join(dir, mainRelativePath);
        if (File(candidate).existsSync()) return candidate;
        final parent = p.dirname(dir);
        if (parent == dir) break;
        dir = parent;
      }
    }
    return null;
  }

  static CoreInfo? readInfo(String dataDir) {
    try {
      return CoreInfo.fromJson(asJson(jsonDecode(File(p.join(dataDir, 'core.json')).readAsStringSync())));
    } catch (_) {
      return null;
    }
  }

  /// Connects to the running core, starting it first if needed. The core is
  /// started detached so it outlives this process (closing the window does
  /// not stop background work).
  static Future<CoreClient> ensureRunning({
    required List<String> searchRoots,
    String? dataDir,
    List<String> extraArgs = const [],
    Map<String, String> environment = const {},
    Duration startTimeout = const Duration(seconds: 20),
  }) async {
    final dir = dataDir ?? defaultDataDir();
    final existing = await _tryConnect(dir);
    if (existing != null) return existing;

    final main = findMain(searchRoots);
    final node = PiRuntimeLocator.findOnPath('node');
    if (main == null || node == null) {
      throw CoreException('missing_runtime', main == null ? '找不到后台程序（core/src/main.ts）。' : '找不到 Node.js，请先安装 Node.js 22.19 或更新版本。');
    }
    await Process.start(
      node,
      ['--disable-warning=ExperimentalWarning', main, '--data-dir', dir, ...extraArgs],
      workingDirectory: p.dirname(p.dirname(main)),
      environment: {...PiRuntimeLocator.environment(), ...environment},
      mode: ProcessStartMode.detached,
    );
    final deadline = DateTime.now().add(startTimeout);
    while (DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 150));
      final client = await _tryConnect(dir);
      if (client != null) return client;
    }
    throw CoreException('start_timeout', '后台没有在 ${startTimeout.inSeconds} 秒内启动，详情见 ${p.join(dir, 'core.log')}');
  }

  static Future<CoreClient?> _tryConnect(String dataDir) async {
    final info = readInfo(dataDir);
    if (info == null || info.port == 0) return null;
    try {
      return await CoreClient.connect(port: info.port, token: info.token, timeout: const Duration(seconds: 2));
    } catch (_) {
      return null;
    }
  }
}
