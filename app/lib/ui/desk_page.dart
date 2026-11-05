import 'dart:async';
import 'dart:io';

import 'package:desktop_drop/desktop_drop.dart';
import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'artifact_widgets.dart';
import 'card_view.dart';
import 'common.dart';
import 'motion.dart';
import 'task_widgets.dart';

/// 蝶君's 「工作」 (the v0.2 desk, moved over in v0.3), in three columns:
/// notes and materials on the left, the open note as a sheet of paper in the
/// middle, and what 蝶君 is doing and has delivered on the right. Handing a
/// note over copies the materials into its inbox; what it delivers comes back
/// through its outbox.
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
  List<OutboxFile> _outbox = const [];
  String? _error;
  var _loading = true;
  var _dragging = false;

  /// The note in the middle column; the newest one opens on the first load.
  String? _openId;
  var _opened = false;

  @override
  void initState() {
    super.initState();
    _agent = AgentScope.read(context);
    _agent.workRevision.addListener(_load);
    _agent.main.outboxRevision.addListener(_load);
    _load();
  }

  @override
  void dispose() {
    _agent.workRevision.removeListener(_load);
    _agent.main.outboxRevision.removeListener(_load);
    super.dispose();
  }

  /// 蝶君's home: its notes, materials and cards are kept under it.
  String get _cwd => _agent.butterflyHome ?? _agent.workspace;

  Future<void> _load() async {
    final cwd = _cwd;
    try {
      final desk = asJsonMap(await _agent.backend.call('desk.get', {'cwd': cwd}));
      _notes = jsonRows(desk['notes']).map(NoteInfo.fromJson).toList();
      _materials = jsonRows(desk['materials']).map(MaterialInfo.fromJson).toList();
      _tasks = jsonRows(desk['tasks']).map(TaskInfo.fromJson).toList();
      // Files the v0.2 desk's agent wrote on this machine came along with their notes: not 蝶君's.
      _artifacts = jsonRows(desk['artifacts']).map(ArtifactInfo.fromJson).where((a) => isSandboxPath(a.path)).toList();
      _cards = jsonRows(await _agent.backend.call('cards.list', {'cwd': cwd, 'resident': true})).map(CardInfo.fromJson).toList();
      try {
        _outbox = jsonRows(await _agent.backend.call('butterfly.outbox')).map(OutboxFile.fromJson).toList();
      } catch (_) {
        _outbox = const []; // an older core
      }
      _error = null;
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
      final note = NoteInfo.fromJson(asJsonMap(await _agent.backend.call('notes.save', {'cwd': _cwd, 'content': ''})));
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
    final cwd = _cwd;
    // Pickers start in the workbench's folder: 蝶君's home holds nothing of the user's.
    final start = _agent.main.workspace.isEmpty ? null : _agent.main.workspace;
    try {
      switch (kind) {
        case 'file':
          final files = await openFiles(initialDirectory: start, confirmButtonText: '添加到「工作」');
          for (final f in files) {
            await _agent.backend.call('materials.add', {'cwd': cwd, 'kind': 'file', 'path': f.path});
          }
        case 'folder':
          final folder = await getDirectoryPath(initialDirectory: start, confirmButtonText: '添加到「工作」');
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
    final cwd = _cwd;
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

  /// Imports a shared card (`.card.html`, `.card.zip` or a package folder) into 「工作」.
  Future<void> _importCard(String kind) async {
    try {
      String? path;
      if (kind == 'folder') {
        path = await getDirectoryPath(confirmButtonText: '导入这张卡片');
      } else {
        path = (await openFile(acceptedTypeGroups: const [XTypeGroup(label: 'Showcard 卡片', extensions: ['html', 'htm', 'zip'])]))?.path;
      }
      if (path == null) return;
      final card = CardInfo.fromJson(asJsonMap(await _agent.backend.call('cards.import', {'path': path, 'cwd': _cwd})));
      _snack('已导入「${card.title}」。蝶君的卡片不能使用这台电脑上的文件、网络或程序。');
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
      enable: showsOnScreen(context),
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
                  Text('写笺与资料', style: context.serif(context.text.titleMedium).copyWith(fontSize: 18, fontWeight: FontWeight.w600)),
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
            const SizedBox(height: 6),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(10, 4, 10, AppTokens.pad),
                children: [
                  PanelLabel('写笺', count: _notes.length),
                  if (_notes.isEmpty) const _Hint('写下要求、想法或草稿，写好后交给蝶君。'),
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
                  if (_materials.isEmpty) const _Hint('要用的文件、文件夹或文字放在这里。交给蝶君时，它们的副本会放进蝶君的 inbox，原文件不受影响。'),
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
                child: Text(_dragging ? '松开，放进资料' : '拖入文件，或粘贴文字', style: context.text.bodySmall?.copyWith(color: _dragging ? colors.accent : colors.muted)),
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
          PanelLabel(
            '交付',
            count: _outbox.length,
            trailing: IconButton(tooltip: '刷新', icon: const Icon(Icons.refresh, size: 16), visualDensity: VisualDensity.compact, onPressed: _load),
          ),
          if (_outbox.isEmpty) const _Hint('蝶君放进 outbox 的文件会出现在这里：可以预览、改一改，再保存到你的电脑。'),
          for (final f in _outbox) OutboxTile(key: ValueKey(f.path), file: f, onChanged: _load),
          PanelLabel('改过的文件', count: _artifacts.length),
          if (_artifacts.isEmpty) const _Hint('蝶君在沙箱里写入或修改的文件会记在这里。'),
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
                agent.continueWork(sessionFile: task?.sessionFile, cwd: _cwd, text: '继续修改 ${a.path}：');
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
          if (_cards.isEmpty) const _Hint('和蝶君的对话里，卡片点「收进「工作」」会复制一份放在这里，也可以导入别人分享的卡片。'),
          for (final c in _cards) DeskCardTile(key: ValueKey(c.id), card: c, onChanged: _load),
          PanelLabel(
            '最近任务',
            trailing: TextButton(
              onPressed: () => agent.showSection(AppSection.tasks),
              style: TextButton.styleFrom(minimumSize: const Size(0, 26), padding: const EdgeInsets.symmetric(horizontal: 6)),
              child: Text('全部', style: context.text.labelSmall?.copyWith(color: colors.accent)),
            ),
          ),
          if (recent.isEmpty && active.isEmpty) const _Hint('交给蝶君的任务会出现在这里。'),
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
            const ButterflyMark(size: 96),
            const SizedBox(height: AppTokens.padLg),
            Text('还没有打开的写笺', style: context.serif(context.text.titleLarge)),
            const SizedBox(height: AppTokens.gap),
            Text('写下要求、想法或草稿，交给蝶君。\n它在自己的沙箱里做，做好的文件会出现在右边的「交付」。', textAlign: TextAlign.center, style: muted),
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
                    tooltip: '从资料里移除',
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
    required this.onClose,
    required this.onDeleted,
    this.onSaved,
  });

  final NoteInfo note;
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
  var _handingOff = false;

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
      // Only 蝶君's own work: the v0.2 desk ran notes on the workbench, on this machine.
      _tasks = jsonRows(results[0]).map(TaskInfo.fromJson).where((t) => _agent.isButterflyCwd(t.cwd)).toList();
      _artifacts = jsonRows(results[1]).map(ArtifactInfo.fromJson).where((a) => isSandboxPath(a.path)).toList();
      if (mounted) setState(() {});
    } catch (_) {}
  }

  /// Bumped on every edit: a save only counts for the edits it carried.
  var _revision = 0;

  void _changed() {
    _revision++;
    setState(() => _saved = false);
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 800), _save);
  }

  Future<void> _save() async {
    _debounce?.cancel();
    final revision = _revision;
    try {
      final saved = asJsonMap(await _agent.backend.call('notes.save', {'id': widget.note.id, 'cwd': widget.note.cwd, 'title': _title.text, 'content': _content.text}));
      _savedTitle = saved['title'] as String? ?? _savedTitle;
      widget.onSaved?.call(NoteInfo.fromJson(saved));
      if (mounted) {
        setState(() {
          // Edits made while this was saving are still unsaved (closing saves them).
          _saved = revision == _revision;
          _savedAt = DateTime.now();
        });
      }
    } catch (_) {}
  }

  /// Straight to 蝶君, no choosing an action (extra feedback 6): it reads the
  /// note, gets copies of all the materials, and asks when something is unclear.
  Future<void> _handOff() async {
    await _save();
    if (!mounted) return;
    setState(() => _handingOff = true);
    try {
      await _agent.handOffNote(widget.note.id, title: _savedTitle);
    } finally {
      if (mounted) setState(() => _handingOff = false);
    }
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
              FilledButton.icon(
                onPressed: _handingOff ? null : _handOff,
                icon: _handingOff ? const SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const ButterflyGlyph(size: 18),
                label: Text(_handingOff ? '正在交给蝶君…' : '交给蝶君'),
              ),
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
                    PanelLabel('交给蝶君的任务', count: _tasks.isEmpty ? null : _tasks.length),
                    if (_tasks.isEmpty) const _Hint('还没有交给蝶君。写好后点右上角「交给蝶君」：资料的副本会一起放进它的 inbox。'),
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
