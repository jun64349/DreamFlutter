import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'backend.dart';
import 'memory_ui.dart';
import 'session_runtime.dart';

class ScheduleState extends ChangeNotifier {
  ScheduleState(this.backend) {
    _events = backend.events.listen((e) { if (['schedules.changed', 'patrol.changed', 'patrol.finished'].contains(e['event'])) unawaited(refresh()); });
    _timer = Timer.periodic(const Duration(seconds: 1), (_) { if (!_disposed && patrol['cooldownUntil'] != null) notifyListeners(); });
    unawaited(refresh());
  }
  final AgentBackend backend;
  StreamSubscription<Json>? _events;
  Timer? _timer;
  bool _disposed = false, busy = false;
  int _ticket = 0;
  DateTime month = DateTime(DateTime.now().year, DateTime.now().month), day = DateTime.now();
  List<Json> schedules = [], occurrences = [], history = [], log = [];
  Json patrol = {}, detail = {};
  String? error, selectedId;
  bool get canPatrol => !busy && patrol['running'] != true && ((patrol['cooldownUntil'] as num?) ?? 0) <= DateTime.now().millisecondsSinceEpoch;
  void changed() { if (!_disposed) notifyListeners(); }
  Future<void> refresh() async {
    final ticket = ++_ticket;
    try {
      final result = await Future.wait([
        backend.call('schedules.occurrences', {'from': month.millisecondsSinceEpoch, 'to': DateTime(month.year, month.month + 1).millisecondsSinceEpoch, 'everyDay': true}),
        backend.call('patrol.status'), backend.call('patrol.log', {'limit': 50}),
      ]);
      if (_disposed || ticket != _ticket) return;
      final data = memoryMap(result[0]); occurrences = memoryRows(data['items']); schedules = memoryRows(data['schedules']); patrol = memoryMap(result[1]); log = memoryRows(result[2]);
      if (selectedId != null) await select(selectedId!);
      changed();
    } catch (e) { if (!_disposed && ticket == _ticket) { error = SessionRuntime.describeError(e); changed(); } }
  }
  void setMonth(DateTime value) { month = DateTime(value.year, value.month); day = month; selectedId = null; detail = {}; history = []; unawaited(refresh()); changed(); }
  void setDay(DateTime value) { day = value; selectedId = null; detail = {}; history = []; changed(); }
  Future<void> select(String id, {bool locate = false}) async {
    selectedId = id;
    try {
      final values = await Future.wait([backend.call('schedules.get', {'id': id}), backend.call('schedules.history', {'id': id})]);
      if (_disposed || selectedId != id) return;
      detail = memoryMap(values[0]); history = memoryRows(values[1]);
      if (locate) {
        final at = detail['nextRunAt'] ?? detail['lastRunAt'] ?? memoryMap(detail['trigger'])['at'];
        if (at is num) { day = DateTime.fromMillisecondsSinceEpoch(at.toInt()); month = DateTime(day.year, day.month); await refresh(); }
      }
      changed();
    } catch (e) { if (!_disposed) { error = SessionRuntime.describeError(e); changed(); } }
  }
  Future<bool> action(String method, [Json params = const {}]) async {
    if (busy) return false;
    busy = true; error = null; changed();
    try {
      await backend.call(method, params);
      if (method == 'schedules.remove') { selectedId = null; detail = {}; history = []; }
      await refresh(); return true;
    } on CoreException catch (e) {
      if (e.code == 'version_conflict' && e.data is Map) { detail = memoryMap(e.data); selectedId = detail['id'] as String?; error = '刚被改过，已刷新'; }
      else { error = SessionRuntime.describeError(e); }
      return false;
    } catch (e) { error = SessionRuntime.describeError(e); return false; }
    finally { busy = false; changed(); }
  }
  @override void dispose() { _disposed = true; _ticket++; _events?.cancel(); _timer?.cancel(); super.dispose(); }
}
