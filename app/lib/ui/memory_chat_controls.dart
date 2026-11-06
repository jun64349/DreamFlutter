import 'dart:async';
import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';
import '../state/agent_controller.dart';
import '../state/memory_ui.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'memory_details.dart';
import 'session_dialogs.dart';

class SessionMemoryActions extends StatefulWidget {
  const SessionMemoryActions({super.key});
  @override
  State<SessionMemoryActions> createState() => _SessionMemoryActionsState();
}
class _SessionMemoryActionsState extends State<SessionMemoryActions> {
  String? _sessionId;
  String? _path;
  String? _mode;
  List<Json>? _children;
  String? _error;
  bool _busy = false;
  int _request = 0;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final agent = AgentScope.of(context);
    if (_sessionId != agent.activeSessionId || _path != agent.active?.sessionPath) {
      _sessionId = agent.activeSessionId;
      _path = agent.active?.sessionPath;
      _mode = null;
      _children = null;
      unawaited(_load());
    }
  }
  Future<void> _load() async {
    final request = ++_request;
    final agent = AgentScope.read(context);
    if (_sessionId == null) return;
    try {
      final result = await Future.wait([agent.backend.call('memory.sessionMode', {'sessionId': _sessionId}), if (_path != null) agent.backend.call('sessions.children', {'parentSession': _path, 'cwd': agent.workspace})]);
      if (!mounted || request != _request) return;
      setState(() { _mode = memoryMap(result.first)['mode'] as String?; _children = result.length > 1 ? memoryRows(result[1]) : []; _error = null; });
    } catch (e) { if (mounted && request == _request) setState(() => _error = SessionRuntime.describeError(e)); }
  }
  Future<void> _call(String method, Json params) async {
    if (_busy) return;
    final id = _sessionId;
    final agent = AgentScope.read(context);
    setState(() { _busy = true; _error = null; });
    try {
      final result = memoryMap(await agent.backend.call(method, {'sessionId': id, ...params}));
      if (!mounted) return;
      if (method == 'memory.newTask') ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(result['note'] as String? ?? '下一条消息开始一个新任务')));
      await _load();
    } catch (e) { if (mounted) setState(() => _error = SessionRuntime.describeError(e)); }
    finally { if (mounted) setState(() => _busy = false); }
  }
  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final enabled = !_busy && _sessionId != null && agent.active?.incognito != true;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const SizedBox(height: 8),
      OutlinedButton(onPressed: enabled ? () => _call('memory.newTask', {}) : null, child: const Text('下一条作为新任务')),
      const SizedBox(height: 12),
      DropdownButtonFormField<String>(key: ValueKey('$_sessionId-$_mode'), initialValue: ['normal', 'readonly', 'off'].contains(_mode) ? _mode : null, decoration: const InputDecoration(labelText: '本会话记忆'), items: const [DropdownMenuItem(value: 'normal', child: Text('正常')), DropdownMenuItem(value: 'readonly', child: Text('只读')), DropdownMenuItem(value: 'off', child: Text('关闭'))], onChanged: enabled && _mode != null ? (v) => _call('memory.setSessionMode', {'mode': v}) : null),
      const SizedBox(height: 8),
      OutlinedButton(onPressed: _path == null || _busy ? null : () async {
        await _load();
        if (context.mounted && _error == null && _children != null) await showRelatedConversations(context, _children!);
      }, child: Text('相关对话 (${_children?.length ?? '…'})')),
      if (_error != null) Text(_error!, style: TextStyle(color: context.colors.danger)),
    ]);
  }
}

/// The divider is tied to a concrete user entry, not the latest message at
/// render time. Ambiguous or missing identities are never attached elsewhere.
class MemoryBoundaryNote extends StatelessWidget {
  const MemoryBoundaryNote({super.key, required this.item});
  final UserItem item;
  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    return ListenableBuilder(listenable: agent.memoryUi, builder: (context, _) {
      final boundary = agent.memoryUi.boundaries[agent.activeSessionId];
      if (boundary == null || item.entryId == null || boundary['userEntryId'] != item.entryId) return const SizedBox.shrink();
      return _MemoryActionNote(text: '识别为新任务', action: '改为继续上一个', onAction: () async {
        await agent.backend.call('memory.continueTask', {'sessionId': agent.activeSessionId});
        agent.memoryUi.boundaries.remove(agent.activeSessionId);
        agent.memoryUi.changed();
      }, divider: true);
    });
  }
}

class UnsavedMemoryNote extends StatefulWidget {
  const UnsavedMemoryNote({super.key, required this.replies});
  final List<AssistantItem> replies;
  @override
  State<UnsavedMemoryNote> createState() => _UnsavedMemoryNoteState();
}
class _UnsavedMemoryNoteState extends State<UnsavedMemoryNote> {
  String? _saved;
  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    return ListenableBuilder(listenable: agent.memoryUi, builder: (context, _) {
      final claim = agent.memoryUi.unsaved[agent.activeSessionId];
      if (_saved != null) return Text(_saved!, style: context.text.bodySmall?.copyWith(color: context.colors.success));
      if (claim == null || claim['replyEntryId'] == null || !widget.replies.any((r) => r.entryId == claim['replyEntryId'])) return const SizedBox.shrink();
      final pending = claim['pending'] == true || (claim['pendingIds'] as List? ?? []).isNotEmpty;
      return _MemoryActionNote(text: pending ? '已提出，等你确认' : '回复里说已记住，但其实没有保存', action: pending ? '去确认' : '保存', onAction: () async {
        if (pending) { agent.openMemory(tab: 'pending'); return; }
        final result = await showUnsavedMemoryEditor(context, claim);
        if (result != null && mounted) setState(() => _saved = memoryReceipt(result, verb: '已保存到${memoryScope(memoryMap(result['item']))}'));
      }, trailing: pending ? null : TextButton(onPressed: () => agent.memoryUi.dismiss(claim), child: const Text('忽略')));
    });
  }
}

class MemoryLiveNotices extends StatelessWidget {
  const MemoryLiveNotices({super.key});
  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    return ListenableBuilder(listenable: agent.memoryUi, builder: (context, _) => Column(children: [
      for (final notice in agent.memoryUi.notices.where((n) => n['sessionId'] == null ? !agent.sandbox : n['sessionId'] == agent.activeSessionId))
        _MemoryActionNote(text: switch (notice['kind']) {
          'capacity_full' => '记忆容量已满：${notice['tokens']} / ${notice['capacity']} tokens',
          'expired_protected' => '有到期的受保护记忆需要复核',
          'blocked' => '安全扫描已拦截可疑记忆',
          'summary_revived' => '摘要重复了已纠正的内容，请查看',
          _ => '记忆需要查看',
        }, action: '查看', onAction: () async {
          final ids = (notice['itemIds'] as List? ?? []).whereType<String>().toList();
          agent.openMemory(tab: ids.length == 1 ? 'memory' : 'log', itemId: ids.length == 1 ? ids.first : null);
        }, secondaryAction: notice['kind'] == 'summary_revived' ? '重新生成' : null, onSecondary: notice['kind'] == 'summary_revived' ? () async {
          final runtime = agent.active;
          final slotId = runtime?.slotId;
          if (slotId == null || runtime == null || runtime.isRunning || runtime.isCompacting) throw StateError('请在会话空闲后重新生成');
          final entries = memoryRows(await agent.backend.call('context.checkpoints', {'slotId': slotId}));
          if (entries.isEmpty) throw StateError('当前分支还没有压缩记录');
          final result = memoryMap(await agent.backend.call('context.regenerate', {'slotId': slotId, 'entryId': entries.last['entryId']}, const Duration(minutes: 3)));
          if (result.isEmpty) throw StateError('没有生成新摘要');
          await runtime.refreshHistory();
          if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(switch (result['source']) { 'original' => '已按原文重写', 'previous_summary' => '已在旧摘要上修订', _ => '摘要已重新生成，后台未说明依据来源' })));
        } : null),
    ]));
  }
}

class _MemoryActionNote extends StatefulWidget {
  const _MemoryActionNote({required this.text, required this.action, required this.onAction, this.trailing, this.secondaryAction, this.onSecondary, this.divider = false});
  final String text;
  final String action;
  final Future<void> Function() onAction;
  final Widget? trailing;
  final String? secondaryAction;
  final Future<void> Function()? onSecondary;
  final bool divider;
  @override
  State<_MemoryActionNote> createState() => _MemoryActionNoteState();
}
class _MemoryActionNoteState extends State<_MemoryActionNote> {
  bool _busy = false;
  String? _error;
  Future<void> _run(Future<void> Function() action) async {
    if (_busy) return;
    setState(() { _busy = true; _error = null; });
    try { await action(); } catch (e) { if (mounted) setState(() => _error = SessionRuntime.describeError(e)); }
    finally { if (mounted) setState(() => _busy = false); }
  }
  @override
  Widget build(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    if (widget.divider) const Divider(),
    Row(crossAxisAlignment: CrossAxisAlignment.center, children: [Icon(Icons.info_outline, size: 15, color: context.colors.muted), const SizedBox(width: 6), Expanded(child: Text(widget.text, style: context.text.bodySmall?.copyWith(color: context.colors.muted))), TextButton(onPressed: _busy ? null : () => _run(widget.onAction), child: Text(widget.action)), if (widget.secondaryAction != null) TextButton(onPressed: _busy || widget.onSecondary == null ? null : () => _run(widget.onSecondary!), child: Text(widget.secondaryAction!)), if (widget.trailing != null) widget.trailing!]),
    if (_error != null) Text(_error!, style: TextStyle(color: context.colors.danger)),
  ]);
}
