import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../state/memory_ui.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'common.dart';

/// The same preview and confirmation is used in the sidebar and purge results.
Future<bool> confirmSessionDelete(BuildContext context, String path, String title) async {
  final agent = AgentScope.read(context);
  try {
    final preview = memoryMap(await agent.backend.call('sessions.deletePreview', {'path': path}));
    if (!context.mounted) return false;
    final count = preview['sideCount'];
    if (count is! num || count < 0) throw StateError('未能取得连带删除数量，请重试');
    return await confirmAction(context, title: '删除会话？', message: '「$title」会被移到回收站，需要时可以从回收站恢复。${count > 0 ? '\n同时删除 ${count.toInt()} 条侧边对话；分叉出去的对话会保留。' : ''}', confirm: '删除', danger: true);
  } catch (e) {
    if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('无法预览删除：${SessionRuntime.describeError(e)}')));
    return false;
  }
}

Future<void> showRelatedConversations(BuildContext context, List<Json> rows) => showDialog<void>(
  context: context,
  builder: (_) => _RelatedConversations(rows: rows, agent: AgentScope.read(context)),
);

class _RelatedConversations extends StatefulWidget {
  const _RelatedConversations({required this.rows, required this.agent});
  final List<Json> rows;
  final AgentController agent;
  @override
  State<_RelatedConversations> createState() => _RelatedConversationsState();
}

class _RelatedConversationsState extends State<_RelatedConversations> {
  String? _error;
  bool _busy = false;
  Future<void> _open(Json row) async {
    setState(() { _busy = true; _error = null; });
    try {
      if (row['sessionType'] == 'side') {
        await widget.agent.openSavedSideChat(row);
      } else {
        await widget.agent.openSession(row['path'] as String);
      }
      if (mounted) Navigator.pop(context);
    } catch (e) {
      if (mounted) setState(() => _error = SessionRuntime.describeError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }
  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('相关对话'),
    content: SizedBox(width: 520, child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (_error != null) Text(_error!, style: TextStyle(color: context.colors.danger)),
      if (widget.rows.isEmpty) const Text('还没有相关对话。'),
      for (final row in widget.rows) ListTile(
        enabled: !_busy,
        title: Text(row['title'] as String? ?? '未命名对话'),
        leading: TagChip(row['sessionType'] == 'side' ? '侧边' : '分叉'),
        subtitle: row['sessionType'] == 'side' ? Text(row['quote'] as String? ?? '', maxLines: 3, overflow: TextOverflow.ellipsis) : null,
        onTap: () => _open(row),
      ),
      if (_busy) const LinearProgressIndicator(),
    ]))),
    actions: [TextButton(onPressed: _busy ? null : () => Navigator.pop(context), child: const Text('关闭'))],
  );
}
