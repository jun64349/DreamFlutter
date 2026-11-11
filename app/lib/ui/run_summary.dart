import 'dart:async';
import 'dart:io';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/services.dart';

import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../state/conversation_git.dart';
import '../state/mentions.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'settings_layout.dart' show CardSurface;
import 'artifact_widgets.dart';
import 'conversation_panel.dart';
import 'message_widgets.dart' show ChatRow, ReplyRow, DiffView, editDiff;
import 'side_chat_view.dart';
import 'workspace_path.dart';
import 'git_file_diff.dart';

List<ToolRun> _conversationTools(AgentController agent) {
  final reply = ChatRow.fromItems(agent.transcript.items).whereType<ReplyRow>().lastOrNull;
  return [for (final message in reply?.assistants ?? <AssistantItem>[]) for (final part in message.parts.whereType<ToolCallPart>()) ?agent.transcript.tool(part.toolCallId)];
}

class RunPanel extends StatefulWidget {
  const RunPanel({super.key, required this.sessionFile, required this.onClose, this.width = AppTokens.runPanelWidth, this.onPreviewChanged});
  final String? sessionFile;
  final VoidCallback onClose;
  final double width;

  /// A file opened or closed in the panel (the panel widens while one is open).
  final ValueChanged<bool>? onPreviewChanged;
  @override
  State<RunPanel> createState() => _RunPanelState();
}

class _RunPanelState extends State<RunPanel> {
  late final AgentController _agent;
  RunInfo? _run;
  Json? _task;
  List<Json> _artifacts = [];
  ConversationGitState? _git;
  ConversationGitBridge? _bridge;
  String? _error;
  int _generation = 0;
  @override
  void initState() {
    super.initState();
    _agent = AgentScope.read(context);
    _agent.workRevision.addListener(_load);
    unawaited(_load());
  }
  @override
  void didUpdateWidget(RunPanel old) {
    super.didUpdateWidget(old);
    if (old.sessionFile != widget.sessionFile) { _run = null; _task = null; _artifacts = []; _git = null; if (_preview != null) { _preview = null; _previewClosedLater(); } unawaited(_load()); }
  }
  @override
  void dispose() { _agent.workRevision.removeListener(_load); if (_preview != null) _previewClosedLater(); super.dispose(); }

  /// Tells the panel the preview is gone, after this frame (it may be mid-build or unmounting).
  void _previewClosedLater() { final done = widget.onPreviewChanged; WidgetsBinding.instance.addPostFrameCallback((_) => done?.call(false)); }
  Future<void> _load() async {
    final generation = ++_generation;
    final file = widget.sessionFile;
    if (file == null) return;
    try {
      final rows = jsonRows(await _agent.backend.call('runs.list', {'sessionFile': file, 'limit': 1}));
      final run = rows.isEmpty ? null : RunInfo.fromJson(rows.first);
      final task = asJsonMap(await _agent.backend.call('tasks.forSession', {'sessionFile': file}));
      final artifacts = task['id'] is String ? jsonRows(await _agent.backend.call('artifacts.list', {'taskId': task['id']})) : <Json>[];
      final bridge = _agent.sandbox ? null : ConversationGitAdapters.resolve?.call(_agent) ?? RpcConversationGitBridge(_agent);
      ConversationGitState? git;
      String? gitError;
      final changed = <String>{...?run?.files, for (final tool in _conversationTools(_agent)) if (tool.status == ToolStatus.done && (tool.name == 'edit' || tool.name == 'write')) if ((tool.args['file_path'] ?? tool.args['path']) case final String path) path};
      try { git = await bridge?.inspect(_agent.workspace, changed.toList()); }
      catch (error) { gitError = SessionRuntime.describeError(error); }
      if (!mounted || generation != _generation || widget.sessionFile != file) return;
      setState(() { _run = run; _task = task; _artifacts = artifacts; _bridge = bridge; _git = git; _error = gitError; });
    } catch (error) { if (mounted && generation == _generation) setState(() => _error = SessionRuntime.describeError(error)); }
  }
  Future<void> _commit() async {
    final bridge = _bridge;
    final state = _git;
    if (bridge == null || state == null || state.paths.isEmpty) return;
    await showDialog<void>(context: context, builder: (_) => AgentScope(controller: _agent, child: ConversationCommitEditor(bridge: bridge, prepared: state, cwd: _agent.workspace)));
    await _load();
  }
  /// A file opened in the panel (0.8.2, user test: preview in the right panel, not a dialog).
  ({String path, ToolRun? run, bool changed})? _preview;
  var _showDiff = true;

  void _open(String path, ToolRun? run, bool changed, {bool diff = true}) {
    setState(() { _preview = (path: path, run: run, changed: changed); _showDiff = changed && diff; });
    widget.onPreviewChanged?.call(true);
  }

  void _closePreview() {
    setState(() => _preview = null);
    widget.onPreviewChanged?.call(false);
  }

  Future<void> _saveAs(String path) async {
    final location = await getSaveLocation(suggestedName: p.basename(path));
    if (location == null || SessionStore.samePath(location.path, path)) return;
    try {
      await File(path).copy(location.path);
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('已另存为 ${location.path}')));
    } catch (error) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('没能另存：${SessionRuntime.describeError(error)}')));
    }
  }

  /// The file's menu (right click, or the ⋯ in the preview): the same order everywhere.
  Future<void> _fileMenu(Offset at, String path, ToolRun? run, bool changed) async {
    final overlay = Overlay.of(context).context.findRenderObject() as RenderBox;
    final local = overlay.globalToLocal(at);
    final value = await showMenu<String>(
      context: context,
      position: RelativeRect.fromLTRB(local.dx, local.dy, overlay.size.width - local.dx, overlay.size.height - local.dy),
      items: [
        const PopupMenuItem(value: 'preview', child: ListTile(dense: true, leading: Icon(Icons.visibility_outlined, size: 18), title: Text('预览'))),
        if (changed) const PopupMenuItem(value: 'diff', child: ListTile(dense: true, leading: Icon(Icons.difference_outlined, size: 18), title: Text('看改了什么'))),
        const PopupMenuItem(value: 'open', child: ListTile(dense: true, leading: Icon(Icons.open_in_new, size: 18), title: Text('用默认程序打开'))),
        const PopupMenuItem(value: 'reveal', child: ListTile(dense: true, leading: Icon(Icons.folder_open_outlined, size: 18), title: Text('打开所在文件夹'))),
        const PopupMenuItem(value: 'save', child: ListTile(dense: true, leading: Icon(Icons.save_alt, size: 18), title: Text('另存为…'))),
        const PopupMenuItem(value: 'copy', child: ListTile(dense: true, leading: Icon(Icons.copy, size: 18), title: Text('复制路径'))),
      ],
    );
    if (!mounted || value == null) return;
    switch (value) {
      case 'preview': _open(path, run, changed, diff: false);
      case 'diff': _open(path, run, changed);
      case 'open': await _agent.openFile(path);
      case 'reveal': await _agent.revealFile(path);
      case 'save': await _saveAs(path);
      case 'copy':
        await Clipboard.setData(ClipboardData(text: path));
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已复制路径')));
    }
  }

  Widget _block(String title, Widget child, {Widget? trailing}) => Padding(
    padding: const EdgeInsets.only(bottom: 18),
    child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Padding(padding: const EdgeInsets.only(left: 2, bottom: 8), child: Row(children: [Text(title, style: context.label), const Spacer(), ?trailing])),
      CardSurface(radius: context.radiusLg, child: child),
    ]),
  );

  Widget _fileRow(String path, ToolRun? run, bool changed) {
    final colors = context.colors;
    final folder = p.dirname(relativeWorkspacePath(_agent.workspace, path));
    final tint = fileTypeColor(context, path);
    return GestureDetector(
      onSecondaryTapDown: (d) => _fileMenu(d.globalPosition, path, run, changed),
      child: InkWell(
        onTap: () => _open(path, run, changed),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 9, 10, 9),
          child: Row(children: [
            Container(
              width: 30, height: 30,
              decoration: BoxDecoration(color: tint.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(7)),
              child: Icon(fileIcon(path), size: 17, color: tint),
            ),
            const SizedBox(width: 10),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(p.basename(path), maxLines: 1, overflow: TextOverflow.ellipsis, style: context.text.bodyMedium?.copyWith(fontSize: 13.5, color: colors.ink)),
              if (folder != '.' && folder.isNotEmpty) Text(folder, maxLines: 1, overflow: TextOverflow.ellipsis, style: context.text.bodySmall?.copyWith(fontSize: 11.5, color: colors.muted)),
            ])),
            const SizedBox(width: 6),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              decoration: BoxDecoration(color: (changed ? colors.warning : colors.success).withValues(alpha: 0.14), borderRadius: BorderRadius.circular(5)),
              child: Text(changed ? '改动' : '新建', style: context.text.labelSmall?.copyWith(fontSize: 11, color: changed ? colors.warning : colors.success)),
            ),
          ]),
        ),
      ),
    );
  }

  Widget _previewView() {
    final preview = _preview!;
    final colors = context.colors;
    final path = preview.path;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Padding(
        padding: const EdgeInsets.all(6),
        child: Row(children: [
          IconButton(tooltip: '回到这个对话', onPressed: _closePreview, icon: const Icon(Icons.arrow_back, size: 18)),
          Icon(fileIcon(path), size: 18, color: fileTypeColor(context, path)),
          const SizedBox(width: 8),
          Expanded(child: Tooltip(message: path, child: Text(p.basename(path), maxLines: 1, overflow: TextOverflow.ellipsis, style: context.text.titleSmall))),
          Builder(builder: (context) => IconButton(
            tooltip: '更多',
            icon: const Icon(Icons.more_horiz, size: 18),
            onPressed: () {
              final box = context.findRenderObject() as RenderBox;
              _fileMenu(box.localToGlobal(Offset(0, box.size.height)), path, preview.run, preview.changed);
            },
          )),
        ]),
      ),
      if (preview.changed)
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 0, 14, 8),
          child: SegmentedButton<bool>(
            showSelectedIcon: false,
            style: SegmentedButton.styleFrom(visualDensity: VisualDensity.compact),
            segments: const [ButtonSegment(value: true, label: Text('改了什么')), ButtonSegment(value: false, label: Text('现在的内容'))],
            selected: {_showDiff},
            onSelectionChanged: (v) => setState(() => _showDiff = v.first),
          ),
        ),
      Divider(height: 1, color: colors.border),
      Expanded(
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: preview.changed && _showDiff
              ? _DiffPane(key: ValueKey('diff-$path'), path: path, run: preview.run, bridge: _bridge, cwd: _agent.workspace)
              : FilePreviewBody(key: ValueKey('file-$path'), path: path),
        ),
      ),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final side = agent.sideChat;
    final tools = _conversationTools(agent);
    String full(String path) => fullWorkspacePath(agent.workspace, path);
    final changes = <String, ToolRun?>{};
    for (final path in _run?.files ?? <String>[]) { changes[full(path)] = null; }
    for (final tool in tools.where((r) => r.name == 'edit' || r.name == 'write')) {
      final path = tool.args['file_path'] ?? tool.args['path'];
      if (path is String && tool.status == ToolStatus.done) changes[full(path)] = tool;
    }
    final products = <String>{for (final row in _artifacts) if (row['path'] is String) full(row['path'] as String)};
    bool matches(Set<String>? paths, String path) => paths?.any((value) => SessionStore.samePath(value, path)) ?? false;
    for (final entry in changes.entries) {
      final created = matches(_git?.createdPaths, entry.key) || entry.value?.details['created'] == true;
      final modified = matches(_git?.modifiedPaths, entry.key) || entry.value?.name == 'edit' && !created || entry.value?.details['created'] == false;
      if (modified) { products.removeWhere((path) => SessionStore.samePath(path, entry.key)); }
      else if (created || entry.value?.name == 'write') { products.add(entry.key); }
    }
    for (final path in products.toList()) {
      if (matches(_git?.modifiedPaths, path)) { products.remove(path); changes.putIfAbsent(path, () => null); }
    }
    final createdTools = {for (final e in changes.entries) e.key: e.value};
    changes.removeWhere((path, _) => products.any((product) => SessionStore.samePath(path, product)));
    // 0.8.2 (user test): changed and created files are one list — the files this conversation touched —
    // each marked 新建 or 改动 with its kind's icon; a click previews it here, a right click has the rest.
    final files = <(String, ToolRun?, bool)>[
      for (final entry in changes.entries) (entry.key, entry.value, true),
      for (final path in products) (path, createdTools[path], false),
    ]..sort((a, b) => p.basename(a.$1).toLowerCase().compareTo(p.basename(b.$1).toLowerCase()));
    final colors = context.colors;
    final Widget body;
    if (side != null) {
      body = Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(padding: const EdgeInsets.fromLTRB(16, 10, 6, 10), child: Row(children: [
          Expanded(child: Text('问一下', style: context.text.titleSmall)),
          IconButton(tooltip: '收起详情', onPressed: () { agent.closeSideChat(); widget.onClose(); }, icon: const Icon(Icons.close, size: 18)),
        ])),
        Divider(height: 1, color: colors.border),
        Expanded(child: SideChatView(key: ObjectKey(side), side: side)),
      ]);
    } else if (_preview != null) {
      body = KeyedSubtree(key: ValueKey('preview-${_preview!.path}'), child: _previewView());
    } else {
      body = Column(key: const ValueKey('panel-list'), crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(padding: const EdgeInsets.fromLTRB(16, 10, 6, 10), child: Row(children: [
          Expanded(child: Text(agent.sandbox ? '任务进度' : '这个对话', style: context.text.titleSmall)),
          IconButton(tooltip: '收起详情', onPressed: widget.onClose, icon: const Icon(Icons.close, size: 18)),
        ])),
        Divider(height: 1, color: colors.border),
        Expanded(child: ListView(padding: const EdgeInsets.all(14), children: [
          if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 10), child: Text(_error!, style: TextStyle(color: colors.danger))),
          if (agent.sandbox && _task?['title'] is String) ...[Text(_task!['title'] as String, style: context.text.titleSmall), if (_task?['currentStep'] is String) Padding(padding: const EdgeInsets.only(top: 6, bottom: 16), child: Text(_task!['currentStep'] as String))],
          _block(
            '文件',
            files.isEmpty
                ? Padding(padding: const EdgeInsets.all(14), child: Text('这个对话还没动过文件', style: context.text.bodySmall?.copyWith(color: colors.muted)))
                : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    for (final (i, f) in files.indexed) ...[
                      if (i > 0) Divider(height: 1, thickness: 0.5, indent: 52, color: colors.border),
                      _fileRow(f.$1, f.$2, f.$3),
                    ],
                    if (_git?.isRepository == true && _git!.paths.isNotEmpty) ...[
                      Divider(height: 1, thickness: 0.5, color: colors.border),
                      Padding(
                        padding: const EdgeInsets.all(8),
                        child: TextButton.icon(onPressed: agent.isRunning ? null : _commit, icon: const Icon(Icons.commit, size: 17), label: const Text('提交这些改动')),
                      ),
                    ],
                  ]),
            trailing: files.isEmpty ? null : Text('${files.length}', style: context.text.labelSmall?.copyWith(color: colors.muted)),
          ),
          const ConversationContextSection(),
          if (agent.active?.incognito != true) ...[const SizedBox(height: 18), const ConversationActionsSection()],
        ])),
      ]);
    }
    return Material(color: colors.sidebar, child: SizedBox(width: widget.width, child: AnimatedSwitcher(duration: AppTokens.motion(context, AppTokens.medium), child: body)));
  }
}

/// What a changed file's edit did: the tool's own diff, or Git's patch.
class _DiffPane extends StatefulWidget {
  const _DiffPane({super.key, required this.path, required this.run, required this.bridge, required this.cwd});
  final String path;
  final ToolRun? run;
  final ConversationGitBridge? bridge;
  final String cwd;
  @override
  State<_DiffPane> createState() => _DiffPaneState();
}

class _DiffPaneState extends State<_DiffPane> {
  String? _patch, _error;
  var _loading = false;
  late final _lines = widget.run == null ? null : editDiff(widget.run!);

  @override
  void initState() {
    super.initState();
    final lines = _lines;
    if ((lines == null || lines.isEmpty) && widget.bridge != null) {
      _loading = true;
      widget.bridge!.diff(widget.cwd, widget.path).then((patch) {
        if (mounted) setState(() { _patch = patch; _loading = false; });
      }, onError: (Object error) {
        if (mounted) setState(() { _error = SessionRuntime.describeError(error); _loading = false; });
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final lines = _lines;
    final patch = _patch;
    if (_loading) return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    if (_error != null) return Text(_error!, style: TextStyle(color: context.colors.danger));
    if (lines != null && lines.isNotEmpty) return SingleChildScrollView(child: DiffView(lines: lines));
    if (patch != null && patch.isNotEmpty) return SingleChildScrollView(child: SelectableText(patch, style: const TextStyle(fontFamily: AppTokens.monoFamily, fontSize: 12.5)));
    return Text('暂时没有可显示的差异', style: context.text.bodySmall?.copyWith(color: context.colors.muted));
  }
}

class ConversationCommitEditor extends StatefulWidget {
  const ConversationCommitEditor({super.key, required this.bridge, required this.prepared, required this.cwd});
  final ConversationGitBridge bridge;
  final ConversationGitState prepared;
  final String cwd;
  @override
  State<ConversationCommitEditor> createState() => _ConversationCommitEditorState();
}

class _ConversationCommitEditorState extends State<ConversationCommitEditor> {
  late final SessionRuntime? _session;
  late final String? _sessionId;
  late final String? _sessionPath;
  late final _message = TextEditingController();
  ConversationGitState? _prepared;
  List<GitFileDiff> _files = [];
  final _selected = <String>{};
  bool _preparing = true;
  bool _busy = false;
  String? _error;
  String? _commit;
  @override
  void initState() {
    super.initState();
    final agent = AgentScope.read(context);
    _session = agent.active; _sessionId = agent.activeSessionId; _sessionPath = agent.currentSessionPath;
    unawaited(_prepare());
  }
  Future<void> _prepare() async {
    try {
      final prepared = await widget.bridge.prepare(widget.cwd, widget.prepared.paths);
      if (mounted) setState(() { _prepared = prepared; _files = parseGitFileDiffs(prepared.diff, prepared.paths); _selected.addAll(prepared.paths); _message.text = prepared.suggestedMessage; _preparing = false; });
    } catch (error) { if (mounted) setState(() { _error = SessionRuntime.describeError(error); _preparing = false; }); }
  }
  @override
  void dispose() { _message.dispose(); super.dispose(); }
  Future<void> _save() async {
    if (_selected.isEmpty || _busy || _preparing) return;
    final agent = AgentScope.read(context);
    if (agent.isRunning || !identical(agent.active, _session) || agent.activeSessionId != _sessionId || agent.currentSessionPath != _sessionPath || !SessionStore.samePath(agent.workspace, widget.cwd)) { setState(() => _error = '工作区或对话已变化，请重新检查改动'); return; }
    setState(() { _busy = true; _error = null; });
    try {
      final prepared = _prepared;
      if (prepared == null) return;
      final chosen = prepared.paths.where(_selected.contains).toList();
      final hash = await widget.bridge.commit(widget.cwd, paths: List.unmodifiable(chosen), message: _message.text.trim(), expectedHead: prepared.head, expectedFingerprint: prepared.fingerprint, expectedPaths: chosen.length == prepared.paths.length ? null : prepared.paths);
      if (mounted) setState(() => _commit = hash);
    } catch (error) { if (mounted) setState(() => _error = SessionRuntime.describeError(error)); }
    finally { if (mounted) setState(() => _busy = false); }
  }
  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('提交这些改动'),
    content: SizedBox(width: 560, child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (_preparing) const LinearProgressIndicator(),
      for (final file in _files) GitFileDiffRow(key: ValueKey(file.paths.first), file: file, root: _prepared?.root ?? widget.cwd, selected: file.paths.every(_selected.contains), onChanged: _busy || _commit != null ? null : (selected) => setState(() { if (selected) { _selected.addAll(file.paths); } else { _selected.removeAll(file.paths); } })),
      const SizedBox(height: 12),
      if (_commit == null && _prepared?.draftReason != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(_prepared!.draftReason!, style: context.text.bodySmall)),
      if (_commit == null) TextField(controller: _message, enabled: !_preparing && _prepared != null, maxLines: 4, minLines: 2, onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: '提交说明'))
      else Text('已提交 $_commit', style: TextStyle(color: context.colors.accent)),
      if (_error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_error!, style: TextStyle(color: context.colors.danger))),
    ]))),
    actions: [TextButton(onPressed: _busy ? null : () => Navigator.pop(context), child: Text(_commit == null ? '取消' : '关闭')), if (_commit == null) FilledButton(onPressed: _preparing || _prepared == null || _selected.isEmpty || _busy || _message.text.trim().isEmpty ? null : _save, child: Text(_busy ? '正在提交…' : '确认提交'))],
  );
}

Mention mentionOf(MaterialInfo m) => switch (m.kind) {
  'text' => Mention(kind: MentionKind.text, title: m.title, content: m.content),
  'folder' => Mention(kind: MentionKind.folder, title: m.title, path: m.path),
  _ => Mention(kind: MentionKind.file, title: m.title, path: m.path),
};
