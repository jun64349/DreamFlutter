import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'agent_controller.dart';
import 'memory_ui.dart';

/// T-138 consumes this request and opens the butterfly calendar at this item.
final scheduleNavigationRequest = ValueNotifier<String?>(null);

/// A conversation-scoped view of authoritative goals and jobs. Late replies from
/// an earlier conversation never replace the current snapshot.
class GoalConversation extends ChangeNotifier {
  GoalConversation(this.agent) {
    agent.addListener(_sessionChanged);
    _events = agent.backend.events.listen((e) {
      if (const ['goals.changed', 'goal.proposals.changed', 'jobs.changed', 'job.finished', 'confirm.changed'].contains(e['event'])) unawaited(refresh());
    });
    _sessionChanged();
  }
  final AgentController agent;
  StreamSubscription<Json>? _events;
  Timer? _clock;
  String? _identity;
  bool _disposed = false;
  int _request = 0;
  Json? goal;
  List<Json> jobs = [], proposals = [];
  List<Json> questions = [];
  final _customAnswers = <String, String>{};
  final outputs = <String, String>{};
  final offsets = <String, int>{};
  final busy = <String>{};
  String? error;
  static const finishedRetention = Duration(seconds: 30);
  void _notify() { if (!_disposed) notifyListeners(); }
  void _sessionChanged() {
    final identity = '${agent.active?.slotId}:${agent.currentSessionPath}';
    if (_identity == identity) return;
    _identity = identity;
    goal = null; jobs = []; proposals = []; questions = []; outputs.clear(); offsets.clear(); _customAnswers.clear(); error = null;
    unawaited(refresh());
  }
  Future<void> refresh() async {
    final ticket = ++_request;
    final file = agent.currentSessionPath, slot = agent.active?.slotId;
    if (slot == null || agent.active?.incognito == true) { _notify(); return; }
    try {
      final results = await Future.wait([
        file == null ? Future<Object?>.value(null) : agent.backend.call('goals.bySession', {'sessionFiles': [file], 'partition': agent.sandbox ? 'butterfly' : 'workbench'}),
        agent.backend.call('jobs.list', {if (file != null) 'sessionFile': file else 'slotId': slot}),
        agent.backend.call('goals.proposals'),
        agent.backend.call('confirm.list', {'limit': 100}),
      ]);
      // goals.bySession: this conversation's latest goal, whatever its status.
      final latest = file == null ? null : memoryMap(memoryMap(results[0])['goals'])[file];
      final detail = latest is Map && latest['kind'] != 'proposal' ? memoryMap(await agent.backend.call('goals.get', {'id': latest['id']})) : null;
      if (_disposed || ticket != _request) return;
      goal = detail; jobs = memoryRows(results[1]);
      proposals = memoryRows(results[2]).where((p) => file != null && p['sessionFile'] == file).toList();
      questions = memoryRows(results[3]).where((q) => q['slotId'] == slot && '${q['title']}'.startsWith('Agent 需要你补充信息')).toList().reversed.toList();
      error = null;
      _clock?.cancel();
      if (jobs.isNotEmpty || questions.any((q) => q['status'] == 'pending')) { _clock = Timer.periodic(const Duration(seconds: 1), (_) {
        final now = DateTime.now().millisecondsSinceEpoch;
        jobs.removeWhere((j) => j['status'] != 'running' && j['ended_at'] is num && now - (j['ended_at'] as num) > finishedRetention.inMilliseconds);
        if (jobs.isEmpty && !questions.any((q) => q['status'] == 'pending')) { _clock?.cancel(); _clock = null; }
        _notify();
      }); }
      _notify();
      for (final question in questions.where((q) => q['status'] == 'pending' && q['method'] == 'input')) {
        final answer = _customAnswers.remove('${question['title']}');
        if (answer != null) await answerQuestion(question, answer);
      }
      for (final id in outputs.keys.toList()) { await readOutput(id); }
    } catch (e) {
      if (!_disposed && ticket == _request) { error = SessionRuntime.describeError(e); _notify(); }
    }
  }
  Future<void> _act(String key, Future<void> Function() action) async {
    if (!busy.add(key)) return;
    error = null; _notify();
    try { await action(); if (!_disposed) await refresh(); }
    catch (e) { if (!_disposed) error = SessionRuntime.describeError(e); }
    finally { busy.remove(key); _notify(); }
  }
  Future<void> control(String action) => _act('goal', () async {
    final id = goal?['id'];
    if (id == null) return;
    await agent.backend.call('goals.control', {'id': id, 'action': action});
  });
  /// Global emergency stop (docs/api/goals-schedules.md goals.control): every goal, 蝶君 and 工作台.
  Future<void> emergency(bool on) => _act('goal', () async { await agent.backend.call('goals.control', {'action': on ? 'emergency' : 'clear_emergency'}); await refresh(); });
  Future<void> resolveProposal(Json proposal, bool accept) => _act('proposal:${proposal['id']}', () async {
    await agent.backend.call('goals.proposals.resolve', {'id': proposal['id'], 'action': accept ? 'accept' : 'reject'});
  });
  Future<void> stopJob(String id) => _act('job:$id', () async { await agent.backend.call('jobs.stop', {'id': id}); });
  Future<void> answerQuestion(Json question, String value, {bool custom = false}) => _act('question:${question['id']}', () async {
    if (custom && question['method'] == 'select') {
      _customAnswers['${question['title']}'] = value;
      try { await agent.backend.call('confirm.answer', {'id': question['id'], 'response': {'value': '自己回答…'}}); }
      catch (_) { _customAnswers.remove('${question['title']}'); rethrow; }
    } else {
      await agent.backend.call('confirm.answer', {'id': question['id'], 'response': {'value': value}});
    }
  });
  Future<void> toggleOutput(String id) async {
    if (outputs.containsKey(id)) { outputs.remove(id); offsets.remove(id); _notify(); return; }
    outputs[id] = ''; offsets[id] = 0; _notify();
    await readOutput(id);
  }
  Future<void> readOutput(String id) async {
    if (!busy.add('output:$id')) return;
    final identity = _identity;
    try {
      final data = memoryMap(await agent.backend.call('jobs.output', {'id': id, 'from': offsets[id] ?? 0}));
      if (_disposed || identity != _identity || !outputs.containsKey(id)) return;
      outputs[id] = '${outputs[id]}${data['text'] ?? ''}';
      offsets[id] = (data['next'] as num?)?.toInt() ?? offsets[id] ?? 0;
    } catch (e) { if (!_disposed && identity == _identity) error = SessionRuntime.describeError(e); }
    finally { busy.remove('output:$id'); _notify(); }
  }
  @override
  void dispose() { if (_disposed) return; _disposed = true; _request++; _events?.cancel(); _clock?.cancel(); agent.removeListener(_sessionChanged); super.dispose(); }
}
