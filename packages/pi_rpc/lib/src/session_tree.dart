import 'json.dart';

/// Reads the current branch returned by Pi's existing get_tree RPC. No files
/// are read by the window; persisted side-session ownership stays in core.
List<Json> currentSessionBranch(Object? response) {
  final data = response is Map ? response : const {};
  final entries = <String, Json>{};
  void visit(Object? nodes) {
    if (nodes is! List) return;
    for (final raw in nodes.whereType<Map>()) {
      final entry = raw['entry'];
      if (entry is Map && entry['id'] is String) entries[entry['id'] as String] = entry.cast<String, dynamic>();
      visit(raw['children']);
    }
  }
  visit(data['tree']);
  final branch = <Json>[];
  final seen = <String>{};
  var id = data['leafId'] as String?;
  while (id != null && seen.add(id)) {
    final entry = entries[id];
    if (entry == null) break;
    branch.add(entry);
    id = entry['parentId'] as String?;
  }
  return branch.reversed.toList();
}
