import 'dart:async';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'common.dart' show showsOnScreen;

/// The title strip has no Navigator. Actions are handled inside the owning chat.
class ConversationActionHost extends StatefulWidget {
  const ConversationActionHost({super.key, required this.child});
  final Widget child;
  @override
  State<ConversationActionHost> createState() => _ConversationActionHostState();
}

class _ConversationActionHostState extends State<ConversationActionHost> {
  StreamSubscription<String>? _subscription;
  bool _busy = false;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _subscription ??= AgentScope.read(context).conversationActions.listen((action) {
      if (mounted && showsOnScreen(context)) unawaited(_run(action));
    });
  }
  @override
  void dispose() { _subscription?.cancel(); super.dispose(); }
  Future<void> _run(String action) async {
    if (_busy) return;
    _busy = true;
    final agent = AgentScope.read(context);
    try {
      switch (action) {
        case 'skill':
          await agent.draftSkillFromSession();
        case 'export':
          final path = agent.currentSessionPath;
          if (path != null && mounted) await exportConversation(context, agent, path, agent.sessionTitle);
        case 'archive':
          final path = agent.currentSessionPath;
          if (path != null) {
            await agent.setArchived(path, true);
            if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已归档，在侧栏底部「已归档」里')));
          }
        case 'delete':
          if (agent.active?.incognito == true) { await agent.newSession(); }
          else if (agent.currentSessionPath case final path?) { if (mounted) await deleteConversation(context, agent, path); }
      }
    } catch (error) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(SessionRuntime.describeError(error))));
    } finally { _busy = false; }
  }
  @override
  Widget build(BuildContext context) => widget.child;
}

/// Exports a conversation as Markdown (the only export since 0.8.1 R.5) and says where it went.
Future<void> exportConversation(BuildContext context, AgentController agent, String path, String title) async {
  final location = await getSaveLocation(
    suggestedName: '${title.replaceAll(RegExp(r'[\\/:*?"<>|\s]+'), '_')}.md',
    acceptedTypeGroups: [const XTypeGroup(label: 'Markdown', extensions: ['md'])],
  );
  if (location == null) return;
  final saved = await agent.exportSession(path, 'markdown', location.path);
  if (saved == null || !context.mounted) return;
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(
    persist: false,
    duration: const Duration(seconds: 5),
    content: Text('已导出：$saved'),
    action: SnackBarAction(label: '打开所在文件夹', onPressed: () => agent.revealFile(saved)),
  ));
}

/// Deleting a conversation asks first (0.8.1 R.6): it goes to the recycle bin and can be restored there for 30 days.
Future<void> deleteConversation(BuildContext context, AgentController agent, String path, {String? title}) async {
  final name = title ?? (agent.currentSessionPath == path ? agent.sessionTitle : null);
  final sure = await showDialog<bool>(context: context, builder: (dialog) => AlertDialog(
    title: Text(name == null || name.isEmpty ? '删除这个对话？' : '删除「${name.length > 20 ? '${name.substring(0, 20)}…' : name}」？'),
    content: const Text('删除后进回收站，30 天内可以恢复。'),
    actions: [
      TextButton(onPressed: () => Navigator.pop(dialog, false), child: const Text('取消')),
      FilledButton(style: FilledButton.styleFrom(backgroundColor: context.colors.danger), onPressed: () => Navigator.pop(dialog, true), child: const Text('删除')),
    ],
  ));
  if (sure != true || !context.mounted) return;
  if (!await agent.deleteSession(path) || !context.mounted) return;
  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已移到回收站')));
}

Future<void> showConversationRecycleBin(BuildContext context) {
  final agent = AgentScope.read(context);
  return showDialog<void>(context: context, builder: (_) => AgentScope(controller: agent, child: const _RecycleBin()));
}

class _RecycleBin extends StatefulWidget {
  const _RecycleBin();
  @override
  State<_RecycleBin> createState() => _RecycleBinState();
}

class _RecycleBinState extends State<_RecycleBin> {
  List<Json>? _rows;
  String? _error;
  String? _restoring;
  late final _agent = AgentScope.read(context);
  @override
  void initState() { super.initState(); unawaited(_load()); }
  Future<void> _load() async {
    try {
      final result = jsonRows(await _agent.backend.call('sessions.recycleBin'));
      if (mounted) setState(() { _rows = result; _error = null; });
    } catch (error) { if (mounted) setState(() => _error = SessionRuntime.describeError(error)); }
  }
  Future<void> _restore(String id) async {
    setState(() => _restoring = id);
    try { await _agent.backend.call('sessions.restore', {'batchId': id}); await _agent.refreshSessions(); await _load(); }
    catch (error) { if (mounted) setState(() => _error = SessionRuntime.describeError(error)); }
    finally { if (mounted) setState(() => _restoring = null); }
  }
  @override
  Widget build(BuildContext context) {
    final seen = <String>{};
    final rows = (_rows ?? const []).where((r) => r['batchId'] is String && seen.add(r['batchId'] as String)).toList();
    return AlertDialog(title: const Text('回收站'), content: SizedBox(width: 520, child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, children: [
      if (_error != null) Text(_error!, style: TextStyle(color: context.colors.danger)),
      if (_rows == null && _error == null) const LinearProgressIndicator(),
      if (_rows != null && rows.isEmpty) const Text('回收站是空的'),
      for (final row in rows) ListTile(
        contentPadding: EdgeInsets.zero,
        title: Text(asJsonMap(row['session'])['title'] as String? ?? '新对话', maxLines: 2, overflow: TextOverflow.ellipsis),
        trailing: TextButton(onPressed: _restoring == null ? () => _restore(row['batchId'] as String) : null, child: Text(_restoring == row['batchId'] ? '正在恢复…' : '恢复')),
      ),
    ]))), actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('关闭'))]);
  }
}
