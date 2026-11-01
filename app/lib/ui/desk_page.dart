import 'dart:async';
import 'dart:io';

import 'package:desktop_drop/desktop_drop.dart';
import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart' show SessionStore;

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'artifact_widgets.dart';
import 'card_view.dart';
import 'common.dart';
import 'motion.dart';
import 'sidebar.dart' show WorkspaceSwitcher;
import 'task_widgets.dart';

/// The desk of the current workspace, in three columns like the design: notes
/// and materials on the left, the open note as a sheet of paper in the
/// middle, and what the agent is doing and has made on the right.
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
  var _dragging = false;

  /// The note in the middle column; the newest one opens on the first load.
  String? _openId;
  var _opened = false;

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
      _openId = null;
      _opened = false;
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
      if (!_opened) {
        _opened = true;
        _openId ??= _notes.firstOrNull?.id;
      }
      if (_openId != null && !_notes.any((n) => n.id == _openId)) _openId = null;
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
      setState(() {
        _notes = [note, ..._notes.where((n) => n.id != note.id)];
        _openId = note.id;
      });
    } catch (e) {
      _snack('新建写笺失败：${SessionRuntime.describeError(e)}');
    }
  }

  /// Keeps the list in step with the editor's autosave (title, preview, order).
  void _noteSaved(NoteInfo note) {
    if (!mounted) return;
    setState(() => _notes = [note, ..._notes.where((n) => n.id != note.id)]);
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

  /// Files and folders dropped on the left column become materials.
  Future<void> _addDropped(List<String> paths) async {
    final cwd = _agent.workspace;
    try {
      for (final path in paths) {
        final kind = FileSystemEntity.isDirectorySync(path) ? 'folder' : 'file';
        await _agent.backend.call('materials.add', {'cwd': cwd, 'kind': kind, 'path': path});
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
    final colors = context.colors;
    if (_error != null) return Center(child: Text(_error!, style: TextStyle(color: colors.danger)));
    if (_loading) return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    final open = _notes.where((n) => n.id == _openId).firstOrNull;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _notesColumn(context),
        Expanded(
          child: open == null
              ? _EmptyDesk(onNew: _newNote)
              : NoteEditor(
                  key: ValueKey(open.id),
                  note: open,
                  materials: _materials,
                  onSaved: _noteSaved,
                  onClose: () => setState(() => _openId = null),
                  onDeleted: () {
                    setState(() => _openId = null);
                    _load();
                  },
                ),
        ),
        _sideColumn(context),
      ],
    );
  }

  Widget _notesColumn(BuildContext context) {
    final colors = context.colors;
    return DropTarget(
      onDragEntered: (_) => setState(() => _dragging = true),
      onDragExited: (_) => setState(() => _dragging = false),
      onDragDone: (details) {
        setState(() => _dragging = false);
        _addDropped([for (final f in details.files) f.path]);
      },
      child: AnimatedContainer(
        duration: AppTokens.fast,
        width: 272,
        decoration: BoxDecoration(
          color: _dragging ? Color.alphaBlend(colors.accentSoft, colors.sidebar) : colors.sidebar,
          border: Border(right: BorderSide(color: colors.border)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(AppTokens.padLg, AppTokens.padLg, 14, 0),
              child: Row(
                children: [
                  Text('书桌', style: context.serif(context.text.titleMedium).copyWith(fontSize: 18, fontWeight: FontWeight.w600)),
                  const Spacer(),
                  Tooltip(
                    message: '新写笺',
                    child: FilledButton.icon(
                      onPressed: _newNote,
                      style: FilledButton.styleFrom(minimumSize: const Size(0, 30), padding: const EdgeInsets.symmetric(horizontal: 12)),
                      icon: const Icon(Icons.add, size: 16),
                      label: const Text('新写笺'),
                    ),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(AppTokens.padLg, 6, AppTokens.padLg, 0),
              child: Align(alignment: Alignment.centerLeft, child: WorkspaceSwitcher(key: ValueKey(_agent.workspace), compact: true)),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(10, 4, 10, AppTokens.pad),
                children: [
                  PanelLabel('写笺', count: _notes.length),
                  if (_notes.isEmpty) const _Hint('写下想法、要求或草稿，写好后交给 Agent。'),
                  for (final n in _notes) _NoteRow(note: n, selected: n.id == _openId, onTap: () => setState(() => _openId = n.id)),
                  PanelLabel(
                    '资料',
                    count: _materials.length,
                    trailing: PopupMenuButton<String>(
                      tooltip: '添加资料',
                      icon: const Icon(Icons.add, size: 16),
                      iconSize: 16,
                      padding: EdgeInsets.zero,
                      onSelected: _addMaterial,
                      itemBuilder: (_) => const [
                        PopupMenuItem(value: 'file', child: ListTile(dense: true, leading: Icon(Icons.description_outlined), title: Text('添加文件'))),
                        PopupMenuItem(value: 'folder', child: ListTile(dense: true, leading: Icon(Icons.folder_outlined), title: Text('添加文件夹'))),
                        PopupMenuItem(value: 'text', child: ListTile(dense: true, leading: Icon(Icons.content_paste), title: Text('粘贴文本'))),
                      ],
                    ),
                  ),
                  if (_materials.isEmpty) const _Hint('要参考的文件、文件夹或文字放在这里，交给 Agent 时可以选择带上，对话里输入 @ 也能引用。'),
                  for (final m in _materials) _MaterialRow(material: m, onRemove: () => _removeMaterial(m)),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
              child: OutlinedButton(
                onPressed: () => _addMaterial('text'),
                style: OutlinedButton.styleFrom(
                  minimumSize: const Size.fromHeight(36),
                  foregroundColor: _dragging ? colors.accent : colors.muted,
                  side: BorderSide(color: _dragging ? colors.accent : colors.border),
                ),
                child: Text(_dragging ? '松开，放到书桌上' : '拖入文件，或粘贴文字', style: context.text.bodySmall?.copyWith(color: _dragging ? colors.accent : colors.muted)),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _sideColumn(BuildContext context) {
    final colors = context.colors;
    final agent = AgentScope.of(context);
    final active = _tasks.where((t) => t.status.isActive).toList();
    final recent = _tasks.where((t) => !t.status.isActive).take(8).toList();
    final taskTitles = {for (final t in _tasks) t.id: t.title};
    return Container(
      width: 300,
      decoration: BoxDecoration(color: colors.sidebar, border: Border(left: BorderSide(color: colors.border))),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(14, AppTokens.gap, 14, AppTokens.padLg),
        children: [
          if (active.isNotEmpty) ...[
            const PanelLabel('进行中'),
            for (final t in active) _ActiveTask(task: t),
          ],
          PanelLabel('产物', count: _artifacts.length),
          if (_artifacts.isEmpty) const _Hint('Agent 写入或修改的文件会自动收集到这里。'),
          for (final a in _artifacts)
            ArtifactTile(
              path: a.path,
              exists: a.exists,
              subtitle: [
                if (taskTitles[a.taskId] != null) '来自「${taskTitles[a.taskId]}」',
                formatDate(a.updatedAt?.millisecondsSinceEpoch),
              ].where((s) => s.isNotEmpty).join(' · ').ifEmpty(null),
              onContinue: () {
                final task = _tasks.where((t) => t.id == a.taskId).firstOrNull;
                agent.continueWork(sessionFile: task?.sessionFile, cwd: agent.workspace, text: '继续修改 ${a.path}：');
              },
            ),
          PanelLabel(
            '卡片',
            count: _cards.length,
            trailing: PopupMenuButton<String>(
              tooltip: '导入卡片',
              icon: const Icon(Icons.add, size: 16),
              iconSize: 16,
              padding: EdgeInsets.zero,
              onSelected: _importCard,
              itemBuilder: (_) => const [
                PopupMenuItem(value: 'file', child: ListTile(dense: true, leading: Icon(Icons.style_outlined), title: Text('导入卡片文件（.card.html / .card.zip）'))),
                PopupMenuItem(value: 'folder', child: ListTile(dense: true, leading: Icon(Icons.folder_outlined), title: Text('导入卡片文件夹'))),
              ],
            ),
          ),
          if (_cards.isEmpty) const _Hint('对话里的卡片点「收进书桌」会复制一份放在这里，也可以导入别人分享的卡片。'),
          for (final c in _cards) DeskCardTile(key: ValueKey(c.id), card: c, onChanged: _load),
          PanelLabel(
            '最近任务',
            trailing: TextButton(
              onPressed: () => agent.showSection(AppSection.tasks),
              style: TextButton.styleFrom(minimumSize: const Size(0, 26), padding: const EdgeInsets.symmetric(horizontal: 6)),
              child: Text('全部', style: context.text.labelSmall?.copyWith(color: colors.accent)),
            ),
          ),
          if (recent.isEmpty && active.isEmpty) const _Hint('在这个工作区里做过的任务会出现在这里。'),
          for (final t in recent) TaskTile(task: t, compact: true),
        ],
      ),
    );
  }
}

extension on String {
  String? ifEmpty(String? other) => isEmpty ? other : this;
}

class _Hint extends StatelessWidget {
  const _Hint(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 2, 4, AppTokens.gap),
      child: Text(text, style: context.text.bodySmall?.copyWith(color: context.colors.muted, height: 1.5)),
    );
  }
}

/// The middle column when no note is open.
class _EmptyDesk extends StatelessWidget {
  const _EmptyDesk({required this.onNew});

  final VoidCallback onNew;

  @override
  Widget build(BuildContext context) {
    final muted = context.text.bodyMedium?.copyWith(color: context.colors.muted, height: 1.7);
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 380),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const ButterflyMark(size: 96, veins: true),
            const SizedBox(height: AppTokens.padLg),
            Text('一张干净的书桌', style: context.serif(context.text.titleLarge)),
            const SizedBox(height: AppTokens.gap),
            Text('写下想法、要求或草稿，写好后交给 Agent。\n它写出的文件会自动回到右边的「产物」。', textAlign: TextAlign.center, style: muted),
            const SizedBox(height: AppTokens.padLg),
            OutlinedButton.icon(onPressed: onNew, icon: const Icon(Icons.edit_outlined, size: 16), label: const Text('写一份')),
          ],
        ),
      ),
    );
  }
}

class _NoteRow extends StatelessWidget {
  const _NoteRow({required this.note, required this.selected, required this.onTap});

  final NoteInfo note;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final preview = note.content.replaceAll(RegExp(r'^#+\s*.*\n?'), '').replaceAll(RegExp(r'\s+'), ' ').trim();
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Material(
        color: selected ? colors.card : Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(context.radius),
          side: BorderSide(color: selected ? colors.border : Colors.transparent),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(context.radius),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppTokens.pad, vertical: 9),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  note.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.text.bodyMedium?.copyWith(fontWeight: selected ? FontWeight.w600 : FontWeight.w400),
                ),
                const SizedBox(height: 2),
                Text(
                  preview.isEmpty ? formatDate(note.updatedAt?.millisecondsSinceEpoch) : preview,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.text.bodySmall?.copyWith(color: colors.muted),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// One material in the left column: tap to look at it, × on hover to remove.
class _MaterialRow extends StatefulWidget {
  const _MaterialRow({required this.material, required this.onRemove});

  final MaterialInfo material;
  final VoidCallback onRemove;

  @override
  State<_MaterialRow> createState() => _MaterialRowState();
}

class _MaterialRowState extends State<_MaterialRow> {
  var _hover = false;

  void _open() {
    final m = widget.material;
    final agent = AgentScope.read(context);
    switch (m.kind) {
      case 'text':
        showTextDialog(context, title: m.title, text: m.content ?? '');
      case 'folder':
        if (m.path != null) agent.revealInExplorer(m.path!);
      default:
        final path = m.path;
        if (path == null) return;
        if (canPreview(path)) {
          showFilePreview(context, path);
        } else {
          agent.openFile(path);
        }
    }
  }

  @override
  Widget build(BuildContext context) {
    final m = widget.material;
    final colors = context.colors;
    final (icon, kind) = switch (m.kind) {
      'folder' => (Icons.folder_outlined, '文件夹'),
      'text' => (Icons.notes, '文字'),
      _ => (fileIcon(m.path ?? ''), '文件'),
    };
    return MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: InkWell(
        borderRadius: BorderRadius.circular(context.radius),
        onTap: _open,
        child: Tooltip(
          message: m.kind == 'text' ? (m.content ?? '') : (m.path ?? ''),
          waitDuration: const Duration(milliseconds: 800),
          child: SizedBox(
            height: 34,
            child: Row(
              children: [
                const SizedBox(width: 10),
                Icon(icon, size: 15, color: colors.muted),
                const SizedBox(width: AppTokens.gap),
                Expanded(child: Text(m.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: context.text.bodyMedium?.copyWith(fontSize: 13))),
                if (_hover)
                  IconButton(
                    tooltip: '从书桌移除',
                    icon: const Icon(Icons.close, size: 14),
                    visualDensity: VisualDensity.compact,
                    onPressed: widget.onRemove,
                  )
                else
                  Padding(padding: const EdgeInsets.only(right: 10), child: Text(kind, style: context.text.labelSmall?.copyWith(color: colors.muted))),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A running or waiting task on the right: what it is doing now.
class _ActiveTask extends StatelessWidget {
  const _ActiveTask({required this.task});

  final TaskInfo task;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final agent = AgentScope.read(context);
    final needsYou = task.status == TaskStatus.needsInput;
    final muted = context.text.bodySmall?.copyWith(color: colors.muted);
    return Padding(
      padding: const EdgeInsets.only(bottom: AppTokens.gap),
      child: Material(
        color: colors.card,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(context.radius),
          side: BorderSide(color: needsYou ? colors.warning.withValues(alpha: 0.6) : colors.border),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(context.radius),
          onTap: task.sessionFile == null ? null : () => agent.openTask(task),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    if (task.status == TaskStatus.running)
                      const BreathingDot()
                    else
                      Container(width: 7, height: 7, decoration: BoxDecoration(shape: BoxShape.circle, color: needsYou ? colors.warning : colors.muted)),
                    const SizedBox(width: AppTokens.gap),
                    Expanded(
                      child: Text(task.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: context.text.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
                    ),
                    const SizedBox(width: 6),
                    Text(task.status.label, style: muted),
                  ],
                ),
                if (task.currentStep != null || needsYou) ...[
                  const SizedBox(height: 6),
                  Text(needsYou ? '等你确认，点开处理' : '正在：${task.currentStep}', maxLines: 2, overflow: TextOverflow.ellipsis, style: muted),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The open note as a sheet of paper: title and Markdown text with autosave,
/// its tasks and artifacts underneath, and "hand to the agent".
class NoteEditor extends StatefulWidget {
  const NoteEditor({
    super.key,
    required this.note,
    required this.materials,
    required this.onClose,
    required this.onDeleted,
    this.onSaved,
  });

  final NoteInfo note;
  final List<MaterialInfo> materials;
  final VoidCallback onClose;
  final VoidCallback onDeleted;
  final ValueChanged<NoteInfo>? onSaved;

  @override
  State<NoteEditor> createState() => _NoteEditorState();
}

class _NoteEditorState extends State<NoteEditor> {
  late final _title = TextEditingController(text: widget.note.title == '未命名写笺' ? '' : widget.note.title);
  late final _content = TextEditingController(text: widget.note.content);
  late final AgentController _agent;
  Timer? _debounce;
  var _saved = true;
  DateTime? _savedAt;

  /// Title the core derived (first line) when the title field is empty.
  late String _savedTitle = widget.note.title;
  List<TaskInfo> _tasks = const [];
  List<ArtifactInfo> _artifacts = const [];

  @override
  void initState() {
    super.initState();
    _agent = AgentScope.read(context);
    _savedAt = widget.note.updatedAt;
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
      widget.onSaved?.call(NoteInfo.fromJson(saved));
      if (mounted) {
        setState(() {
          _saved = true;
          _savedAt = DateTime.now();
        });
      }
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
    widget.onDeleted();
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final muted = context.text.bodySmall?.copyWith(color: colors.muted);
    const plain = InputDecoration(
      border: InputBorder.none,
      enabledBorder: InputBorder.none,
      focusedBorder: InputBorder.none,
      filled: false,
      isDense: true,
      contentPadding: EdgeInsets.zero,
    );
    final saveTime = _savedAt == null ? '' : ' · ${formatDate(_savedAt!.millisecondsSinceEpoch).replaceFirst('今天 ', '')}';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          height: 56,
          padding: const EdgeInsets.symmetric(horizontal: 24),
          decoration: BoxDecoration(border: Border(bottom: BorderSide(color: colors.border))),
          child: Row(
            children: [
              Expanded(
                child: Text(_savedTitle, maxLines: 1, overflow: TextOverflow.ellipsis, style: context.serif(context.text.titleMedium).copyWith(fontSize: 18, fontWeight: FontWeight.w600)),
              ),
              Text(_saved ? '已自动保存$saveTime' : '保存中…', style: muted),
              const SizedBox(width: AppTokens.gap),
              IconButton(tooltip: '删除写笺', icon: const Icon(Icons.delete_outline, size: 20), onPressed: _delete),
              IconButton(
                tooltip: '关闭写笺',
                icon: const Icon(Icons.close, size: 20),
                onPressed: () async {
                  await _save();
                  widget.onClose();
                },
              ),
              const SizedBox(width: AppTokens.gap),
              FilledButton.icon(onPressed: _handOff, icon: const ButterflyGlyph(size: 18), label: const Text('交给 Agent')),
            ],
          ),
        ),
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(32, 28, 32, 40),
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 640),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    // The sheet of paper.
                    Container(
                      padding: const EdgeInsets.fromLTRB(44, 36, 44, 40),
                      decoration: BoxDecoration(
                        color: colors.card,
                        border: Border.all(color: colors.border),
                        borderRadius: BorderRadius.circular(context.radiusLg),
                      ),
                      child: Stack(
                        clipBehavior: Clip.none,
                        children: [
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              Padding(
                                padding: const EdgeInsets.only(right: 48),
                                child: TextField(
                                  controller: _title,
                                  style: context.serif(context.text.headlineSmall).copyWith(fontSize: 24, fontWeight: FontWeight.w600),
                                  decoration: plain.copyWith(hintText: '标题（不填就用第一行）', hintStyle: TextStyle(color: colors.muted.withValues(alpha: 0.7))),
                                  onChanged: (_) => _changed(),
                                ),
                              ),
                              const SizedBox(height: 18),
                              TextField(
                                controller: _content,
                                minLines: 14,
                                maxLines: null,
                                style: context.serif(context.text.bodyLarge).copyWith(fontSize: 15, height: 1.9),
                                decoration: plain.copyWith(hintText: '用 Markdown 写下你的想法、要求或草稿…', hintStyle: TextStyle(color: colors.muted.withValues(alpha: 0.7))),
                                onChanged: (_) => _changed(),
                              ),
                            ],
                          ),
                          const Positioned(top: -8, right: -12, child: ThemeMark()),
                        ],
                      ),
                    ),
                    const SizedBox(height: AppTokens.padLg),
                    PanelLabel('交给 Agent 的任务', count: _tasks.isEmpty ? null : _tasks.length),
                    if (_tasks.isEmpty) const _Hint('还没有交给 Agent。写好后点右上角「交给 Agent」。'),
                    for (final t in _tasks) TaskTile(task: t, compact: true),
                    if (_artifacts.isNotEmpty) ...[
                      PanelLabel('这份写笺的产物', count: _artifacts.length),
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
                  ],
                ),
              ),
            ),
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
              Text('要它做什么', style: context.label),
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
              Text('带上哪些资料', style: context.label),
              const SizedBox(height: 6),
              if (widget.materials.isEmpty)
                Text('书桌上还没有资料，可以在左栏「资料」添加，或把文件拖到左栏。', style: context.text.bodySmall?.copyWith(color: context.colors.muted))
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

/// A material as a checkbox row (choosing materials for a task).
class MaterialTile extends StatelessWidget {
  const MaterialTile({super.key, required this.material, this.selected, this.onSelected});

  final MaterialInfo material;
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
        ],
      ),
    );
  }
}
