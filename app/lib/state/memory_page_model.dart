import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:pi_rpc/pi_rpc.dart';

import 'agent_controller.dart';
import 'memory_ui.dart';

void checkMemoryChange(Json result) {
  final rejected = memoryRows(result['rejected']);
  final conflicts = memoryRows(result['conflicts']);
  if (rejected.isNotEmpty || conflicts.isNotEmpty) {
    throw StateError(
      (rejected.isNotEmpty ? rejected : conflicts)
          .map((r) => r['reason'])
          .join('；'),
    );
  }
}

class MemoryPageModel extends ChangeNotifier {
  MemoryPageModel(this.agent) {
    _events = agent.backend.events.listen((event) {
      if (event['event'] == 'memory.changed') unawaited(load());
    });
  }
  final AgentController agent;
  List<Json> items = [];
  bool loading = true;
  String? error;
  int _request = 0;
  bool _disposed = false;
  StreamSubscription<Json>? _events;

  Future<void> load() async {
    final request = ++_request;
    try {
      final rows = await Future.wait([
        agent.backend.call('memory.items', {
          'cwd': agent.workspace,
          'status': ['active', 'review'],
        }),
        agent.backend.call('memory.items', {
          'scope': 'butterfly',
          'status': ['active', 'review'],
        }),
      ]);
      if (_disposed || request != _request) return;
      items = {
        for (final row in rows.expand(memoryRows)) row['id'] as String: row,
      }.values.toList();
      error = null;
    } catch (e) {
      if (_disposed || request != _request) return;
      error = SessionRuntime.describeError(e);
    }
    if (!_disposed) {
      loading = false;
      notifyListeners();
    }
  }

  Future<String> remove(Json item) async {
    final result = memoryMap(
      await agent.backend.call('memory.setStatus', {
        'id': item['id'],
        'version': item['version'],
        'status': 'forgotten',
      }),
    );
    checkMemoryChange(result);
    final batchId = result['batchId'] as String?;
    if (batchId == null || memoryRows(result['applied']).isEmpty) {
      throw StateError('这条记忆没有删除，请重试');
    }
    items.removeWhere((r) => r['id'] == item['id']);
    if (!_disposed) notifyListeners();
    return batchId;
  }

  Future<void> undo(String batchId) async {
    checkMemoryChange(
      memoryMap(
        await agent.backend.call('memory.undoBatch', {'batchId': batchId}),
      ),
    );
    await load();
  }

  @override
  void dispose() {
    _disposed = true;
    _events?.cancel();
    super.dispose();
  }
}
