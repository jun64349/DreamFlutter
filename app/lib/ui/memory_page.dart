import 'dart:convert';
import 'dart:io';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'common.dart';

/// One long-term memory (or candidate) from the core.
class MemoryItem {
  MemoryItem.fromJson(Json json)
    : id = json['id'] as String? ?? '',
      scope = json['scope'] as String? ?? 'global',
      cwd = json['cwd'] as String?,
      kind = json['kind'] as String? ?? 'background',
      content = json['content'] as String? ?? '',
      source = json['source'] as String? ?? 'manual',
      status = json['status'] as String? ?? 'active',
      action = json['action'] as String?,
      targetId = json['targetId'] as String?,
      reason = json['reason'] as String?,
      updatedAt = (json['updatedAt'] as num?)?.toInt() ?? 0;

  final String id;
  final String scope;
  final String? cwd;
  final String kind;
  final String content;
  final String source;
  final String status;
  final String? action;
  final String? targetId;
  final String? reason;
  final int updatedAt;

  static const kinds = {'preference': '偏好', 'background': '背景', 'experience': '经验'};
  static const sources = {'user': '你明说的', 'agent': 'Agent 推断', 'manual': '手写'};
  static const statuses = {'active': '有效', 'superseded': '已被替代', 'deleted': '已删除', 'candidate': '候选', 'rejected': '已忽略', 'applied': '已应用'};

  String get kindLabel => kinds[kind] ?? kind;
  String get sourceLabel => sources[source] ?? source;
  String get scopeLabel => scope == 'workspace' ? '仅工作区' : '全局';
}

class MemoryBlock {
  MemoryBlock.fromJson(Json json)
    : key = json['key'] as String? ?? '',
      title = json['title'] as String? ?? '',
      content = json['content'] as String? ?? '',
      locked = json['locked'] == true;

  final String key;
  final String title;
  final String content;
  final bool locked;
}

/// Long-term memory in three sections: the memory library (browse, search,
/// edit, history), candidates to confirm, and the always-on blocks. The
/// switches, export and clearing sit in the left panel.
class MemoryPage extends StatefulWidget {
  const MemoryPage({super.key});

  static const blockLimit = 1500;

  @override
  State<MemoryPage> createState() => _MemoryPageState();
}

class _MemoryPageState extends State<MemoryPage> {
  List<MemoryItem> _memories = const [];
  List<MemoryItem> _candidates = const [];
  List<MemoryBlock> _blocks = const [];
  final _query = TextEditingController();
  String? _kind;
  String? _scope;
  String? _error;
  var _loading = true;
  late final AgentController _agent;

  /// 0 library, 1 candidates, 2 blocks; candidates open first when there are any.
  var _section = 0;
  var _chose = false;

  @override
  void initState() {
    super.initState();
    _agent = AgentScope.read(context);
    _agent.libraryRevision.addListener(_load);
    _load();
  }

  @override
  void dispose() {
    _agent.libraryRevision.removeListener(_load);
    _query.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final results = await Future.wait([
        _agent.backend.call('memory.list', {'status': 'active', if (_query.text.trim().isNotEmpty) 'query': _query.text.trim()}),
        _agent.backend.call('memory.list', {'status': 'candidate'}),
        _agent.backend.call('memory.blocks'),
      ]);
      List<Json> rows(Object? v) => v is List ? v.whereType<Map>().map((m) => m.cast<String, dynamic>()).toList() : const [];
      _memories = rows(results[0]).map(MemoryItem.fromJson).toList();
      _candidates = rows(results[1]).map(MemoryItem.fromJson).toList();
      _blocks = rows(results[2]).map(MemoryBlock.fromJson).toList();
      _error = null;
      if (!_chose) {
        _chose = true;
        if (_candidates.isNotEmpty) _section = 1;
      }
    } catch (e) {
      _error = SessionRuntime.describeError(e);
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _call(String method, Json params, {String? done}) async {
    try {
      await _agent.backend.call(method, params);
      if (done != null && mounted) _snack(done);
    } catch (e) {
      if (mounted) _snack('操作失败：${SessionRuntime.describeError(e)}');
    }
    await _load();
  }

  void _snack(String text) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text), behavior: SnackBarBehavior.floating, width: 520));

  List<MemoryItem> get _filtered => [
    for (final m in _memories)
      if ((_kind == null || m.kind == _kind) &&
          (_scope == null ||
              (_scope == 'global' ? m.scope == 'global' : m.scope == 'workspace' && m.cwd != null && SessionStore.samePath(m.cwd!, _agent.workspace))))
        m,
  ];

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final enabled = agent.coreSettings['memoryEnabled'] != false;
    Widget filter(String label, bool selected, VoidCallback onTap) => FilterRow(label: label, selected: selected, onTap: onTap);
    return SectionedPage(
      title: '记忆',
      items: [
        SideNavItem('记忆库', Icons.psychology_outlined, count: _memories.length),
        SideNavItem('待确认', Icons.rule, count: _candidates.length, alert: true),
        SideNavItem('常驻记忆块', Icons.push_pin_outlined, count: _blocks.length),
      ],
      selected: _section,
      onSelect: (i) => setState(() => _section = i),
      panel: [
        if (_section == 0) ...[
          const PanelLabel('类别'),
          filter('全部', _kind == null, () => setState(() => _kind = null)),
          for (final e in MemoryItem.kinds.entries) filter(e.value, _kind == e.key, () => setState(() => _kind = e.key)),
          const PanelLabel('范围'),
          filter('全部', _scope == null, () => setState(() => _scope = null)),
          filter('全局', _scope == 'global', () => setState(() => _scope = 'global')),
          filter('本工作区', _scope == 'workspace', () => setState(() => _scope = 'workspace')),
        ],
        const PanelLabel('设置'),
        PanelSwitch(title: '启用长期记忆', subtitle: '关闭后不再读取和保存记忆，已有内容保留', value: enabled, onChanged: (v) => agent.updateCoreSettings({'memoryEnabled': v})),
        PanelSwitch(
          title: '自动整理候选记忆',
          subtitle: '任务结束后找出值得记住的内容，放进「待确认」',
          value: agent.coreSettings['memoryAutoExtract'] != false,
          onChanged: enabled ? (v) => agent.updateCoreSettings({'memoryAutoExtract': v}) : null,
        ),
        const SizedBox(height: AppTokens.gap),
        Align(
          alignment: Alignment.centerLeft,
          child: PopupMenuButton<String>(
            tooltip: '导出和清空',
            onSelected: _menu,
            position: PopupMenuPosition.under,
            itemBuilder: (_) => const [
              PopupMenuItem(
                value: 'export',
                child: ListTile(dense: true, leading: Icon(Icons.download_outlined), title: Text('导出为 JSON')),
              ),
              PopupMenuItem(
                value: 'clear_workspace',
                child: ListTile(dense: true, leading: Icon(Icons.folder_delete_outlined), title: Text('清空本工作区的记忆')),
              ),
              PopupMenuItem(
                value: 'clear_all',
                child: ListTile(dense: true, leading: Icon(Icons.delete_sweep_outlined), title: Text('清空全部记忆')),
              ),
            ],
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.more_horiz, size: 16, color: colors.muted),
                  const SizedBox(width: 6),
                  Text('导出和清空', style: context.text.bodySmall?.copyWith(color: colors.muted)),
                ],
              ),
            ),
          ),
        ),
      ],
      child: _error != null
          ? Center(
              child: Text(_error!, style: TextStyle(color: colors.danger)),
            )
          : _loading
          ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
          : PageBody(
              children: [
                if (!enabled)
                  Padding(
                    padding: const EdgeInsets.only(top: AppTokens.pad),
                    child: OutlinedCard(highlight: colors.warning, child: const Text('长期记忆已关闭：新任务不会带上记忆，Agent 也不会保存新的记忆。')),
                  ),
                ...switch (_section) {
                  1 => _candidatesSection(),
                  2 => _blocksSection(),
                  _ => _librarySection(),
                },
              ],
            ),
    );
  }

  List<Widget> _librarySection() {
    final filtered = _filtered;
    final byKind = <String, List<MemoryItem>>{};
    for (final m in filtered) {
      byKind.putIfAbsent(m.kind, () => []).add(m);
    }
    return [
      ContentHeader(
        title: '记忆库',
        description: '每次任务开始时，常驻记忆块和相关的记忆会打成快照交给 Agent。临时对话不读也不写记忆。',
        actions: [FilledButton.icon(onPressed: () => _edit(null), icon: const Icon(Icons.add, size: 18), label: const Text('添加记忆'))],
      ),
      TextField(
        controller: _query,
        decoration: const InputDecoration(prefixIcon: Icon(Icons.search, size: 18), hintText: '搜索记忆，回车查找'),
        onSubmitted: (_) => _load(),
        onChanged: (v) {
          if (v.isEmpty) _load();
        },
      ),
      const SizedBox(height: AppTokens.gap),
      if (filtered.isEmpty)
        _memories.isEmpty && _query.text.isEmpty
            ? EmptyState(
                title: '还没有记忆',
                message: '对 Agent 说「记住……」，或者点「添加记忆」。\n开启自动整理后，任务结束时也会提出候选记忆。',
                action: OutlinedButton.icon(onPressed: () => _edit(null), icon: const Icon(Icons.add, size: 16), label: const Text('添加一条')),
              )
            : const EmptyNote('没有符合条件的记忆。')
      else
        for (final kind in [...MemoryItem.kinds.keys, ...byKind.keys.where((k) => !MemoryItem.kinds.containsKey(k))])
          if (byKind[kind] != null) ...[
            PanelLabel(MemoryItem.kinds[kind] ?? kind, count: byKind[kind]!.length),
            for (final m in byKind[kind]!) _MemoryTile(memory: m, onEdit: () => _edit(m), onHistory: () => _history(m), onDelete: () => _delete(m)),
          ],
    ];
  }

  List<Widget> _candidatesSection() => [
    const ContentHeader(title: '待确认', description: '辅助模型从对话里找出的、值得长期记住的内容。你保存后才生效，忽略的不会再提。'),
    if (_candidates.isEmpty) const EmptyState(title: '没有待确认的记忆', message: '任务结束后，新的候选记忆会出现在这里。'),
    for (final c in _candidates) _CandidateCard(candidate: c, memories: _memories, blocks: _blocks, onAction: _call),
  ];

  List<Widget> _blocksSection() => [
    const ContentHeader(title: '常驻记忆块', description: '每次任务都会带上，每块最多 ${MemoryPage.blockLimit} 字。锁定的块 Agent 只能提修改建议，由你确认。'),
    for (final b in _blocks) _BlockEditor(key: ValueKey('block-${b.key}-${b.content.hashCode}-${b.locked}'), block: b, onSave: _call),
  ];

  Future<void> _edit(MemoryItem? existing) async {
    final result = await showDialog<Json>(
      context: context,
      builder: (_) => _MemoryDialog(existing: existing, workspace: _agent.workspace),
    );
    if (result == null) return;
    if (existing == null) {
      await _call('memory.add', result, done: '已保存');
    } else {
      await _call('memory.edit', {'id': existing.id, ...result}, done: '已更新，旧版本保留在历史里');
    }
  }

  Future<void> _delete(MemoryItem memory) async {
    if (!await confirmAction(context, title: '删除这条记忆？', message: memory.content, confirm: '删除', danger: true)) return;
    await _call('memory.remove', {'id': memory.id});
  }

  Future<void> _history(MemoryItem memory) async {
    try {
      final rows = await _agent.backend.call('memory.history', {'id': memory.id});
      final versions = (rows as List).whereType<Map>().map((m) => MemoryItem.fromJson(m.cast<String, dynamic>())).toList();
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('历史版本'),
          content: SizedBox(
            width: 560,
            child: ListView(
              shrinkWrap: true,
              children: [
                for (final (i, v) in versions.indexed)
                  ListTile(
                    dense: true,
                    title: Text(v.content),
                    subtitle: Text('${i == 0 ? '当前' : MemoryItem.statuses[v.status] ?? v.status} · ${v.sourceLabel} · ${formatDate(v.updatedAt)}'),
                  ),
              ],
            ),
          ),
          actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('关闭'))],
        ),
      );
    } catch (e) {
      _snack('读取历史失败：${SessionRuntime.describeError(e)}');
    }
  }

  Future<void> _menu(String action) async {
    switch (action) {
      case 'export':
        final location = await getSaveLocation(
          suggestedName: 'dreamflutter-memory.json',
          acceptedTypeGroups: const [
            XTypeGroup(label: 'JSON', extensions: ['json']),
          ],
        );
        if (location == null) return;
        try {
          final data = await _agent.backend.call('memory.export');
          await File(location.path).writeAsString(const JsonEncoder.withIndent('  ').convert(data));
          _snack('已导出到 ${location.path}');
        } catch (e) {
          _snack('导出失败：${SessionRuntime.describeError(e)}');
        }
      case 'clear_workspace':
        if (await confirmAction(context, title: '清空本工作区的记忆？', message: '只属于「${_agent.workspace}」的记忆会被删除，全局记忆和常驻记忆块不受影响。', confirm: '清空', danger: true)) {
          await _call('memory.clear', {'scope': 'workspace', 'cwd': _agent.workspace}, done: '已清空本工作区的记忆');
        }
      case 'clear_all':
        if (await confirmAction(context, title: '清空全部记忆？', message: '所有记忆、候选记忆和常驻记忆块的内容都会被清空。建议先导出备份。', confirm: '全部清空', danger: true)) {
          await _call('memory.clear', {'scope': 'all'}, done: '已清空全部记忆');
        }
    }
  }
}

class _MemoryTile extends StatelessWidget {
  const _MemoryTile({required this.memory, required this.onEdit, required this.onHistory, required this.onDelete});

  final MemoryItem memory;
  final VoidCallback onEdit;
  final VoidCallback onHistory;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final muted = context.text.bodySmall?.copyWith(color: context.colors.muted);
    return OutlinedCard(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SelectableText(memory.content),
                const SizedBox(height: 6),
                Wrap(
                  spacing: 6,
                  runSpacing: 4,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    TagChip(memory.kindLabel, color: Theme.of(context).colorScheme.primary),
                    TagChip(memory.scopeLabel),
                    Text('${memory.sourceLabel} · ${formatDate(memory.updatedAt)}', style: muted),
                  ],
                ),
              ],
            ),
          ),
          PopupMenuButton<String>(
            tooltip: '操作',
            icon: const Icon(Icons.more_horiz, size: 18),
            onSelected: (v) => switch (v) {
              'edit' => onEdit(),
              'history' => onHistory(),
              _ => onDelete(),
            },
            itemBuilder: (_) => const [
              PopupMenuItem(
                value: 'edit',
                child: ListTile(dense: true, leading: Icon(Icons.edit_outlined), title: Text('编辑')),
              ),
              PopupMenuItem(
                value: 'history',
                child: ListTile(dense: true, leading: Icon(Icons.history), title: Text('历史版本')),
              ),
              PopupMenuItem(
                value: 'delete',
                child: ListTile(dense: true, leading: Icon(Icons.delete_outline), title: Text('删除')),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// A memory candidate: what accepting it would do, with save / edit / ignore.
class _CandidateCard extends StatelessWidget {
  const _CandidateCard({required this.candidate, required this.memories, required this.blocks, required this.onAction});

  final MemoryItem candidate;
  final List<MemoryItem> memories;
  final List<MemoryBlock> blocks;
  final Future<void> Function(String method, Json params, {String? done}) onAction;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final target = candidate.targetId;
    final block = target != null && target.startsWith('block:') ? blocks.where((b) => 'block:${b.key}' == target).firstOrNull : null;
    final existing = target == null ? null : memories.where((m) => m.id == target).firstOrNull;
    final (label, color) = switch (candidate.action) {
      _ when block != null => ('修改记忆块「${block.title}」', colors.warning),
      'update' => ('更新已有记忆', colors.warning),
      'delete' => ('删除已有记忆', colors.danger),
      _ => ('新记忆', Theme.of(context).colorScheme.primary),
    };
    final muted = context.text.bodySmall?.copyWith(color: colors.muted);
    return OutlinedCard(
      highlight: color,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              TagChip(label, color: color),
              TagChip(candidate.kindLabel),
              TagChip(candidate.scopeLabel),
              Text(formatDate(candidate.updatedAt), style: muted),
            ],
          ),
          const SizedBox(height: AppTokens.gap),
          if (existing != null || block != null) ...[
            Text(
              '原来：${block?.content ?? existing!.content}',
              style: muted?.copyWith(decoration: candidate.action == 'delete' ? TextDecoration.lineThrough : null),
            ),
            const SizedBox(height: 4),
          ],
          if (candidate.action != 'delete') SelectableText(block != null ? '改为：${candidate.content}' : candidate.content),
          if ((candidate.reason ?? '').isNotEmpty) ...[const SizedBox(height: 4), Text('理由：${candidate.reason}', style: muted)],
          const SizedBox(height: AppTokens.gap),
          Row(
            children: [
              FilledButton(
                onPressed: () => onAction('memory.accept', {'id': candidate.id}, done: candidate.action == 'delete' ? '已删除' : '已保存'),
                child: Text(candidate.action == 'delete' ? '确认删除' : '保存'),
              ),
              const SizedBox(width: AppTokens.gap),
              if (candidate.action != 'delete')
                OutlinedButton(
                  onPressed: () async {
                    final text = await _editText(context, candidate.content);
                    if (text != null) await onAction('memory.accept', {'id': candidate.id, 'content': text}, done: '已保存');
                  },
                  child: const Text('修改后保存'),
                ),
              const SizedBox(width: AppTokens.gap),
              TextButton(onPressed: () => onAction('memory.reject', {'id': candidate.id}), child: const Text('忽略')),
            ],
          ),
        ],
      ),
    );
  }

  static Future<String?> _editText(BuildContext context, String initial) async {
    final values = await showFieldsDialog(
      context,
      title: '修改后保存',
      confirm: '保存',
      fields: [FieldSpec('记忆内容', initial: initial, minLines: 3, maxLines: 6, required: true)],
    );
    return values?.first;
  }
}

/// One always-on memory block: editable text with a lock (locked blocks can
/// only be changed by the agent through a proposal).
class _BlockEditor extends StatefulWidget {
  const _BlockEditor({super.key, required this.block, required this.onSave});

  final MemoryBlock block;
  final Future<void> Function(String method, Json params, {String? done}) onSave;

  @override
  State<_BlockEditor> createState() => _BlockEditorState();
}

class _BlockEditorState extends State<_BlockEditor> {
  late final _controller = TextEditingController(text: widget.block.content);
  var _dirty = false;

  static const _hints = {'about_me': '例如：我叫小周，在杭州做产品经理，平时用 Windows。', 'preferences': '例如：回答用中文，先给结论；代码注释用英文。', 'agreements': '例如：这个月在准备论文答辩，周报每周五交。'};

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final block = widget.block;
    return OutlinedCard(
      padding: const EdgeInsets.fromLTRB(AppTokens.padLg, AppTokens.gap, AppTokens.pad, AppTokens.pad),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Text(block.title, style: context.serif(context.text.titleMedium).copyWith(fontWeight: FontWeight.w600)),
              const SizedBox(width: AppTokens.gap),
              if (block.locked) TagChip('已锁定', color: context.colors.warning),
              const Spacer(),
              IconButton(
                tooltip: block.locked ? '解锁：允许 Agent 直接修改' : '锁定：Agent 只能提修改建议，由你确认',
                icon: Icon(block.locked ? Icons.lock : Icons.lock_open_outlined, size: 18, color: block.locked ? context.colors.warning : null),
                onPressed: () => widget.onSave('memory.setBlock', {'key': block.key, 'locked': !block.locked}),
              ),
              FilledButton.tonal(
                onPressed: _dirty ? () => widget.onSave('memory.setBlock', {'key': block.key, 'content': _controller.text}, done: '「${block.title}」已保存') : null,
                child: const Text('保存'),
              ),
            ],
          ),
          const SizedBox(height: 4),
          TextField(
            controller: _controller,
            minLines: 3,
            maxLines: 8,
            maxLength: MemoryPage.blockLimit,
            decoration: InputDecoration(hintText: _hints[block.key]),
            onChanged: (v) => setState(() => _dirty = v != block.content),
          ),
        ],
      ),
    );
  }
}

/// Add or edit a memory: content, kind and scope.
class _MemoryDialog extends StatefulWidget {
  const _MemoryDialog({required this.existing, required this.workspace});

  final MemoryItem? existing;
  final String workspace;

  @override
  State<_MemoryDialog> createState() => _MemoryDialogState();
}

class _MemoryDialogState extends State<_MemoryDialog> {
  late final _content = TextEditingController(text: widget.existing?.content ?? '');
  late var _kind = widget.existing?.kind ?? 'preference';
  late var _scope = widget.existing?.scope ?? 'global';

  @override
  void dispose() {
    _content.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.existing == null ? '添加记忆' : '编辑记忆'),
      content: SizedBox(
        width: 520,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              controller: _content,
              autofocus: true,
              minLines: 3,
              maxLines: 8,
              decoration: const InputDecoration(hintText: '一条独立、完整的事实、偏好或经验'),
              onChanged: (_) => setState(() {}),
            ),
            const SizedBox(height: AppTokens.pad),
            Text('类别', style: context.text.labelMedium),
            const SizedBox(height: 4),
            SegmentedButton<String>(
              segments: [for (final e in MemoryItem.kinds.entries) ButtonSegment(value: e.key, label: Text(e.value))],
              selected: {_kind},
              onSelectionChanged: (s) => setState(() => _kind = s.first),
            ),
            const SizedBox(height: AppTokens.pad),
            Text('适用范围', style: context.text.labelMedium),
            const SizedBox(height: 4),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'global', label: Text('全局')),
                ButtonSegment(value: 'workspace', label: Text('只在当前工作区')),
              ],
              selected: {_scope},
              onSelectionChanged: (s) => setState(() => _scope = s.first),
            ),
            if (_scope == 'workspace') ...[
              const SizedBox(height: 4),
              Text(widget.existing?.cwd ?? widget.workspace, style: context.text.bodySmall?.copyWith(color: context.colors.muted)),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(
          onPressed: _content.text.trim().isEmpty
              ? null
              : () => Navigator.pop(context, <String, dynamic>{
                  'content': _content.text.trim(),
                  'kind': _kind,
                  'scope': _scope,
                  'cwd': _scope == 'workspace' ? (widget.existing?.cwd ?? widget.workspace) : null,
                }),
          child: const Text('保存'),
        ),
      ],
    );
  }
}
