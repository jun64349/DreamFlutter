import 'dart:async';

import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../state/conversation_git.dart';
import '../state/mentions.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'artifact_widgets.dart';
import 'message_widgets.dart' show ChatRow, ReplyRow, DiffView, editDiff;
import 'side_chat_view.dart';
import 'workspace_path.dart';
import 'git_file_diff.dart';

List<ToolRun> _conversationTools(AgentController agent) {
  final reply = ChatRow.fromItems(agent.transcript.items).whereType<ReplyRow>().lastOrNull;
  return [for (final message in reply?.assistants ?? <AssistantItem>[]) for (final part in message.parts.whereType<ToolCallPart>()) ?agent.transcript.tool(part.toolCallId)];
}

class RunPanel extends StatefulWidget {
  const RunPanel({super.key, required this.sessionFile, required this.onClose, this.width = AppTokens.runPanelWidth});
  final String? sessionFile;
  final VoidCallback onClose;
  final double width;
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
    if (old.sessionFile != widget.sessionFile) { _run = null; _task = null; _artifacts = []; _git = null; unawaited(_load()); }
  }
  @override
  void dispose() { _agent.workRevision.removeListener(_load); super.dispose(); }
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
  Future<void> _diff(String path, ToolRun? run) async {
    final lines = run == null ? null : editDiff(run);
    String? patch;
    if ((lines == null || lines.isEmpty) && _bridge != null) {
      try { patch = await _bridge!.diff(_agent.workspace, path); }
      catch (error) { if (mounted) setState(() => _error = SessionRuntime.describeError(error)); return; }
    }
    if (!mounted) return;
    await showDialog<void>(context: context, builder: (context) => AlertDialog(
      title: Text(p.basename(path)),
      content: SizedBox(width: 650, child: SingleChildScrollView(child: lines != null && lines.isNotEmpty ? DiffView(lines: lines) : patch != null && patch.isNotEmpty ? SelectableText(patch, style: const TextStyle(fontFamily: AppTokens.monoFamily, fontSize: 13)) : const Text('暂时没有可显示的差异'))),
      actions: [TextButton(onPressed: () { Navigator.pop(context); showFilePreview(this.context, path); }, child: const Text('预览')), TextButton(onPressed: () => Navigator.pop(context), child: const Text('关闭'))],
    ));
  }
  Future<void> _commit() async {
    final bridge = _bridge;
    final state = _git;
    if (bridge == null || state == null || state.paths.isEmpty) return;
    await showDialog<void>(context: context, builder: (_) => AgentScope(controller: _agent, child: ConversationCommitEditor(bridge: bridge, prepared: state, cwd: _agent.workspace)));
    await _load();
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
    changes.removeWhere((path, _) => products.any((product) => SessionStore.samePath(path, product)));
    return Material(color: context.colors.sidebar, child: SizedBox(width: widget.width, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Padding(padding: const EdgeInsets.fromLTRB(16, 10, 6, 10), child: Row(children: [
        Expanded(child: Text(side != null ? '问一下' : agent.sandbox ? '任务进度' : '本次改动', style: context.text.titleSmall)),
        IconButton(tooltip: '收起详情', onPressed: () { if (side != null) agent.closeSideChat(); widget.onClose(); }, icon: const Icon(Icons.close, size: 18)),
      ])),
      Divider(height: 1, color: context.colors.border),
      if (side != null) Expanded(child: SideChatView(key: ObjectKey(side), side: side))
      else Expanded(child: ListView(padding: const EdgeInsets.all(14), children: [
        if (_error != null) Text(_error!, style: TextStyle(color: context.colors.danger)),
        if (agent.sandbox && _task?['title'] is String) ...[Text(_task!['title'] as String, style: context.text.titleSmall), if (_task?['currentStep'] is String) Padding(padding: const EdgeInsets.only(top: 6, bottom: 16), child: Text(_task!['currentStep'] as String))],
        if (changes.isEmpty && products.isEmpty) Padding(padding: const EdgeInsets.symmetric(vertical: 24), child: Text('还没有改动', textAlign: TextAlign.center, style: context.text.bodySmall?.copyWith(color: context.colors.muted))),
        if (changes.isNotEmpty) ...[
          Text('改了的文件', style: context.label), const SizedBox(height: 8),
          for (final entry in changes.entries) ListTile(
            contentPadding: EdgeInsets.zero, leading: Icon(Icons.description_outlined, size: 18, color: context.colors.accent),
            title: WorkspacePathLabel(path: entry.key, style: context.text.bodySmall),
            onTap: () => _diff(entry.key, entry.value),
          ),
        ],
        if (products.isNotEmpty) ...[
          const SizedBox(height: 20), Text('生成的文件', style: context.label), const SizedBox(height: 8),
          for (final path in products) Row(children: [
            Expanded(child: WorkspacePathLabel(path: path, style: context.text.bodySmall)),
            IconButton(tooltip: '预览', onPressed: () => showFilePreview(context, path), icon: const Icon(Icons.visibility_outlined, size: 17)),
            IconButton(tooltip: '打开所在文件夹', onPressed: () => agent.revealFile(path), icon: const Icon(Icons.folder_open_outlined, size: 17)),
          ]),
        ],
        if (_git?.isRepository == true && _git!.paths.isNotEmpty) ...[
          const SizedBox(height: 20), OutlinedButton.icon(onPressed: agent.isRunning ? null : _commit, icon: const Icon(Icons.commit, size: 17), label: const Text('提交这些改动')),
        ],
      ])),
    ])));
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
