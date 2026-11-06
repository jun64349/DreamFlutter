import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../state/memory_ui.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'common.dart';
import 'memory_details.dart';

class MemoryLog extends StatefulWidget {
  const MemoryLog({super.key});
  @override
  State<MemoryLog> createState() => _MemoryLogState();
}

class _MemoryLogState extends State<MemoryLog> {
  late final AgentController _agent;
  List<Json> _days = [];
  String _scope = 'all';
  Object? _cursor;
  bool _hasMore = false;
  bool _loading = false;
  bool _changing = false;
  String? _error;
  String? _receipt;
  int _request = 0;
  @override
  void initState() { super.initState(); _agent = AgentScope.read(context); _agent.libraryRevision.addListener(_reload); _load(); }
  @override
  void dispose() { _request++; _agent.libraryRevision.removeListener(_reload); super.dispose(); }
  void _reload() => _load();

  Future<void> _load({bool more = false}) async {
    final request = ++_request;
    setState(() { _loading = true; _error = null; });
    try {
      final response = await _agent.backend.call('memory.log', {if (_scope != 'all') 'scope': _scope, if (_scope == 'workspace') 'cwd': _agent.workspace, 'limit': 50, if (more && _cursor != null) 'cursor': _cursor});
      if (!mounted || request != _request) return;
      final page = memoryMap(response);
      final days = memoryRows(response is List ? response : page['days']);
      if (response is! List && page['days'] is! List) throw StateError('记忆日志返回格式不完整');
      setState(() {
        final combined = more ? [..._days, ...days] : days;
        final groups = <String, Json>{};
        for (final day in combined) {
          final key = day['day'] as String;
          final group = groups.putIfAbsent(key, () => {'day': key, 'entries': <Json>[]});
          final entries = group['entries'] as List<Json>;
          final ids = entries.map((e) => e['opId']).toSet();
          entries.addAll(memoryRows(day['entries']).where((e) => ids.add(e['opId'])));
        }
        _days = groups.values.toList();
        _cursor = page['cursor'];
        _hasMore = page['hasMore'] == true;
        if (_hasMore && _cursor == null) _error = '后台未返回下一页游标，无法继续加载。';
      });
    } catch (e) { if (mounted && request == _request) setState(() => _error = SessionRuntime.describeError(e)); }
    finally { if (mounted && request == _request) setState(() => _loading = false); }
  }

  Future<void> _undo(String method, String key, String id) async {
    if (_changing) return;
    setState(() { _changing = true; _error = null; _receipt = null; });
    try {
      final result = memoryMap(await _agent.backend.call(method, {key: id}));
      final conflicts = memoryRows(result['conflicts']);
      final count = (result['undone'] as List? ?? []).length;
      if (!mounted) return;
      setState(() => _receipt = count == 0 ? '没有改动被撤销' : memoryReceipt(result, verb: '已撤销 $count 处改动'));
      if (conflicts.isNotEmpty) await showTextDialog(context, title: count > 0 ? '部分撤销成功' : '未能撤销', text: conflicts.map((r) => '${r['itemId']}：${r['reason']}').join('\n'));
      _agent.libraryRevision.value++;
    } catch (e) { if (mounted) setState(() => _error = SessionRuntime.describeError(e)); }
    finally { if (mounted) setState(() => _changing = false); }
  }

  String _day(String raw) {
    final date = DateTime.tryParse(raw);
    return date == null ? raw : '${date.month}月${date.day}日 周${'一二三四五六日'[date.weekday - 1]}';
  }

  @override
  Widget build(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    DropdownButtonFormField<String>(initialValue: _scope, decoration: const InputDecoration(labelText: '日志范围'), items: const [DropdownMenuItem(value: 'all', child: Text('全部')), DropdownMenuItem(value: 'global', child: Text('全局')), DropdownMenuItem(value: 'workspace', child: Text('当前工作区')), DropdownMenuItem(value: 'butterfly', child: Text('蝶君'))], onChanged: _changing ? null : (v) { setState(() { _scope = v!; _days = []; _cursor = null; }); _load(); }),
    if (_receipt != null) Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Semantics(liveRegion: true, child: Text(_receipt!))),
    if (_error != null) Row(children: [Expanded(child: Text(_error!, style: TextStyle(color: context.colors.danger))), TextButton(onPressed: _loading ? null : _reload, child: const Text('重试'))]),
    if (_days.isEmpty && !_loading && _error == null) const EmptyState(title: '还没有记忆日志', message: '记忆的新增、修改和遗忘会记录在这里。'),
    for (final day in _days) ...[
      Padding(padding: const EdgeInsets.only(top: 18, bottom: 8), child: Text(_day(day['day'] as String), style: context.text.titleSmall)),
      ..._batches(memoryRows(day['entries'])),
    ],
    if (_loading || _changing) const LinearProgressIndicator(),
    if (_hasMore) Align(alignment: Alignment.center, child: TextButton(onPressed: _loading || _changing || _cursor == null ? null : () => _load(more: true), child: const Text('加载更多'))),
  ]);

  List<Widget> _batches(List<Json> entries) {
    final groups = <String, List<Json>>{};
    for (final entry in entries) {
      groups.putIfAbsent(entry['batchId'] as String? ?? entry['opId'] as String, () => []).add(entry);
    }
    Widget row(Json entry, {bool showAction = true}) => _LogEntry(key: ValueKey('memory-log-entry-${entry['opId']}'), entry: entry, busy: _changing, showAction: showAction, onUndo: () => _undo('memory.undo', 'opId', entry['opId'] as String));
    return [for (final group in groups.entries) OutlinedCard(child: Material(type: MaterialType.transparency, child: group.value.length == 1 ? row(group.value.single) : ExpansionTile(
      key: PageStorageKey('memory-batch-${group.key}'),
      tilePadding: EdgeInsets.zero,
      shape: const Border(),
      collapsedShape: const Border(),
      title: Text('${_actor(group.value.first)} · ${_action(group.value.first)}（${group.value.length}项）'),
      trailing: TextButton(onPressed: _changing || !group.value.any((e) => e['undoable'] == true) ? null : () => _undo('memory.undoBatch', 'batchId', group.key), child: const Text('撤销整批')),
      children: [for (final entry in group.value) row(entry, showAction: _actor(entry) != _actor(group.value.first) || _action(entry) != _action(group.value.first))],
    )))];
  }
}

String _actor(Json entry) => switch (entry['actor']) { 'user' => '你', 'main_agent' => '对话中的 Agent', 'memory_agent' => '后台整理', 'migration' => '迁移', _ => '系统' };
String _action(Json e) => e['batchKind'] == 'purge' || e['kind'] == 'purge' ? '彻底删除' : e['batchKind'] == 'restore' ? '恢复' : switch (e['kind']) { 'undo' => '撤销', 'add' => '保存', 'edit' => '修改', _ => memoryMap(e['after'])['status'] == 'forgotten' ? '遗忘' : '更新状态' };

class _LogEntry extends StatefulWidget {
  const _LogEntry({super.key, required this.entry, required this.busy, required this.onUndo, this.showAction = true});
  final Json entry;
  final bool busy;
  final bool showAction;
  final VoidCallback onUndo;
  @override
  State<_LogEntry> createState() => _LogEntryState();
}
class _LogEntryState extends State<_LogEntry> {
  bool _hover = false;
  bool _focus = false;
  @override
  Widget build(BuildContext context) {
    final e = widget.entry;
    final purge = _action(e) == '彻底删除';
    final item = memoryMap(e['after'] ?? e['before']);
    final scope = memoryScope(item.isEmpty ? e : item);
    final level = memoryLevel(item['level'] ?? e['level']);
    final prefix = widget.showAction ? '${_actor(e)} · ${purge ? '' : '${_action(e)} · '}' : '';
    return Focus(onFocusChange: (v) => setState(() => _focus = v), child: MouseRegion(onEnter: (_) => setState(() => _hover = true), onExit: (_) => setState(() => _hover = false), child: Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Row(children: [
      Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('$prefix${purge ? '彻底删除了一条$scope/$level记忆' : item['content'] ?? ''}', maxLines: 1, overflow: TextOverflow.ellipsis),
        Wrap(spacing: 6, runSpacing: 4, children: [TagChip(scope), TagChip(level), if (e['inferred'] == true) const TagChip('推测')]),
        if (e['reason'] is String) Text(e['reason'] as String, style: context.text.bodySmall?.copyWith(color: context.colors.muted)),
      ])),
      // Keep actions beside the text, so hidden controls reserve no blank row.
      // Keyboard focus reveals them too, without moving the surrounding entries.
      if (!purge) IgnorePointer(ignoring: !_hover && !_focus, child: Opacity(opacity: _hover || _focus ? 1 : 0, child: Row(mainAxisSize: MainAxisSize.min, children: [
        TextButton(onPressed: widget.busy || e['undoable'] != true || purge ? null : widget.onUndo, child: const Text('撤销')),
        TextButton(onPressed: widget.busy || purge || e['itemId'] == null ? null : () => showMemoryDetails(context, e['itemId'] as String), child: const Text('详情')),
      ]))),
    ]))));
  }
}
