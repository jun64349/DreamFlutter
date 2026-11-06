import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../state/memory_ui.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'common.dart';
import 'session_dialogs.dart';

Future<void> showMemoryDetails(BuildContext context, String id) => showDialog<void>(context: context, builder: (_) => MemoryDetailsDialog(id: id, agent: AgentScope.read(context)));

class MemoryDetailsDialog extends StatefulWidget {
  const MemoryDetailsDialog({super.key, required this.id, required this.agent});
  final String id;
  final AgentController agent;
  @override
  State<MemoryDetailsDialog> createState() => _MemoryDetailsDialogState();
}

class _MemoryDetailsDialogState extends State<MemoryDetailsDialog> {
  final _content = TextEditingController();
  Json? _detail;
  String? _error;
  String? _receipt;
  bool _busy = false;
  String _scope = 'global';
  int _level = 2;
  String _retention = 'normal';
  bool _locked = false;
  int? _validUntil;

  @override
  void initState() { super.initState(); _load(); }
  @override
  void dispose() { _content.dispose(); super.dispose(); }

  Future<void> _load() async {
    try {
      final detail = memoryMap(await widget.agent.backend.call('memory.item', {'id': widget.id}));
      final item = memoryMap(detail['item']);
      if (item.isEmpty) throw StateError('没有这条记忆');
      if (!mounted) return;
      setState(() {
        _detail = detail;
        _content.text = item['content'] as String? ?? '';
        _scope = item['scope'] as String? ?? 'global';
        _level = (item['level'] as num?)?.toInt() ?? 2;
        _locked = item['retention'] == 'locked';
        _retention = item['retention'] == 'long' ? 'long' : 'normal';
        _validUntil = (item['validUntil'] as num?)?.toInt();
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = SessionRuntime.describeError(e));
    }
  }

  Future<void> _change(String method, Json params, String verb) async {
    if (_busy) return;
    setState(() { _busy = true; _error = null; _receipt = null; });
    try {
      final result = memoryMap(await widget.agent.backend.call(method, params));
      final rejected = memoryRows(result['rejected']);
      if (rejected.isNotEmpty) throw StateError(rejected.map((r) => r['reason']).join('\n'));
      if (memoryRows(result['applied']).isEmpty) throw StateError('没有改动生效，请重新查看当前内容');
      if (!mounted) return;
      setState(() => _receipt = memoryReceipt(result, verb: verb));
      widget.agent.libraryRevision.value++;
      await _load();
    } catch (e) {
      if (mounted) setState(() => _error = SessionRuntime.describeError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _save() async {
    final item = memoryMap(_detail?['item']);
    if (_scope == 'global' && item['scope'] != 'global') {
      if (!await confirmAction(context, title: '提升为全局？', message: '所有工作区都能看到这条记忆。', confirm: '同意')) return;
    }
    await _change('memory.update', {
      'id': widget.id, 'version': item['version'], 'content': _content.text.trim(), 'scope': _scope, 'level': _level,
      if (_scope == 'workspace') 'cwd': item['workspacePath'] ?? widget.agent.workspace,
      if (_scope == 'group') 'groupId': item['groupId'],
      'retention': _locked ? 'locked' : _retention, 'validUntil': _validUntil,
    }, '已保存');
  }

  Future<void> _purge() async {
    if (!await confirmAction(context, title: '彻底删除这条记忆？', message: '${_content.text}\n\n删除后不可恢复。\n已发给模型服务商的内容无法收回。\n旧备份里仍有这条记忆。', confirm: '彻底删除', danger: true)) return;
    setState(() { _busy = true; _error = null; });
    try {
      final result = memoryMap(await widget.agent.backend.call('memory.purge', {'id': widget.id, 'confirm': true}));
      if (!mounted) return;
      widget.agent.libraryRevision.value++;
      await showDialog<void>(context: context, builder: (_) => _PurgeResult(result: result, agent: widget.agent));
      if (mounted) Navigator.pop(context);
    } catch (e) {
      if (mounted) setState(() => _error = SessionRuntime.describeError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final item = memoryMap(_detail?['item']);
    return AlertDialog(
      title: const Text('记忆详情'),
      content: SizedBox(width: 560, child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (_error != null) Text(_error!, style: TextStyle(color: context.colors.danger)),
        if (_receipt != null) Semantics(liveRegion: true, child: Text(_receipt!, style: TextStyle(color: context.colors.success))),
        if (_detail == null && _error == null) const Center(child: CircularProgressIndicator()),
        if (_detail == null && _error != null) TextButton(onPressed: _load, child: const Text('重试')),
        if (_detail != null) ...[
          TextField(controller: _content, minLines: 3, maxLines: 8, enabled: !_busy, decoration: const InputDecoration(labelText: '正文'), onChanged: (_) => setState(() {})),
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(key: ValueKey('scope-$_scope'), initialValue: _scope, decoration: const InputDecoration(labelText: '范围'), items: [
            for (final s in ['global', 'workspace', 'butterfly', if (_scope == 'group') 'group']) DropdownMenuItem(value: s, child: Text(memoryScope({'scope': s}))),
          ], onChanged: _busy ? null : (s) => setState(() => _scope = s!)),
          const SizedBox(height: 12),
          DropdownButtonFormField<int>(key: ValueKey('level-$_level'), initialValue: _level, decoration: const InputDecoration(labelText: '层级'), items: [for (final l in [1, 2, 3]) DropdownMenuItem(value: l, child: Text(memoryLevel(l)))], onChanged: _busy ? null : (l) => setState(() => _level = l!)),
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(key: ValueKey('retention-$_retention'), initialValue: _retention, decoration: const InputDecoration(labelText: '保留期限'), items: const [DropdownMenuItem(value: 'normal', child: Text('普通保留')), DropdownMenuItem(value: 'long', child: Text('长期保留'))], onChanged: _busy || _locked ? null : (v) => setState(() => _retention = v!)),
          SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('锁定'), subtitle: const Text('后台不能自动修改或遗忘'), value: _locked, onChanged: _busy ? null : (v) => setState(() => _locked = v)),
          Row(children: [Expanded(child: Text(_validUntil == null ? '未设置有效期' : '有效期至 ${formatDate(_validUntil!)}')), TextButton(onPressed: _busy ? null : () async {
            final now = DateTime.now();
            final date = await showDatePicker(context: context, initialDate: _validUntil == null ? now : DateTime.fromMillisecondsSinceEpoch(_validUntil!), firstDate: DateTime(1970), lastDate: DateTime(2200));
            if (date != null && mounted) setState(() => _validUntil = date.millisecondsSinceEpoch);
          }, child: const Text('设置有效期')), if (_validUntil != null) IconButton(tooltip: '清除有效期', onPressed: _busy ? null : () => setState(() => _validUntil = null), icon: const Icon(Icons.clear, size: 18))]),
          const Divider(),
          Text('历史版本', style: context.text.titleSmall),
          if (memoryRows(_detail!['versions']).isEmpty) const Text('没有历史版本。'),
          for (final version in memoryRows(_detail!['versions'])) ListTile(contentPadding: EdgeInsets.zero, title: Text('第 ${version['version']} 版 · ${formatDate((version['at'] as num?)?.toInt() ?? 0)}'), subtitle: Text(memoryMap(version['item'])['content'] as String? ?? ''), trailing: TextButton(onPressed: _busy || version['version'] == item['version'] ? null : () => _change('memory.restore', {'id': widget.id, 'version': version['version']}, '已恢复'), child: const Text('恢复此版本'))),
          const Divider(),
          Text('来源', style: context.text.titleSmall),
          if (memoryRows(_detail!['sources']).isEmpty) const Text('没有记录来源，不补造来源。'),
          for (final source in memoryRows(_detail!['sources'])) ListTile(contentPadding: EdgeInsets.zero, title: Text(source['excerpt'] as String? ?? '没有摘录'), subtitle: Text(source['ref'] as String? ?? source['kind'] as String? ?? ''), trailing: source['kind'] == 'session' && source['ref'] is String ? TextButton(onPressed: _busy ? null : () async {
            try { await widget.agent.openSession(source['ref'] as String); if (context.mounted) { widget.agent.showSection(AppSection.chat); Navigator.pop(context); } }
            catch (e) { if (mounted) setState(() => _error = SessionRuntime.describeError(e)); }
          }, child: const Text('打开会话')) : null),
        ],
        if (_busy) const LinearProgressIndicator(),
      ]))),
      actions: [
        TextButton(onPressed: _busy ? null : () => Navigator.pop(context), child: const Text('关闭')),
        FilledButton(onPressed: _busy || _detail == null || _content.text.trim().isEmpty ? null : _save, child: const Text('保存修改')),
        TextButton(onPressed: _busy || _detail == null ? null : () async {
          if (await confirmAction(context, title: '遗忘这条记忆？', message: '退出日常使用，历史版本保留，可以恢复。', confirm: '遗忘')) {
            await _change('memory.setStatus', {'id': widget.id, 'version': item['version'], 'status': 'forgotten'}, '已遗忘');
          }
        }, child: const Text('遗忘')),
        PopupMenuButton<String>(enabled: !_busy && _detail != null, tooltip: '更多', onSelected: (_) => _purge(), itemBuilder: (_) => [PopupMenuItem(value: 'purge', child: Text('彻底删除', style: TextStyle(color: context.colors.danger)))], child: const Padding(padding: EdgeInsets.all(12), child: Text('更多 ▾'))),
      ],
    );
  }
}

class _PurgeResult extends StatefulWidget {
  const _PurgeResult({required this.result, required this.agent});
  final Json result;
  final AgentController agent;
  @override
  State<_PurgeResult> createState() => _PurgeResultState();
}

class _PurgeResultState extends State<_PurgeResult> {
  final _deleted = <String>{};
  String? _busy;
  String? _error;
  @override
  Widget build(BuildContext context) {
    final sources = (widget.result['sessions'] as List? ?? const []).map((v) => v is String ? <String, dynamic>{'path': v, 'title': v} : memoryMap(v)).toList();
    return AlertDialog(title: const Text('记忆已彻底删除'), content: SizedBox(width: 540, child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const Text('原会话里的内容仍可能存在。删除来源会话是另一个操作。'),
      for (final note in (widget.result['notes'] as List? ?? const [])) Text('$note'),
      if (_error != null) Text(_error!, style: TextStyle(color: context.colors.danger)),
      if (sources.isEmpty) const Text('没有记录来源会话。'),
      for (final row in sources) ListTile(contentPadding: EdgeInsets.zero, title: Text(row['title'] as String? ?? row['path'] as String? ?? '来源会话'), subtitle: Text(_deleted.contains(row['path']) ? '已删除' : row['exists'] == false ? '来源会话已不存在' : row['exists'] == true ? '来源会话仍存在' : '来源是否存在尚未确认'), trailing: TextButton(onPressed: _busy != null || _deleted.contains(row['path']) || row['exists'] != true ? null : () async {
        final path = row['path'] as String;
        if (!await confirmSessionDelete(context, path, row['title'] as String? ?? path)) return;
        if (!mounted) return;
        setState(() { _busy = path; _error = null; });
        final ok = await widget.agent.deleteSession(path);
        if (mounted) setState(() { _busy = null; if (ok) { _deleted.add(path); } else { _error = '删除会话失败，未标记为已删除。'; } });
      }, child: const Text('删除这个会话'))),
    ]))), actions: [TextButton(onPressed: _busy == null ? () => Navigator.pop(context) : null, child: const Text('关闭'))]);
  }
}

/// Small save editor shared by the unsaved-reply prompt and manual addition.
Future<Json?> showUnsavedMemoryEditor(BuildContext context, Json claim) => showDialog<Json>(context: context, builder: (_) => _UnsavedEditor(claim: claim, agent: AgentScope.read(context)));

class _UnsavedEditor extends StatefulWidget {
  const _UnsavedEditor({required this.claim, required this.agent});
  final Json claim;
  final AgentController agent;
  @override
  State<_UnsavedEditor> createState() => _UnsavedEditorState();
}

class _UnsavedEditorState extends State<_UnsavedEditor> {
  late final _content = TextEditingController(text: widget.claim['suggestion'] as String? ?? '');
  String _scope = 'workspace';
  String? _error;
  bool _busy = false;
  @override
  void dispose() { _content.dispose(); super.dispose(); }
  Future<void> _save() async {
    setState(() { _busy = true; _error = null; });
    try {
      final result = memoryMap(await widget.agent.backend.call('memory.save', {'content': _content.text.trim(), 'scope': _scope, if (_scope == 'workspace') 'cwd': widget.agent.workspace, 'unsavedRef': {'sessionId': widget.claim['sessionId'], 'runId': widget.claim['runId']}}));
      if (memoryRows(result['applied']).isEmpty) throw StateError('记忆没有保存成功');
      widget.agent.memoryUi.setClaim(widget.claim['sessionId'] as String, {...widget.claim, 'cleared': true});
      widget.agent.libraryRevision.value++;
      if (mounted) Navigator.pop(context, result);
    } catch (e) { if (mounted) setState(() => _error = SessionRuntime.describeError(e)); }
    finally { if (mounted) setState(() => _busy = false); }
  }
  @override
  Widget build(BuildContext context) => AlertDialog(title: const Text('保存记忆'), content: SizedBox(width: 480, child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, children: [
    if (_error != null) Text(_error!, style: TextStyle(color: context.colors.danger)),
    TextField(controller: _content, minLines: 3, maxLines: 8, enabled: !_busy, decoration: const InputDecoration(labelText: '建议正文'), onChanged: (_) => setState(() {})),
    const SizedBox(height: 12),
    DropdownButtonFormField<String>(initialValue: _scope, decoration: const InputDecoration(labelText: '范围'), items: const [DropdownMenuItem(value: 'workspace', child: Text('当前工作区')), DropdownMenuItem(value: 'global', child: Text('全局'))], onChanged: _busy ? null : (v) => setState(() => _scope = v!)),
    if (_busy) const LinearProgressIndicator(),
  ]))), actions: [TextButton(onPressed: _busy ? null : () => Navigator.pop(context), child: const Text('取消')), FilledButton(onPressed: _busy || _content.text.trim().isEmpty ? null : _save, child: const Text('保存'))]);
}
