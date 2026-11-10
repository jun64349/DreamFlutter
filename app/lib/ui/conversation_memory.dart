import 'dart:async';

import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';

String _content(Object? value) => value is String ? value : asJsonMap(value)['content'] as String? ?? '';

class ReplyMemoryCorrections extends StatefulWidget {
  const ReplyMemoryCorrections({super.key, required this.replies});
  final List<AssistantItem> replies;
  @override
  State<ReplyMemoryCorrections> createState() => _ReplyMemoryCorrectionsState();
}

class _ReplyMemoryCorrectionsState extends State<ReplyMemoryCorrections> {
  StreamSubscription<Json>? _events;
  String _signature = '';
  List<Json> _receipts = [];
  final _undone = <String>{};
  String? _busy;
  String? _error;
  int _generation = 0;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final agent = AgentScope.of(context);
    _events ??= agent.backend.events.listen((event) {
      if (event['event'] == 'memory.correction' && event['sessionId'] == agent.activeSessionId) unawaited(_load());
    });
    final signature = '${agent.activeSessionId}:${widget.replies.map((r) => r.entryId).join(',')}';
    if (signature != _signature) { _signature = signature; unawaited(_load()); }
  }
  @override
  void didUpdateWidget(ReplyMemoryCorrections old) {
    super.didUpdateWidget(old);
    final agent = AgentScope.read(context);
    final signature = '${agent.activeSessionId}:${widget.replies.map((r) => r.entryId).join(',')}';
    if (signature != _signature) { _signature = signature; unawaited(_load()); }
  }
  @override
  void dispose() { _events?.cancel(); super.dispose(); }
  Future<void> _load() async {
    final generation = ++_generation;
    final agent = AgentScope.read(context);
    final sessionId = agent.activeSessionId;
    if (sessionId == null) return;
    await agent.active?.refreshEntryIds();
    final ids = widget.replies.map((r) => r.entryId).whereType<String>().toSet();
    if (ids.isEmpty || !mounted || generation != _generation) return;
    try {
      final result = await Future.wait(ids.map((id) async => jsonRows(await agent.backend.call('memory.corrections', {'sessionId': sessionId, 'entryId': id}))));
      if (!mounted || generation != _generation || agent.activeSessionId != sessionId) return;
      final seen = <String>{};
      setState(() { _receipts = [for (final rows in result) for (final row in rows) if (row['status'] == 'applied' && row['batchId'] is String && ids.contains(row['entryId']) && seen.add(row['batchId'] as String)) row]; });
    } catch (_) { /* Background lookup never claims that an unverified edit was saved. */ }
  }
  Future<void> _undo(String batchId) async {
    setState(() { _busy = batchId; _error = null; });
    try {
      final result = asJsonMap(await AgentScope.read(context).backend.call('memory.undoBatch', {'batchId': batchId}));
      final conflicts = jsonRows(result['conflicts']);
      final undone = result['undone'] is List ? result['undone'] as List : const [];
      if (!mounted) return;
      if (conflicts.isNotEmpty || undone.isEmpty) {
        setState(() => _error = conflicts.isEmpty ? '没有可撤销的改动' : undone.isEmpty ? '这条记忆后来已修改，不能撤销' : '部分记忆已撤销，其余后来已修改');
        await _load();
      } else { setState(() => _undone.add(batchId)); }
    } catch (error) { if (mounted) setState(() => _error = SessionRuntime.describeError(error)); }
    finally { if (mounted) setState(() => _busy = null); }
  }
  Future<void> _view(Json receipt) => showDialog<void>(context: context, builder: (context) => AlertDialog(
    title: const Text('记忆修改'), content: SizedBox(width: 520, child: SingleChildScrollView(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      for (final change in jsonRows(receipt['changes'])) ...[
        if (_content(change['before']).isNotEmpty) Text(_content(change['before']), style: context.text.bodyMedium?.copyWith(color: context.colors.muted, decoration: TextDecoration.lineThrough)),
        const SizedBox(height: 6), SelectableText(_content(change['after']), style: context.text.bodyMedium), const SizedBox(height: 16),
      ],
    ]))), actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('关闭'))],
  ));
  @override
  Widget build(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    for (final receipt in _receipts.where((r) => !_undone.contains(r['batchId']))) Wrap(spacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
      Icon(Icons.lightbulb_outline, size: 15, color: context.colors.accent), Text('已更新记忆', style: context.text.bodySmall?.copyWith(color: context.colors.accent)),
      TextButton(onPressed: () => _view(receipt), child: const Text('查看')),
      if (jsonRows(receipt['changes']).any((change) => change['undoable'] == true)) TextButton(onPressed: _busy == null ? () => _undo(receipt['batchId'] as String) : null, child: const Text('撤销')),
    ]),
    if (_error != null) Text(_error!, style: TextStyle(color: context.colors.danger)),
  ]);
}

/// Select the historical versions injected before this reply, never today's values.
Future<List<Json>> replyMemoryReferences(AgentController agent, List<AssistantItem> replies) async {
  if (replies.isEmpty || agent.activeSessionId == null) return [];
  final first = replies.first;
  final before = first.requestedAt?.millisecondsSinceEpoch ?? first.timestamp;
  if (before <= 0) return [];
  final snapshots = jsonRows(await agent.backend.call('memory.snapshots', {'sessionId': agent.activeSessionId}));
  final eligible = snapshots.where((s) => s['createdAt'] is num && (s['createdAt'] as num) <= before && s['status'] != 'failed').toList()
    ..sort((a, b) => (b['createdAt'] as num).compareTo(a['createdAt'] as num));
  if (eligible.isEmpty || eligible.first['itemVersions'] is! Map) return [];
  final versions = asJsonMap(eligible.first['itemVersions']);
  final rows = await Future.wait(versions.entries.map((entry) async {
    final detail = asJsonMap(await agent.backend.call('memory.item', {'id': entry.key}));
    final old = jsonRows(detail['versions']).where((v) => v['version'] == entry.value).firstOrNull;
    final current = asJsonMap(detail['item']);
    return old == null ? current['version'] == entry.value ? current : <String, dynamic>{} : asJsonMap(old['item']);
  }));
  return rows.where((r) => r['content'] is String).toList();
}

Future<void> showReplyMemoryReferences(BuildContext context, List<AssistantItem> replies) async {
  final agent = AgentScope.read(context);
  final future = replyMemoryReferences(agent, replies);
  await showDialog<void>(context: context, builder: (context) => AlertDialog(
    title: const Text('它参考了哪些记忆'),
    content: SizedBox(width: 520, child: FutureBuilder<List<Json>>(future: future, builder: (context, snapshot) {
      if (snapshot.hasError) return Text('暂时无法读取，请稍后重试', style: TextStyle(color: context.colors.danger));
      if (!snapshot.hasData) return const LinearProgressIndicator();
      if (snapshot.data!.isEmpty) return const Text('没有可关联的记忆');
      return SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        for (final item in snapshot.data!) Padding(padding: const EdgeInsets.only(bottom: 12), child: SelectableText(item['content'] as String)),
      ]));
    })),
    actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('关闭'))],
  ));
}
