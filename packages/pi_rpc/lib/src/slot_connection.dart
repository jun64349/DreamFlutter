/// A Pi RPC byte stream carried over the core connection, so [PiRpcClient]
/// talks to a core-hosted session exactly as it would to a `pi --mode rpc`
/// child process.
library;

import 'dart:async';
import 'dart:convert';

import 'client.dart';
import 'core_client.dart';
import 'json.dart';
import 'jsonl.dart';

class SlotConnection implements PiConnection {
  SlotConnection(this.core, this._slotId) {
    _sub = core.events.listen(_onEvent);
    core.closed.then((_) => _finish(-1));
  }

  final CoreClient core;
  String _slotId;
  late final StreamSubscription<Json> _sub;
  // Single-subscription: records that arrive before the client listens are buffered.
  final _stdout = StreamController<List<int>>();
  final _done = Completer<int>();
  var _closing = false;

  String get slotId => _slotId;

  /// Follows the session to another slot (the core returned an existing slot
  /// that already had the requested session file open).
  void retarget(String slotId) => _slotId = slotId;

  void _onEvent(Json message) {
    switch (message['event']) {
      case 'slot.record' when message['slotId'] == _slotId:
        inject([asJson(message['record'])]);
      case 'slot.closed' when message['slotId'] == _slotId:
        _finish(0);
    }
  }

  /// Feeds records into the stream as if the session had just written them.
  void inject(Iterable<Json> records) {
    if (_stdout.isClosed) return;
    for (final record in records) {
      _stdout.add(utf8.encode(encodeRecord(record)));
    }
  }

  @override
  Stream<List<int>> get stdout => _stdout.stream;

  @override
  void write(String data) {
    for (final line in const LineSplitter().convert(data)) {
      if (line.trim().isEmpty) continue;
      final record = asJson(jsonDecode(line));
      core.call('slot.send', {'slotId': _slotId, 'record': record}).catchError((Object error) {
        // Let the waiting command fail instead of timing out.
        final id = record['id'];
        if (id is String) {
          inject([
            {'id': id, 'type': 'response', 'command': record['type'], 'success': false, 'error': '$error'},
          ]);
        }
        return null;
      });
    }
  }

  /// Stops watching the session. The session itself keeps running in the core.
  @override
  Future<void> close() async {
    if (_closing) return;
    _closing = true;
    if (!core.isClosed) {
      try {
        await core.call('slot.detach', {'slotId': _slotId}, const Duration(seconds: 5));
      } catch (_) {}
    }
    _finish(0);
  }

  void _finish(int code) {
    if (!_done.isCompleted) _done.complete(code);
    unawaited(_sub.cancel());
    if (!_stdout.isClosed) unawaited(_stdout.close());
  }

  @override
  Future<int> get done => _done.future;
}

/// What to open in the core.
class SessionTarget {
  const SessionTarget({required this.cwd, this.sessionPath, this.attachSlotId, this.incognito = false, this.agentMode, this.sandbox = false, this.forkOf, this.sideQuote, this.quoteEntryId, this.parentSlotId});

  /// Working directory for a new session.
  final String cwd;

  /// Existing session file to open.
  final String? sessionPath;

  /// Live slot to attach to instead of opening anything.
  final String? attachSlotId;

  /// Temporary chat: kept in memory only, never saved or remembered.
  final bool incognito;

  /// Agent mode of a new session ("standard" or "minimal"); null = the core's default.
  final String? agentMode;

  /// A 蝶君 session: its tools run in the WSL sandbox.
  final bool sandbox;

  /// Side conversation source; saved on first send unless [incognito].
  final String? forkOf;
  final String? sideQuote;
  final String? quoteEntryId;
  final String? parentSlotId;
}

/// A session client that may still be starting. Listen to [client] right away
/// (the trust prompt can arrive before [ready]), then await [ready].
class LaunchedSession {
  LaunchedSession(this.client, this.ready, {this.slotId, this.willPersist, this.afterHistory = _noop});

  final PiRpcClient client;
  final Future<void> ready;

  /// Current core slot id (null for test doubles). A function because the
  /// core may hand back an existing slot during [ready].
  final String? Function()? slotId;
  final bool? Function()? willPersist;

  /// Call once the history from `get_messages` is shown; replays the dialogs
  /// and live run state of a slot that was attached mid-run.
  final void Function() afterHistory;

  static void _noop() {}
}

/// Opens [target] in the core, or attaches to a live slot.
LaunchedSession launchInCore(CoreClient core, SessionTarget target, {String Function()? newSlotId}) {
  final requested = target.attachSlotId ?? (newSlotId ?? _randomId)();
  final connection = SlotConnection(core, requested);
  final client = PiRpcClient(connection);
  var deferred = <Json>[];
  bool? willPersist;

  Future<void> start() async {
    if (target.attachSlotId != null) {
      final result = asJson(await core.call('slot.attach', {'slotId': requested}));
      willPersist = asJson(result['info'])['willPersist'] as bool?;
      deferred = [...asJsonList(result['replay']), ...asJsonList(result['live'])];
      return;
    }
    final info = asJson(
      await core.call('slot.open', {
        'slotId': requested,
        'cwd': target.cwd,
        'sessionFile': ?target.sessionPath,
        if (target.incognito) 'incognito': true,
        'agentMode': ?target.agentMode,
        if (target.sandbox) 'sandbox': true,
        'forkOf': ?target.forkOf,
        'sideQuote': ?target.sideQuote,
        'quoteEntryId': ?target.quoteEntryId,
        'parentSlotId': ?target.parentSlotId,
      }, const Duration(minutes: 30)), // may wait on the trust prompt
    );
    final actual = asString(info['slotId']);
    willPersist = info['willPersist'] as bool?;
    if (actual != null && actual != requested) {
      connection.retarget(actual);
      final result = asJson(await core.call('slot.attach', {'slotId': actual}));
      deferred = [...asJsonList(result['replay']), ...asJsonList(result['live'])];
    }
  }

  return LaunchedSession(
    client,
    start(),
    slotId: () => connection.slotId,
    willPersist: () => willPersist,
    afterHistory: () {
      connection.inject(deferred);
      deferred = const [];
    },
  );
}

var _idCounter = 0;
String _randomId() => 'ui-${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}-${++_idCounter}';
