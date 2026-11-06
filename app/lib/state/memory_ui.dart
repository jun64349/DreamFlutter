import 'package:flutter/foundation.dart';
import 'package:pi_rpc/pi_rpc.dart';

Json memoryMap(Object? value) => value is Map ? value.cast<String, dynamic>() : <String, dynamic>{};
List<Json> memoryRows(Object? value) => value is List ? value.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList() : <Json>[];

String memoryScope(Json item) => switch (item['scope']) {
  'workspace' => '工作区', 'butterfly' => '蝶君', 'group' => '共享组', _ => '全局',
};
String memoryLevel(Object? level) => switch (level) { 1 => '一级·近期', 3 => '三级·长期', _ => '二级·阶段' };
String memoryUseReceipt(Json result) => switch (result['currentTask']) {
  'next_call' => '下次调用开始使用', 'next_task' => '下个任务开始使用', _ => '',
};
String memoryReceipt(Json result, {String verb = '已保存'}) {
  final use = memoryUseReceipt(result);
  return '$verb${use.isEmpty ? '' : ' · $use'}';
}

/// Window-only routing and live notices. No history or persistence promise.
class MemoryUi extends ChangeNotifier {
  int routeRevision = 0;
  String tab = 'memory';
  String? itemId;
  final unsaved = <String, Json>{};
  final _claimRevisions = <String, int>{};
  int claimRevision(String sessionId) => _claimRevisions[sessionId] ?? 0;
  final boundaries = <String, Json>{};
  final ignoredRuns = <String>{};
  final notices = <Json>[];

  void open({String tab = 'memory', String? itemId}) {
    this.tab = tab;
    this.itemId = itemId;
    routeRevision++;
    notifyListeners();
  }

  void dismiss(Json claim) {
    ignoredRuns.add('${claim['sessionId']}:${claim['runId']}');
    unsaved.remove(claim['sessionId']);
    final id = claim['sessionId'] as String;
    _claimRevisions[id] = claimRevision(id) + 1;
    notifyListeners();
  }

  void setClaim(String sessionId, Json? claim) {
    _claimRevisions[sessionId] = claimRevision(sessionId) + 1;
    if (claim == null || (claim['cleared'] == true && unsaved[sessionId]?['runId'] == claim['runId'])) {
      unsaved.remove(sessionId);
    } else if (claim['cleared'] != true && !ignoredRuns.contains('$sessionId:${claim['runId']}')) {
      unsaved[sessionId] = claim;
    }
    notifyListeners();
  }

  void changed() => notifyListeners();
}
