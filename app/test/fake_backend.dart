import 'dart:async';

import 'package:dreamflutter/state/backend.dart';
import 'package:pi_rpc/pi_rpc.dart';

import 'fake_pi.dart';

/// Stands in for the core: hands out [FakePi] sessions and answers the
/// non-session methods the controller uses.
class FakeBackend implements AgentBackend {
  FakeBackend({this.available = true, this.liveSlots = const [], this.interruptedRuns = const []});

  /// When false, [connect] fails like a missing Node.js / core would.
  bool available;
  final List<Json> liveSlots;
  final List<Json> interruptedRuns;
  final pis = <FakePi>[];

  /// 蝶君's home as core.hello gives it (null: an older core without 蝶君).
  String? butterflyHome;

  /// Rows for `sessions.list` (null = no index, the app falls back to files).
  List<Json>? sessionRows;
  List<Json> searchHits = const [];

  /// Canned answers for other core methods (memory, skills, templates...).
  final handlers = <String, Object? Function(Json params)>{};
  final calls = <({String method, Json params})>[];
  Json settings = {
    'approvalMode': 'changes',
    'autoCompaction': true,
    'defaultModel': null,
    'defaultThinking': null,
  };

  final _events = StreamController<Json>.broadcast();
  var _disconnected = Completer<void>();
  var _connected = false;

  @override
  Future<Json> connect() async {
    if (!available) throw CoreException('missing_runtime', '找不到后台程序（core/src/main.ts）。');
    if (_disconnected.isCompleted) _disconnected = Completer<void>();
    _connected = true;
    return {
      'version': '0.3.0',
      'pid': 1,
      'settings': settings,
      'slots': liveSlots,
      'interruptedRuns': interruptedRuns,
      'pendingConfirmations': const [],
      'butterflyHome': ?butterflyHome,
    };
  }

  @override
  bool get isConnected => _connected;

  @override
  Future<void> get disconnected => _disconnected.future;

  /// Simulates the core going away: sessions close, the controller reconnects.
  void dropConnection() {
    _connected = false;
    for (final pi in pis) {
      pi.crash(code: -1);
    }
    _disconnected.complete();
  }

  @override
  LaunchedSession launch(SessionTarget target) {
    final pi = FakePi(target);
    pis.add(pi);
    return LaunchedSession(PiRpcClient(pi), Future.value(), slotId: () => pi.slotId);
  }

  Iterable<Json> callsTo(String method) => calls.where((c) => c.method == method).map((c) => c.params);

  @override
  Future<Object?> call(String method, [Json params = const {}, Duration timeout = const Duration(seconds: 60)]) async {
    calls.add((method: method, params: params));
    switch (method) {
      case 'settings.update':
        settings = {...settings, ...params};
        _events.add({'event': 'settings.changed', 'settings': settings});
        return settings;
      case 'sessions.list' when sessionRows != null:
        return sessionRows;
      case 'sessions.search':
        return searchHits;
      case _ when handlers.containsKey(method):
        return handlers[method]!(params);
      case 'slot.close':
        for (final pi in pis.where((p) => p.slotId == params['slotId'])) {
          pi.crash(code: 0);
        }
        return {'ok': true};
      default:
        return {'ok': true};
    }
  }

  /// Pushes a core event (memory.changed, ...) to the window.
  void push(Json event) => _events.add(event);

  @override
  Stream<Json> get events => _events.stream;

  @override
  Future<void> dispose() async => _events.close();
}
