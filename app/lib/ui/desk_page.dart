import 'dart:async';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart' show SessionStore;

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'artifact_widgets.dart';
import 'card_view.dart';
import 'common.dart';
import 'sidebar.dart' show WorkspaceSwitcher;
import 'task_widgets.dart';

/// The desk of the current workspace (user's draft §5): materials, notes,
/// tasks and artifacts side by side. Notes open in an editor where they can
/// be handed to the agent with chosen materials.
class DeskPage extends StatefulWidget {
  const DeskPage({super.key});

  @override
  State<DeskPage> createState() => _DeskPageState();
}

class _DeskPageState extends State<DeskPage> {
  late final AgentController _agent;
  List<NoteInfo> _notes = const [];
  List<MaterialInfo> _materials = const [];
  List<TaskInfo> _tasks = const [];
  List<ArtifactInfo> _artifacts = const [];
  List<CardInfo> _cards = const [];
  String? _error;
  var _loading = true;
  String _loadedFor = '';

  /// The note open in the editor (null = the four-column overview).
  NoteInfo? _open;

  @override
  void initState() {
    super.initState();
    _agent = AgentScope.read(context);
    _agent.workRevision.addListener(_load);
    _load();
  }

  @override
  void dispose() {
    _agent.workRevision.removeListener(_load);
    super.dispose();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Workspace switched while the desk is open.
    if (_loadedFor.isNotEmpty && !SessionStore.samePath(AgentScope.of(context).workspace, _loadedFor)) {
      _open = null;
      _load();
    }
  }

  Future<void> _load() async {
    final cwd = _agent.workspace;
    try {
      final desk = asJsonMap(await _agent.backend.call('desk.get', {'cwd': cwd}));
      _notes = jsonRows(desk['notes']).map(NoteInfo.fromJson).toList();
      _materials = jsonRows(desk['materials']).map(MaterialInfo.fromJson).toList();
      _tasks = jsonRows(desk['tasks']).map(TaskInfo.fromJson).toList();
      _artifacts = jsonRows(desk['artifacts']).map(ArtifactInfo.fromJson).toList();
      _cards = jsonRows(await _agent.backend.call('cards.list', {'cwd': cwd, 'resident': true})).map(CardInfo.fromJson).toList();
      _error = null;
      _loadedFor = cwd;
    } catch (e) {
      _error = SessionRuntime.describeError(e);
    }
    if (mounted) setState(() => _loading = false);
  }

  void _snack(String text) =>
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text), behavior: SnackBarBehavior.floating, width: 520));

  Future<void> _newNote() async {
    try {
      final note = NoteInfo.fromJson(asJsonMap(await _agent.backend.call('notes.save', {'cwd': _agent.workspace, 'content': ''})));
      setState(() => _open = note);
    } catch (e) {
      _snack('新建写笺失败：${SessionRuntime.describeError(e)}');
    }
  }

  Future<void> _addMaterial(String kind) async {
    final cwd = _agent.workspace;
    try {
      switch (kind) {
        case 'file':
          final files = await openFiles(initialDirectory: cwd, confirmButtonText: '添加到书桌');
          for (final f in files) {
            await _agent.backend.call('materials.add', {'cwd': cwd, 'kind': 'file', 'path': f.path});
          }
        case 'folder':
          final folder = await getDirectoryPath(initialDirectory: cwd, confirmButtonText: '添加到书桌');
          if (folder != null) await _agent.backend.call('materials.add', {'cwd': cwd, 'kind': 'folder', 'path': folder});
        case 'text':
          if (!mounted) return;
          final values = await showFieldsDialog(
            context,
            title: '粘贴文本资料',
            width: 640,
            confirm: '添加',
            fields: const [FieldSpec('标题（可不填）'), FieldSpec('内容', minLines: 8, maxLines: 16, required: true)],
          );
          if (values != null) await _agent.backend.call('materials.add', {'cwd': cwd, 'kind': 'text', 'title': values[0], 'content': values[1]});
      }
    } catch (e) {
      _snack('添加资料失败：${SessionRuntime.describeError(e)}');
    }
    await _load();
  }

  /// Imports a shared card (`.card.html`, `.card.zip` or a package folder) onto this desk.
  Future<void> _importCard(String kind) async {
    try {
      String? path;
      if (kind == 'folder') {
        path = await getDirectoryPath(confirmButtonText: '导入这张卡片');
      } else {
        path = (await openFile(acceptedTypeGroups: const [XTypeGroup(label: 'Showcard 卡片', extensions: ['html', 'htm', 'zip'])]))?.path;
      }
      if (path == null) return;
      final card = CardInfo.fromJson(asJsonMap(await _agent.backend.call('cards.import', {'path': path, 'cwd': _agent.workspace})));
      _snack('已导入「${card.title}」。它第一次要用网络、文件或程序时会先问你。');
    } catch (e) {
      _snack('导入失败：${SessionRuntime.describeError(e)}');
    }
    await _load();
  }

  Future<void> _removeMaterial(MaterialInfo m) async {
    await _agent.backend.call('materials.remove', {'id': m.id});
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final open = _open;
    if (open != null) {
      return NoteEditor(
        key: ValueKey(open.id),
        note: open,
        materials: _materials,
        onClose: () {
          setState(() => _open = null);
          _load();
        },
      );
    }
    return PageFrame(
      title: '书桌',
      subtitle: '每个工作区一张书桌：放资料、写笺，交给 Agent 处理，产物自动回到这里。',
      actions: [SizedBox(width: 260, child: WorkspaceSwitcher(key: ValueKey(agent.workspace)))],
      child: _error != null
          ? Center(child: Text(_error!, style: TextStyle(color: context.colors.danger)))
          : _loading
          ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
          : Padding(
              padding: const EdgeInsets.all(AppTokens.padLg),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _Column(
                    title: '资料',
                    count: _materials.length,
                    action: PopupMenuButton<String>(
                      tooltip: '添加资料',
                      icon: const Icon(Icons.add, size: 18),
                      onSelected: _addMaterial,
                      itemBuilder: (_) => const [
                        PopupMenuItem(value: 'file', child: ListTile(dense: true, leading: Icon(Icons.description_outlined), title: Text('添加文件'))),
                        PopupMenuItem(value: 'folder', child: ListTile(dense: true, leading: Icon(Icons.folder_outlined), title: Text('添加文件夹'))),
                        PopupMenuItem(value: 'text', child: ListTile(dense: true, leading: Icon(Icons.content_paste), title: Text('粘贴文本'))),
                      ],
                    ),
                    empty: '把要参考的文件、文件夹或文字放在这里，交给 Agent 时可以选择带上。',
                    children: [for (final m in _materials) MaterialTile(material: m, onRemove: () => _removeMaterial(m))],
                  ),
                  _Column(
                    title: '写笺',
                    count: _notes.length,
                    action: IconButton(tooltip: '新写笺', icon: const Icon(Icons.add, size: 18), onPressed: _newNote),
                    empty: '写下想法、要求或草稿，写好后点「交给 Agent」。',
                    children: [
                      for (final n in _notes)
                        _NoteTile(note: n, tasks: _tasks.where((t) => t.noteId == n.id).toList(), onTap: () => setState(() => _open = n)),
                    ],
                  ),
                  _Column(
                    title: '任务',
                    count: _tasks.length,
                    empty: '在这个工作区里做过的任务会出现在这里。',
                    children: [for (final t in _tasks) TaskTile(task: t, compact: true)],
                  ),
                  _Column(
                    title: '卡片',
                    count: _cards.length,
                    action: PopupMenuButton<String>(
                      tooltip: '导入卡片',
                      icon: const Icon(Icons.add, size: 18),
                      onSelected: _importCard,
                      itemBuilder: (_) => const [
                        PopupMenuItem(value: 'file', child: ListTile(dense: true, leading: Icon(Icons.style_outlined), title: Text('导入卡片文件（.card.html / .card.zip）'))),
                        PopupMenuItem(value: 'folder', child: ListTile(dense: true, leading: Icon(Icons.folder_outlined), title: Text('导入卡片文件夹'))),
                      ],
                    ),
                    empty: '对话里的卡片点「收进书桌」会复制一份放在这里，也可以导入别人分享的卡片。',
                    children: [for (final c in _cards) DeskCardTile(key: ValueKey(c.id), card: c, onChanged: _load)],
                  ),
                  _Column(
                    title: '产物',
                    count: _artifacts.length,
                    empty: 'Agent 写入或修改的文件会自动收集到这里。',
                    children: [
                      for (final a in _artifacts)
                        ArtifactTile(
                          path: a.path,
                          exists: a.exists,
                          onContinue: () {
                            final task = _tasks.where((t) => t.id == a.taskId).firstOrNull;
                            agent.continueWork(sessionFile: task?.sessionFile, cwd: agent.workspace, text: '继续修改 ${a.path}：');
                          },
                        ),
                    ],
                  ),
                ],
              ),
            ),
    );
  }
}

class _Column extends StatelessWidget {
  const _Column({required this.title, required this.count, required this.children, required this.empty, this.action});

  final String title;
  final int count;
  final List<Widget> children;
  final String empty;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Expanded(
      child: Container(
        margin: const EdgeInsets.symmetric(horizontal: 6),
        decoration: BoxDecoration(color: colors.sidebar, borderRadius: BorderRadius.circular(AppTokens.radiusLg)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(AppTokens.pad, AppTokens.gap, 4, 0),
              child: SizedBox(
                height: 36,
                child: Row(
                  children: [
                    Text(title, style: context.text.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
                    const SizedBox(width: 6),
                    Text('$count', style: context.text.bodySmall?.copyWith(color: colors.muted)),
                    const Spacer(),
                    ?action,
                  ],
                ),
              ),
            ),
            Expanded(
              child: children.isEmpty
                  ? Padding(
                      padding: const EdgeInsets.all(AppTokens.pad),
                      child: Text(empty, style: context.text.bodySmall?.copyWith(color: colors.muted)),
                    )
                  : ListView(padding: const EdgeInsets.fromLTRB(AppTokens.gap, 4, AppTokens.gap, AppTokens.gap), children: children),
            ),
          ],
        ),
      ),
    );
  }
}

class MaterialTile extends StatelessWidget {
  const MaterialTile({super.key, required this.material, this.onRemove, this.selected, this.onSelected});

  final MaterialInfo material;
  final VoidCallback? onRemove;

  /// When set, the tile is a checkbox row (choosing materials for a task).
  final bool? selected;
  final ValueChanged<bool>? onSelected;

  @override
  Widget build(BuildContext context) {
    final icon = switch (material.kind) { 'folder' => Icons.folder_outlined, 'text' => Icons.notes, _ => Icons.description_outlined };
    final subtitle = material.kind == 'text' ? (material.content ?? '').replaceAll(RegExp(r'\s+'), ' ') : material.path ?? '';
    return OutlinedCard(
      padding: const EdgeInsets.symmetric(horizontal: AppTokens.gap, vertical: 6),
      child: Row(
        children: [
          if (selected != null) Checkbox(value: selected, onChanged: (v) => onSelected?.call(v ?? false), visualDensity: VisualDensity.compact),
          Icon(icon, size: 18, color: context.colors.muted),
          const SizedBox(width: AppTokens.gap),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(material.title, maxLines: 1, overflow: TextOverflow.ellipsis),
                Text(subtitle, maxLines: 1, overflow: TextOverflow.ellipsis, style: context.text.bodySmall?.copyWith(color: context.colors.muted)),
              ],
            ),
          ),
          if (onRemove != null)
            IconButton(tooltip: '从书桌移除', icon: const Icon(Icons.close, size: 16), onPressed: onRemove, visualDensity: VisualDensity.compact),
        ],
      ),
    );
  }
}

class _NoteTile extends StatelessWidget {
  const _NoteTile({required this.note, required this.tasks, required this.onTap});

  final NoteInfo note;
  final List<TaskInfo> tasks;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final latest = tasks.firstOrNull;
    final preview = note.content.replaceAll(RegExp(r'^#+\s*.*\n?'), '').replaceAll(RegExp(r'\s+'), ' ').trim();
    return InkWell(
      borderRadius: BorderRadius.circular(AppTokens.radius),
      onTap: onTap,
      child: OutlinedCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(note.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: context.text.titleSmall),
            if (preview.isNotEmpty) ...[
              const SizedBox(height: 2),
              Text(preview, maxLines: 3, overflow: TextOverflow.ellipsis, style: context.text.bodySmall?.copyWith(color: context.colors.muted)),
            ],
            const SizedBox(height: 6),
            Row(
              children: [
                Text(formatDate(note.updatedAt?.millisecondsSinceEpoch), style: context.text.labelSmall?.copyWith(color: context.colors.muted)),
                const Spacer(),
                if (latest != null) TaskStatusChip(status: latest.status),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Full-width note editor: Markdown text with autosave, its tasks and
/// artifacts, and "hand to the agent".
class NoteEditor extends StatefulWidget {
  const NoteEditor({super.key, required this.note, required this.materials, required this.onClose});

  final NoteInfo note;
  final List<MaterialInfo> materials;
  final VoidCallback onClose;

  @override
  State<NoteEditor> createState() => _NoteEditorState();
}

class _NoteEditorState extends State<NoteEditor> {
  late final _title = TextEditingController(text: widget.note.title == '未命名写笺' ? '' : widget.note.title);
  late final _content = TextEditingController(text: widget.note.content);
  late final AgentController _agent;
  Timer? _debounce;
  var _saved = true;
  /// Title the core derived (first line) when the title field is empty.
  late String _savedTitle = widget.note.title;
  List<TaskInfo> _tasks = const [];
  List<ArtifactInfo> _artifacts = const [];

  @override
  void initState() {
    super.initState();
    _agent = AgentScope.read(context);
    _agent.workRevision.addListener(_loadLinks);
    _loadLinks();
  }

  @override
  void dispose() {
    _agent.workRevision.removeListener(_loadLinks);
    if (!_saved) unawaited(_save());
    _debounce?.cancel();
    _title.dispose();
    _content.dispose();
    super.dispose();
  }

  Future<void> _loadLinks() async {
    try {
      final results = await Future.wait([
        _agent.backend.call('tasks.list', {'noteId': widget.note.id}),
        _agent.backend.call('artifacts.list', {'noteId': widget.note.id}),
      ]);
      _tasks = jsonRows(results[0]).map(TaskInfo.fromJson).toList();
      _artifacts = jsonRows(results[1]).map(ArtifactInfo.fromJson).toList();
      if (mounted) setState(() {});
    } catch (_) {}
  }

  void _changed() {
    setState(() => _saved = false);
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 800), _save);
  }

  Future<void> _save() async {
    _debounce?.cancel();
    try {
      final saved = asJsonMap(await _agent.backend.call('notes.save', {'id': widget.note.id, 'cwd': widget.note.cwd, 'title': _title.text, 'content': _content.text}));
      _savedTitle = saved['title'] as String? ?? _savedTitle;
      if (mounted) setState(() => _saved = true);
    } catch (_) {}
  }

  Future<void> _handOff() async {
    await _save();
    if (!mounted) return;
    final choice = await showDialog<_HandOff>(context: context, builder: (_) => _HandOffDialog(materials: widget.materials));
    if (choice == null) return;
    await _agent.startTask(goal: choice.goal, title: '$_savedTitle：${choice.label}', noteId: widget.note.id, materialIds: choice.materialIds);
  }

  Future<void> _delete() async {
    if (!await confirmAction(context, title: '删除这份写笺？', message: '已经完成的任务和产物不受影响。', confirm: '删除', danger: true)) return;
    await _agent.backend.call('notes.remove', {'id': widget.note.id});
    _saved = true;
    widget.onClose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(AppTokens.padLg, AppTokens.pad, AppTokens.padLg, AppTokens.pad),
          child: Row(
            children: [
              IconButton(tooltip: '返回书桌', icon: const Icon(Icons.arrow_back), onPressed: () async {
                await _save();
                widget.onClose();
              }),
              const SizedBox(width: AppTokens.gap),
              Expanded(
                child: TextField(
                  controller: _title,
                  style: context.text.titleLarge?.copyWith(fontWeight: FontWeight.w600),
                  decoration: const InputDecoration(hintText: '标题（不填就用第一行）', border: InputBorder.none, enabledBorder: InputBorder.none, focusedBorder: InputBorder.none),
                  onChanged: (_) => _changed(),
                ),
              ),
              Text(_saved ? '已保存' : '保存中…', style: context.text.bodySmall?.copyWith(color: colors.muted)),
              const SizedBox(width: AppTokens.pad),
              IconButton(tooltip: '删除写笺', icon: const Icon(Icons.delete_outline), onPressed: _delete),
              const SizedBox(width: AppTokens.gap),
              FilledButton.icon(onPressed: _handOff, icon: const Icon(Icons.send_outlined, size: 18), label: const Text('交给 Agent')),
            ],
          ),
        ),
        const Divider(),
        Expanded(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.all(AppTokens.padLg),
                  child: TextField(
                    controller: _content,
                    expands: true,
                    maxLines: null,
                    textAlignVertical: TextAlignVertical.top,
                    style: context.text.bodyLarge?.copyWith(height: 1.6),
                    decoration: const InputDecoration(hintText: '用 Markdown 写下你的想法、要求或草稿…'),
                    onChanged: (_) => _changed(),
                  ),
                ),
              ),
              const VerticalDivider(width: 0.5),
              SizedBox(
                width: 320,
                child: ListView(
                  padding: const EdgeInsets.all(AppTokens.pad),
                  children: [
                    const SectionTitle('关联任务'),
                    if (_tasks.isEmpty) const EmptyNote('还没有交给 Agent。'),
                    for (final t in _tasks) TaskTile(task: t, compact: true),
                    const SectionTitle('产物'),
                    if (_artifacts.isEmpty) const EmptyNote('任务完成后，写出的文件会出现在这里。'),
                    for (final a in _artifacts)
                      ArtifactTile(
                        path: a.path,
                        exists: a.exists,
                        onContinue: () {
                          final task = _tasks.where((t) => t.id == a.taskId).firstOrNull;
                          _agent.continueWork(sessionFile: task?.sessionFile, cwd: widget.note.cwd, text: '继续修改 ${a.path}：');
                        },
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _HandOff {
  const _HandOff(this.goal, this.label, this.materialIds);

  final String goal;
  final String label;
  final List<String> materialIds;
}

/// Picks the action and materials when handing a note to the agent.
class _HandOffDialog extends StatefulWidget {
  const _HandOffDialog({required this.materials});

  final List<MaterialInfo> materials;

  @override
  State<_HandOffDialog> createState() => _HandOffDialogState();
}

class _HandOffDialogState extends State<_HandOffDialog> {
  static const _actions = {
    'summarize': ('总结', '总结这份写笺和附带的资料，提炼要点。'),
    'check': ('核对', '核对这份写笺里的事实、数据和说法，指出错误、矛盾和缺失，并给出依据。'),
    'report': ('写成报告', '根据这份写笺和附带的资料，写成一份结构清晰的报告，保存为 Markdown 文件。'),
    'todos': ('提炼待办', '从这份写笺和附带的资料里提炼出待办事项清单（每项写清做什么、截止时间、负责人，没有就留空）。'),
    'custom': ('自己写要求', ''),
  };

  var _action = 'summarize';
  final _selected = <String>{};
  final _extra = TextEditingController();

  @override
  void dispose() {
    _extra.dispose();
    super.dispose();
  }

  bool get _valid => _action != 'custom' || _extra.text.trim().isNotEmpty;

  @override
  Widget build(BuildContext context) {
    final (label, instruction) = _actions[_action]!;
    return AlertDialog(
      title: const Text('交给 Agent'),
      content: SizedBox(
        width: 600,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('要它做什么', style: context.text.labelMedium),
              const SizedBox(height: 6),
              Wrap(
                spacing: AppTokens.gap,
                runSpacing: 6,
                children: [
                  for (final e in _actions.entries)
                    ChoiceChip(label: Text(e.value.$1), selected: _action == e.key, onSelected: (_) => setState(() => _action = e.key)),
                ],
              ),
              const SizedBox(height: AppTokens.pad),
              TextField(
                controller: _extra,
                minLines: 2,
                maxLines: 5,
                decoration: InputDecoration(hintText: _action == 'custom' ? '写下你的要求' : '补充要求（可不填）'),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: AppTokens.padLg),
              Text('带上哪些资料', style: context.text.labelMedium),
              const SizedBox(height: 6),
              if (widget.materials.isEmpty)
                Text('书桌上还没有资料，可以在「资料」栏添加。', style: context.text.bodySmall?.copyWith(color: context.colors.muted))
              else
                for (final m in widget.materials)
                  MaterialTile(
                    material: m,
                    selected: _selected.contains(m.id),
                    onSelected: (v) => setState(() => v ? _selected.add(m.id) : _selected.remove(m.id)),
                  ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(
          onPressed: _valid
              ? () => Navigator.pop(
                  context,
                  _HandOff([instruction, _extra.text.trim()].where((s) => s.isNotEmpty).join('\n'), label, _selected.toList()),
                )
              : null,
          child: const Text('开始'),
        ),
      ],
    );
  }
}
