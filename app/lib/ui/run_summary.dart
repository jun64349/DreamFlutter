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
import '../craft_style.dart';
import 'agent_scope.dart';
import 'settings_layout.dart' show CardSurface;
import 'artifact_widgets.dart';
import 'conversation_panel.dart';
import 'details_panel_widgets.dart';
import 'message_widgets.dart' show DiffView, editDiff, toolPath;
import 'side_chat_view.dart';
import 'workspace_path.dart';
import 'git_file_diff.dart';
import 'goal_widgets.dart' show GoalJobs, GoalScope;
import 'proto_icon.dart';

List<ToolRun> _conversationTools(AgentController agent) {
  final transcript = agent.transcript;
  final ids = {
    for (final message in transcript.items.whereType<AssistantItem>())
      for (final part in message.parts.whereType<ToolCallPart>()) part.toolCallId,
  };
  return [for (final id in ids) ?transcript.tool(id)];
}

typedef _PanelFile = ({String path, ToolRun? run, bool changed, bool read});

int _compareFileNames(_PanelFile a, _PanelFile b) =>
    p.basename(a.path).toLowerCase().compareTo(p.basename(b.path).toLowerCase());

enum _WorkbenchSection {
  files('文件'),
  git('Git'),
  jobs('后台'),
  context('上下文');

  const _WorkbenchSection(this.label);
  final String label;
}

class RunPanel extends StatefulWidget {
  const RunPanel({super.key, required this.sessionFile, required this.onClose, this.width = AppTokens.runPanelWidth, this.onPreviewChanged, this.leadingSections, this.captionInset = 0});
  final Widget? leadingSections;
  final String? sessionFile;
  final VoidCallback onClose;
  final double width;
  final double captionInset;

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
  final _collapsedSections = <_WorkbenchSection>{};
  String _fileFilter = '全部';
  String _fileSort = '名字';
  @override
  void initState() {
    super.initState();
    _agent = AgentScope.read(context);
    _agent.workRevision.addListener(_load);
    _agent.contextFocus.addListener(_showContext);
    unawaited(_load());
  }
  void _showContext() {
    if (!mounted) return;
    setState(() {
      _collapsedSections.remove(_WorkbenchSection.context);
      if (_preview != null) { _preview = null; _previewClosedLater(); }
    });
  }
  @override
  void didUpdateWidget(RunPanel old) {
    super.didUpdateWidget(old);
    if (old.sessionFile != widget.sessionFile) { _run = null; _task = null; _artifacts = []; _git = null; if (_preview != null) { _preview = null; _previewClosedLater(); } unawaited(_load()); }
  }
  @override
  void dispose() { _agent.workRevision.removeListener(_load); _agent.contextFocus.removeListener(_showContext); if (_preview != null) _previewClosedLater(); super.dispose(); }

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

  Widget _fileRow(String path, ToolRun? run, bool changed, {bool read = false}) {
    final colors = context.colors;
    final folder = p.dirname(relativeWorkspacePath(_agent.workspace, path)).replaceAll('\\', '/');
    final extension = p.extension(path).replaceFirst('.', '').toUpperCase();
    final tint = switch (extension) {
      'MD' => const Color(0xFF5E7FA8),
      'PY' => const Color(0xFF4E8A5E),
      'CSV' => const Color(0xFFB5793F),
      _ => fileTypeColor(context, path),
    };
    final status = read ? '读过' : changed ? '改了' : '新建';
    final caption = folder == '.' || folder.isEmpty ? status : '$folder · $status';
    final hover = colors.ink.withValues(alpha: Theme.of(context).brightness == Brightness.dark ? .07 : .06);
    return GestureDetector(
      onSecondaryTapDown: (d) => _fileMenu(d.globalPosition, path, run, changed),
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        hoverColor: hover,
        onTap: () => _open(path, run, changed),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
          child: Row(children: [
            Container(
              width: 30, height: 30, alignment: Alignment.center,
              decoration: BoxDecoration(color: tint.withAlpha(0x22), borderRadius: BorderRadius.circular(8)),
              child: extension.isNotEmpty && extension.length <= 4
                  ? FittedBox(fit: BoxFit.scaleDown, child: Text(extension, maxLines: 1,
                      style: context.text.labelSmall?.copyWith(fontSize: 10.5, fontWeight: FontWeight.w700, letterSpacing: 0, color: tint)))
                  : Icon(fileIcon(path), size: 17, color: tint),
            ),
            const SizedBox(width: 10),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(p.basename(path), maxLines: 1, overflow: TextOverflow.ellipsis,
                style: context.text.bodyMedium?.copyWith(fontSize: 13, height: 1.6, color: colors.ink)),
              Text(caption, maxLines: 1, overflow: TextOverflow.ellipsis,
                style: context.text.bodySmall?.copyWith(fontSize: 11.5, height: 20.8 / 11.5, color: colors.muted)),
            ])),
          ]),
        ),
      ),
    );
  }

  Widget _fileSection(List<_PanelFile> files, List<_PanelFile> reads) {
    final colors = context.colors;
    final visibleFiles = [if (_fileFilter != '读过') ...files, ...reads];
    visibleFiles.sort((a, b) {
      final byType = _fileSort == '类型' ? p.extension(a.path).compareTo(p.extension(b.path)) : 0;
      return byType == 0 ? _compareFileNames(a, b) : byType;
    });
    final toolbarButtonStyle = IconButton.styleFrom(
      fixedSize: const Size.square(30),
      minimumSize: const Size.square(30),
      padding: EdgeInsets.zero,
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      shape: craftButtonShape(context.painting.craftGeometry),
    );
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 0, 0, 4),
          child: Row(children: [
            Expanded(child: Text('${files.length} 个改动 · ${reads.length} 个读过', style: context.text.bodySmall?.copyWith(fontSize: 12, color: colors.muted))),
            const SizedBox(width: 4),
            PopupMenuButton<String>(
              tooltip: '只看某类', style: toolbarButtonStyle, icon: ProtoIcon('filter', size: 14, color: colors.ink2),
              initialValue: _fileFilter, onSelected: (value) => setState(() => _fileFilter = value),
              itemBuilder: (_) => const [PopupMenuItem(value: '全部', child: Text('全部文件')), PopupMenuItem(value: '读过', child: Text('读过的文件'))],
            ),
            const SizedBox(width: 4),
            PopupMenuButton<String>(
              tooltip: '排序', style: toolbarButtonStyle, icon: ProtoIcon('sort', size: 14, color: colors.ink2),
              initialValue: _fileSort, onSelected: (value) => setState(() => _fileSort = value),
              itemBuilder: (_) => const [PopupMenuItem(value: '名字', child: Text('按名字')), PopupMenuItem(value: '类型', child: Text('按类型'))],
            ),
          ]),
        ),
      if (visibleFiles.isEmpty) _sectionNote('这个对话还没有这类文件'),
      for (final file in visibleFiles) _fileRow(file.path, file.run, file.changed, read: file.read),
    ]);
  }

  Widget _sectionNote(String text) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
    child: Text(text, style: context.text.bodySmall?.copyWith(fontSize: 12.5, color: context.colors.muted)),
  );

  Widget _workbenchBody(List<_PanelFile> files, List<_PanelFile> reads) {
    final jobs = GoalScope.of(context);
    final activeJobs = jobs != null && jobs.jobs.isNotEmpty ? jobs : null;
    final colors = context.colors;

    Widget section(_WorkbenchSection section, Widget child, {String? status}) => _WorkbenchPanelSection(
      key: ValueKey('panel-section-${section.name}'),
      section: section,
      status: status,
      expanded: !_collapsedSections.contains(section),
      onToggle: () => setState(() {
        if (!_collapsedSections.remove(section)) _collapsedSections.add(section);
      }),
      child: child,
    );

    return Column(key: const ValueKey('panel-list'), crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      DetailsPanelHeading(onClose: widget.onClose, captionInset: widget.captionInset),
      Expanded(child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 10), child: Text(_error!, style: TextStyle(color: colors.danger))),
          section(_WorkbenchSection.files, _fileSection(files, reads)),
          section(_WorkbenchSection.git, _gitSection()),
          section(
            _WorkbenchSection.jobs,
            activeJobs == null ? _sectionNote('还没有后台任务') : GoalJobs(state: activeJobs, showHeading: false),
            status: activeJobs == null ? null : '${activeJobs.jobs.where((job) => job['status'] == 'running').length} 个在跑',
          ),
          section(_WorkbenchSection.context, Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            const ConversationContextSection(showHeading: false),
            if (widget.leadingSections != null) widget.leadingSections!,
            if (_agent.active?.incognito != true) ...[const SizedBox(height: 14), const ConversationActionsSection()],
          ])),
        ]),
      )),
    ]);
  }

  Widget _gitSection() {
    final git = _git;
    final colors = context.colors;
    if (git == null) return _sectionNote('正在读取…');
    if (!git.isRepository) return _sectionNote(git.draftReason ?? '这个工作区不是 Git 仓库');
    String full(String path) => p.normalize(p.isAbsolute(path) ? path : p.join(git.root ?? _agent.workspace, path));
    return CardSurface(radius: context.radiusLg, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Padding(padding: const EdgeInsets.fromLTRB(10, 8, 10, 4), child: Row(children: [
        ProtoIcon('branch', size: 13, color: colors.muted),
        const SizedBox(width: 6),
        Expanded(child: Text(git.branch ?? 'Git', overflow: TextOverflow.ellipsis, style: context.label)),
        const SizedBox(width: 8),
        Text('${git.paths.length} 个改动', style: context.text.bodySmall?.copyWith(color: colors.muted)),
      ])),
      if (git.paths.isEmpty) Padding(padding: const EdgeInsets.fromLTRB(6, 0, 6, 6), child: _sectionNote('这个对话还没有改动')),
      if (git.paths.isNotEmpty) ...[
        ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 240),
          child: SingleChildScrollView(primary: false, child: Column(children: [
            for (final (i, path) in git.paths.indexed) ...[
              if (i > 0) Divider(height: 1, thickness: .5, color: colors.border),
              _fileRow(full(path), null, true),
            ],
          ])),
        ),
        Padding(padding: const EdgeInsets.all(8), child: Wrap(spacing: 8, children: [
        FilledButton.icon(onPressed: _agent.isRunning ? null : _commit, icon: const Icon(Icons.commit, size: 16), label: const Text('提交这些改动')),
        OutlinedButton(onPressed: () => _open(full(git.paths.first), null, true), child: const Text('看差异')),
        ])),
      ],
    ]));
  }

  Widget _previewView() {
    final preview = _preview!;
    final colors = context.colors;
    final path = preview.path;
    final tint = fileTypeColor(context, path);
    final genericFile = switch (fileKind(path)) {
      FileKind.text || FileKind.doc || FileKind.other => true,
      _ => false,
    };
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Padding(
        padding: EdgeInsets.fromLTRB(6, 6, 6 + widget.captionInset, 6),
        child: Row(children: [
          IconButton(tooltip: '回到这个对话', onPressed: _closePreview, icon: const Icon(Icons.arrow_back, size: 18)),
          genericFile ? ProtoIcon('file', size: 18, color: tint) : Icon(fileIcon(path), size: 18, color: tint),
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
    // Keep new and changed files together, with their kind's icon and the existing preview/menu.
    final files = <_PanelFile>[
      for (final entry in changes.entries) (path: entry.key, run: entry.value, changed: true, read: false),
      for (final path in products) (path: path, run: createdTools[path], changed: false, read: false),
    ];
    final read = <String, ToolRun?>{};
    for (final tool in tools.where((tool) => tool.status == ToolStatus.done && const {'read', 'read_image'}.contains(tool.name))) {
      final path = toolPath(tool);
      if (path != null) read[full(path)] = tool;
    }
    for (final file in files) { read.removeWhere((path, _) => SessionStore.samePath(path, file.path)); }
    final reads = <_PanelFile>[
      for (final entry in read.entries) (path: entry.key, run: entry.value, changed: false, read: true),
    ];
    final colors = context.colors;
    final Widget? overlay;
    if (side != null) {
      overlay = Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        DetailsPanelHeading(title: '问一下', captionInset: widget.captionInset, onClose: () { agent.closeSideChat(); widget.onClose(); }),
        Divider(height: 1, color: colors.border),
        Expanded(child: SideChatView(key: ObjectKey(side), side: side)),
      ]);
    } else if (_preview != null) {
      overlay = KeyedSubtree(key: ValueKey('preview-${_preview!.path}'), child: _previewView());
    } else {
      overlay = null;
    }
    final Widget body;
    if (!agent.sandbox) {
      body = Stack(fit: StackFit.expand, children: [
        Visibility(visible: overlay == null, maintainState: true, child: _workbenchBody(files, reads)),
        AnimatedSwitcher(
          duration: AppTokens.motion(context, AppTokens.panel),
          child: overlay ?? const SizedBox.shrink(),
        ),
      ]);
    } else if (overlay != null) {
      body = overlay;
    } else {
      files.sort(_compareFileNames);
      body = Column(key: const ValueKey('panel-list'), crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        DetailsPanelHeading(onClose: widget.onClose, captionInset: widget.captionInset),
        Divider(height: 1, color: colors.border),
        Expanded(child: ListView(padding: const EdgeInsets.all(14), children: [
          if (widget.leadingSections != null) widget.leadingSections!,
          if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 10), child: Text(_error!, style: TextStyle(color: colors.danger))),
          if (_task?['title'] is String) ...[Text(_task!['title'] as String, style: context.text.titleSmall), if (_task?['currentStep'] is String) Padding(padding: const EdgeInsets.only(top: 6, bottom: 16), child: Text(_task!['currentStep'] as String))],
          _block(
            '交付',
            files.isEmpty
                ? Padding(padding: const EdgeInsets.all(14), child: Text('这个对话还没动过文件', style: context.text.bodySmall?.copyWith(color: colors.muted)))
                : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    for (final (i, f) in files.indexed) ...[
                      if (i > 0) Divider(height: 1, thickness: 0.5, indent: 52, color: colors.border),
                      _fileRow(f.path, f.run, f.changed),
                    ],
                  ]),
            trailing: files.isEmpty ? null : Text('${files.length}', style: context.text.labelSmall?.copyWith(color: colors.muted)),
          ),
          const ConversationContextSection(),
          if (agent.active?.incognito != true) ...[const SizedBox(height: 18), const ConversationActionsSection()],
        ])),
      ]);
    }
    return Material(color: colors.sidebar, child: SizedBox(width: widget.width, child: AnimatedSwitcher(duration: AppTokens.motion(context, AppTokens.panel), child: body)));
  }
}

class _WorkbenchPanelSection extends StatelessWidget {
  const _WorkbenchPanelSection({
    super.key,
    required this.section,
    required this.expanded,
    required this.onToggle,
    required this.child,
    this.status,
  });

  final _WorkbenchSection section;
  final bool expanded;
  final VoidCallback onToggle;
  final Widget child;
  final String? status;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          expanded: expanded,
          child: TextButton(
            key: ValueKey('panel-toggle-${section.name}'),
            onPressed: onToggle,
            style: TextButton.styleFrom(
              foregroundColor: colors.ink,
              minimumSize: const Size(0, 34),
              visualDensity: VisualDensity.standard,
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
            ),
            child: Row(children: [
              Expanded(child: Text(section.label, style: context.label)),
              if (status != null) ...[
                Text(status!, style: context.text.bodySmall?.copyWith(fontSize: 11.5, color: colors.muted)),
                const SizedBox(width: 8),
              ],
              RotatedBox(
                quarterTurns: expanded ? 0 : -1,
                child: ProtoIcon('chev', size: 14, color: colors.muted),
              ),
            ]),
          ),
        ),
        Visibility(
          visible: expanded,
          maintainState: true,
          child: Padding(padding: const EdgeInsets.only(bottom: 8), child: child),
        ),
        if (section != _WorkbenchSection.context) Divider(height: 1, thickness: 1, color: colors.border),
      ],
    );
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
    if (patch != null && patch.isNotEmpty) return SingleChildScrollView(child: SelectableText(patch, style: const TextStyle(fontFamily: AppTokens.monoFamily, fontStyle: AppTokens.processFontStyle, fontSize: 12.5)));
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
