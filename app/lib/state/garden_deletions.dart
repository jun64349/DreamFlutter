import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'backend.dart';
import 'session_runtime.dart';

/// A durable five-second grace period. File/config mutations still belong to Core.
class GardenDeletions extends ChangeNotifier {
  GardenDeletions(this.backend);
  static const preferenceKey = 'gardenPendingDeletes';
  final AgentBackend backend;
  final _pending = <String, Json>{}, _timers = <String, Timer>{};
  final _running = <String, Future<void>>{};
  Future<void> _writes = Future.value();
  String? error;
  bool _disposed = false;
  int _serial = 0;
  Set<String> get hiddenKeys => _pending.values.map((v) => v['key'] as String).toSet();
  void _notify() { if (!_disposed) notifyListeners(); }
  Future<void> _save() {
    final value = jsonEncode(_pending.values.toList());
    final write = _writes.catchError((Object _) {}).then((_) async {
      final prefs = await SharedPreferences.getInstance();
      if (!await prefs.setString(preferenceKey, value)) throw StateError('没有记住删除操作，请重试');
    });
    _writes = write; return write;
  }
  Future<void> resume() async {
    final saved = (await SharedPreferences.getInstance()).getString(preferenceKey);
    if (saved == null) return;
    final rows = jsonDecode(saved) as List;
    for (final row in rows) {
      final job = Map<String, dynamic>.from(row as Map);
      if (['skills.remove','templates.remove','mcp.remove'].contains(job['method']) && job['id'] is String && job['key'] is String && job['params'] is Map) _pending[job['id'] as String] = job;
    }
    // A previous process exited during the grace period: deletion is committed.
    await flushPending();
  }
  Future<String> stage(String key, String method, Json params) async {
    final existing = _pending.values.where((job) => job['key'] == key).firstOrNull;
    if (existing != null) return existing['id'] as String;
    final id = '${DateTime.now().microsecondsSinceEpoch}-${_serial++}';
    _pending[id] = {'id': id, 'key': key, 'method': method, 'params': params};
    try { await _save(); } catch (_) { _pending.remove(id); rethrow; }
    error = null;
    _timers[id] = Timer(const Duration(seconds: 5), () => unawaited(_commit(id)));
    _notify(); return id;
  }
  Future<void> undo(String id) async {
    if (_running.containsKey(id) || !_pending.containsKey(id)) throw StateError('撤销时间已过');
    _timers.remove(id)?.cancel();
    final job = _pending.remove(id)!;
    try { await _save(); } catch (_) { _pending[id] = job; _timers[id] = Timer(const Duration(seconds: 5), () => unawaited(_commit(id))); rethrow; }
    _notify();
  }
  Future<void> _commit(String id, {bool retainFailure = false}) {
    final running = _running[id];
    if (running != null) return running;
    final job = _pending[id];
    if (job == null) return Future.value();
    _timers.remove(id)?.cancel();
    final future = () async {
      try {
        await backend.call(job['method'] as String, Map<String, dynamic>.from(job['params'] as Map));
        _pending.remove(id); await _save();
      } catch (e) {
        error = '没有删除：${SessionRuntime.describeError(e).replaceAll('MCP', '服务').replaceAll('模板', '技能')}';
        if (!retainFailure) { _pending.remove(id); try { await _save(); } catch (_) {} }
      } finally { _running.remove(id); _notify(); }
    }();
    _running[id] = future; return future;
  }
  Future<void> flushPending() async {
    for (final id in _pending.keys.toList()) { await _commit(id, retainFailure: true); }
    await _writes.catchError((Object _) {});
  }
  @override
  void dispose() { _disposed = true; for (final timer in _timers.values) { timer.cancel(); } super.dispose(); }
}
