import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../state/mentions.dart';
import '../state/session_runtime.dart' show QuestionNode;
import '../theme.dart';
import 'agent_scope.dart';
import 'artifact_widgets.dart';
import 'message_widgets.dart' show ChatRow, ReplyRow, TodoList, todoItems, toolSubject;
import 'motion.dart';
import 'task_widgets.dart';
import 'dashboard_page.dart' show formatCost, formatTokens;

/// The panel beside the conversation: the task this session runs (if any)
/// and the latest run: its steps (live while it runs), the files it
/// changed, how long it took and what it cost.
class RunPanel extends StatefulWidget {
  const RunPanel({super.key, required this.sessionFile, required this.onClose});

  final String? sessionFile;
  final VoidCallback onClose;

  @override
  State<RunPanel> createState() => _RunPanelState();
}

class _RunPanelState extends State<RunPanel> {
  late final AgentController _agent;
  RunInfo? _run;
  List<RunStepInfo>? _steps;
  TaskInfo? _task;

  /// 0 the run, 1 the desk, 2 the branch tree.
  var _tab = 0;

  @override
  void initState() {
    super.initState();
    _agent = AgentScope.read(context);
    _agent.workRevision.addListener(_load);
    _load();
  }

  @override
  void didUpdateWidget(RunPanel old) {
    super.didUpdateWidget(old);
    if (old.sessionFile != widget.sessionFile) {
      _run = null;
      _steps = null;
      _task = null;
      _load();
    }
  }

  @override
  void dispose() {
    _agent.workRevision.removeListener(_load);
    super.dispose();
  }

  Future<void> _load() async {
    final file = widget.sessionFile;
    if (file == null) return;
    try {
      final rows = jsonRows(await _agent.backend.call('runs.list', {'sessionFile': file, 'limit': 1}));
      final run = rows.isEmpty ? null : RunInfo.fromJson(rows.first);
      final steps = run == null ? <RunStepInfo>[] : jsonRows(await _agent.backend.call('runs.steps', {'runId': run.id})).map(RunStepInfo.fromJson).toList();
      final taskRow = await _agent.backend.call('tasks.forSession', {'sessionFile': file});
      if (!mounted || widget.sessionFile != file) return;
      setState(() {
        _run = run;
        _steps = steps;
        _task = taskRow is Map ? TaskInfo.fromJson(taskRow.cast<String, dynamic>()) : null;
      });
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final running = agent.isRunning;
    final run = _run;
    final task = _task;
    return Container(
      width: AppTokens.runPanelWidth,
      decoration: BoxDecoration(
        color: colors.sidebar,
        border: Border(left: BorderSide(color: colors.border, width: 0.5)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            height: 56,
            child: Padding(
              padding: const EdgeInsets.only(left: 12, right: 8),
              child: Row(
                children: [
                  _TabButton(label: '本次运行', selected: _tab == 0, onTap: () => setState(() => _tab = 0), dot: running),
                  _TabButton(label: '书桌', selected: _tab == 1, onTap: () => setState(() => _tab = 1)),
                  _TabButton(label: '分支', selected: _tab == 2, onTap: () => setState(() => _tab = 2)),
                  const Spacer(),
                  IconButton(tooltip: '收起右栏', onPressed: widget.onClose, icon: const Icon(Icons.close, size: 18)),
                ],
              ),
            ),
          ),
          Divider(height: 0.5, color: colors.border),
          if (_tab == 1)
            const Expanded(child: _DeskTab())
          else if (_tab == 2)
            const Expanded(child: _BranchTab())
          else
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(18, 14, 18, 18),
                children: [
                  if (task != null && task.source != 'chat') ...[_TaskCard(task: task), const SizedBox(height: 18)],
                  if (agent.planMode) ...[_PlanModeNote(), const SizedBox(height: 18)],
                  if (todoItems(agent.todos) case final todos when todos.isNotEmpty) ...[
                    Text('待办', style: context.label),
                    const SizedBox(height: 8),
                    TodoList(todos: todos),
                    const SizedBox(height: 18),
                  ],
                  if (running)
                    ..._liveSteps(context, agent)
                  else if (run == null)
                    Text('发出第一条消息后，这里会显示每次运行的步骤、改动的文件、耗时和花费。', style: context.text.bodySmall?.copyWith(color: colors.muted, height: 1.7))
                  else ...[
                    Text('步骤', style: context.label),
                    const SizedBox(height: 8),
                    if (_steps == null) const LinearProgressIndicator(),
                    if (_steps != null && _steps!.isEmpty) Text('这次没有调用工具。', style: context.text.bodySmall?.copyWith(color: colors.muted)),
                    for (final s in _steps ?? const <RunStepInfo>[])
                      _StepRow(
                        label: switch (s.kind) {
                          'retry' => '重试',
                          'compaction' => '压缩上下文',
                          'error' => '出错',
                          _ => _stepLabel(s.name ?? '', s.summary),
                        },
                        status: s.status,
                        durationMs: s.durationMs,
                      ),
                    if (run.files.isNotEmpty) ...[
                      const SizedBox(height: 18),
                      Text('改动的文件', style: context.label),
                      const SizedBox(height: 8),
                      for (final f in run.files) ArtifactTile(path: f, exists: true, onContinue: () => _agent.insertIntoComposer('继续修改 $f：')),
                    ],
                    if (run.error != null && run.status == 'failed') ...[
                      const SizedBox(height: 12),
                      Text(run.error!, style: context.text.bodySmall?.copyWith(color: colors.danger)),
                    ],
                    const SizedBox(height: 18),
                    Row(
                      children: [
                        Expanded(
                          child: _Fact(label: '耗时', value: formatDuration(run.duration)),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: _Fact(label: '花费', value: run.cost > 0 ? formatCost(run.cost) : '—'),
                        ),
                      ],
                    ),
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        Expanded(
                          child: _Fact(label: '工具调用', value: run.toolErrors > 0 ? '${run.toolCalls}（${run.toolErrors} 出错）' : '${run.toolCalls}'),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: _Fact(label: 'Token', value: run.tokens > 0 ? formatTokens(run.tokens) : '—'),
                        ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
        ],
      ),
    );
  }

  /// While a run is going, its steps come straight from the transcript.
  List<Widget> _liveSteps(BuildContext context, AgentController agent) {
    final rows = ChatRow.fromItems(agent.transcript.items);
    final reply = rows.lastOrNull is ReplyRow ? rows.last as ReplyRow : null;
    final tools = [
      for (final a in reply?.assistants ?? const <AssistantItem>[])
        for (final part in a.parts.whereType<ToolCallPart>()) ?agent.transcript.tool(part.toolCallId),
    ];
    return [
      Text('步骤', style: context.label),
      const SizedBox(height: 8),
      if (tools.isEmpty) Text('正在思考…', style: context.text.bodySmall?.copyWith(color: context.colors.muted)),
      for (final t in tools)
        _StepRow(
          label: _stepLabel(t.name, toolSubject(t)),
          status: switch (t.status) {
            ToolStatus.error => 'error',
            ToolStatus.done => 'done',
            ToolStatus.interrupted => 'interrupted',
            _ => 'running',
          },
          durationMs: t.durationMs,
        ),
    ];
  }

  static String _stepLabel(String tool, String? subject) {
    final verb = switch (tool) {
      'read' => '读取',
      'read_image' => '看图',
      'grep' || 'find' || 'glob' => '搜索',
      'ls' => '查看目录',
      'bash' || 'powershell' || 'pwsh' => '运行',
      'edit' => '修改',
      'write' => '写入',
      'web_fetch' => '读取网页',
      'working_directory' => '工作目录',
      'todo_write' => '更新待办',
      'ask_user_question' => '向你提问',
      'exit_plan_mode' => '提交计划',
      'skill' => '载入技能',
      'job_output' || 'job_list' || 'job_kill' => '后台任务',
      _ => tool,
    };
    return subject == null || subject.isEmpty ? verb : '$verb  $subject';
  }
}

/// Plan mode is on: what that means, in one place.
class _PlanModeNote extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: colors.accentSoft, borderRadius: BorderRadius.circular(context.radius)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.map_outlined, size: 16, color: colors.accent),
          const SizedBox(width: 8),
          Expanded(
            child: Text('计划模式：Agent 只查看、不改动，写好计划后交给你审阅，批准后才开始动手。', style: context.text.bodySmall?.copyWith(color: colors.ink2, height: 1.6)),
          ),
        ],
      ),
    );
  }
}

class _TabButton extends StatelessWidget {
  const _TabButton({required this.label, required this.selected, required this.onTap, this.dot = false});

  final String label;
  final bool selected;
  final VoidCallback onTap;

  /// Something is going on there (a run in progress).
  final bool dot;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Semantics(
      selected: selected,
      button: true,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(context.radius),
        child: Container(
          height: 56,
          padding: const EdgeInsets.symmetric(horizontal: 8),
          decoration: BoxDecoration(
            border: Border(bottom: BorderSide(color: selected ? colors.accent : Colors.transparent, width: 2)),
          ),
          alignment: Alignment.center,
          child: Row(
            children: [
              Text(
                label,
                style: context.text.bodyMedium?.copyWith(color: selected ? colors.ink : colors.muted, fontWeight: selected ? FontWeight.w600 : null),
              ),
              if (dot) ...[const SizedBox(width: 6), const BreathingDot(size: 6)],
            ],
          ),
        ),
      ),
    );
  }
}

/// The workspace's notes and materials; clicking one attaches it to the
/// next message.
class _DeskTab extends StatefulWidget {
  const _DeskTab();

  @override
  State<_DeskTab> createState() => _DeskTabState();
}

class _DeskTabState extends State<_DeskTab> {
  late final AgentController _agent;
  List<NoteInfo>? _notes;
  List<MaterialInfo> _materials = const [];

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

  Future<void> _load() async {
    try {
      final desk = asJsonMap(await _agent.backend.call('desk.get', {'cwd': _agent.workspace}));
      if (!mounted) return;
      setState(() {
        _notes = jsonRows(desk['notes']).map(NoteInfo.fromJson).toList();
        _materials = jsonRows(desk['materials']).map(MaterialInfo.fromJson).toList();
      });
    } catch (_) {
      if (mounted) setState(() => _notes = const []);
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final notes = _notes;
    if (notes == null) return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    Widget row(IconData icon, String title, String? subtitle, Mention mention) =>
        _PanelRow(icon: icon, title: title, subtitle: subtitle, tooltip: '附到下一条消息', onTap: () => _agent.mention(mention));
    return ListView(
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 18),
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(6, 0, 6, 10),
          child: Text('点一下，把它附到下一条消息里。也可以在输入框里打 @ 来选。', style: context.text.bodySmall?.copyWith(color: colors.muted, height: 1.6)),
        ),
        if (notes.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(6, 4, 6, 6),
            child: Text('写笺', style: context.label),
          ),
        for (final n in notes)
          row(Icons.sticky_note_2_outlined, n.title, n.content.replaceAll('\n', ' '), Mention(kind: MentionKind.note, title: n.title, content: n.content)),
        if (_materials.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(6, 12, 6, 6),
            child: Text('资料', style: context.label),
          ),
        for (final m in _materials)
          row(
            switch (m.kind) {
              'folder' => Icons.folder_outlined,
              'text' => Icons.notes,
              _ => Icons.description_outlined,
            },
            m.title,
            m.path,
            mentionOf(m),
          ),
        if (notes.isEmpty && _materials.isEmpty)
          Padding(
            padding: const EdgeInsets.all(6),
            child: Text('这个工作区的书桌还是空的。', style: context.text.bodySmall?.copyWith(color: colors.muted)),
          ),
        const SizedBox(height: 12),
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(onPressed: () => _agent.showSection(AppSection.desk), icon: const Icon(Icons.edit_note, size: 16), label: const Text('去书桌')),
        ),
      ],
    );
  }
}

Mention mentionOf(MaterialInfo m) => switch (m.kind) {
  'text' => Mention(kind: MentionKind.text, title: m.title, content: m.content),
  'folder' => Mention(kind: MentionKind.folder, title: m.title, path: m.path),
  _ => Mention(kind: MentionKind.file, title: m.title, path: m.path),
};

/// The session's questions as a tree: each branch is where a question was
/// edited and asked again. Click one to show its branch.
class _BranchTab extends StatefulWidget {
  const _BranchTab();

  @override
  State<_BranchTab> createState() => _BranchTabState();
}

class _BranchTabState extends State<_BranchTab> {
  List<QuestionNode>? _nodes;
  int _loadedRevision = -1;
  Object? _loadedFor;

  Future<void> _load(AgentController agent) async {
    final nodes = await agent.questionTree();
    if (mounted) setState(() => _nodes = nodes);
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    // Reload after each change once the run is over, and on switching sessions.
    final revision = agent.transcript.revision;
    if (!agent.isRunning && (revision != _loadedRevision || !identical(agent.active, _loadedFor))) {
      _loadedRevision = revision;
      _loadedFor = agent.active;
      WidgetsBinding.instance.addPostFrameCallback((_) => _load(agent));
    }
    final nodes = _nodes;
    if (nodes == null) return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    if (nodes.isEmpty) {
      return Padding(
        padding: const EdgeInsets.all(18),
        child: Text('还没有提问。改写一条消息重新发送，或者重新生成回复，就会在这里长出分支。', style: context.text.bodySmall?.copyWith(color: colors.muted, height: 1.7)),
      );
    }
    final rows = branchRows(nodes);
    final current = nodes.where((n) => n.active).lastOrNull;
    final forks = nodes.length - nodes.map((n) => n.parentId).toSet().length;
    return ListView(
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 18),
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(6, 0, 6, 10),
          child: Text(
            forks > 0 ? '共 ${nodes.length} 个提问，$forks 处分支。点一个提问，切到它所在的分支。' : '共 ${nodes.length} 个提问，还没有分支。改写消息或重新生成会产生分支。',
            style: context.text.bodySmall?.copyWith(color: colors.muted, height: 1.6),
          ),
        ),
        for (final (node, depth, forked) in rows)
          Padding(
            padding: EdgeInsets.only(left: depth * 14.0),
            child: _PanelRow(
              leading: Container(
                width: 9,
                height: 9,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: node.active ? colors.accent : null,
                  border: Border.all(color: node.active ? colors.accent : colors.muted, width: 1.2),
                ),
              ),
              title: node.text,
              subtitle: forked ? '分支' : null,
              bold: node == current,
              muted: !node.active,
              tooltip: node.active ? '在当前分支上' : '切到这个分支',
              onTap: node.active || agent.isRunning ? null : () => agent.openBranch(node.target),
            ),
          ),
      ],
    );
  }
}

/// [nodes] in drawing order with their indent: a linear conversation stays
/// flat, each fork indents its branches by one step. The flag marks the
/// first question of a branch.
List<(QuestionNode, int, bool)> branchRows(List<QuestionNode> nodes) {
  final children = <String?, List<QuestionNode>>{};
  for (final n in nodes) {
    children.putIfAbsent(n.parentId, () => []).add(n);
  }
  final rows = <(QuestionNode, int, bool)>[];
  void visit(QuestionNode node, int depth, bool forked) {
    rows.add((node, depth, forked));
    final kids = children[node.entryId] ?? const [];
    for (final kid in kids) {
      kids.length == 1 ? visit(kid, depth, false) : visit(kid, depth + 1, true);
    }
  }

  final roots = children[null] ?? const [];
  for (final root in roots) {
    visit(root, roots.length > 1 ? 1 : 0, roots.length > 1);
  }
  return rows;
}

/// A clickable row in the panel's lists.
class _PanelRow extends StatelessWidget {
  const _PanelRow({this.icon, this.leading, required this.title, this.subtitle, this.tooltip, this.onTap, this.bold = false, this.muted = false});

  final IconData? icon;
  final Widget? leading;
  final String title;
  final String? subtitle;
  final String? tooltip;
  final VoidCallback? onTap;
  final bool bold;
  final bool muted;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final row = InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(context.radius),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 7),
        child: Row(
          children: [
            SizedBox(
              width: 18,
              child: Center(child: leading ?? Icon(icon, size: 16, color: colors.muted)),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: context.text.bodySmall?.copyWith(fontSize: 13, color: muted ? colors.muted : colors.ink, fontWeight: bold ? FontWeight.w600 : null),
                  ),
                  if (subtitle != null && subtitle!.isNotEmpty)
                    Text(
                      subtitle!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: context.text.labelSmall?.copyWith(color: colors.muted),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
    return tooltip == null ? row : Tooltip(message: tooltip!, child: row);
  }
}

class _StepRow extends StatelessWidget {
  const _StepRow({required this.label, required this.status, required this.durationMs});

  final String label;
  final String? status;
  final int? durationMs;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final (Widget mark, Color tint) = switch (status) {
      'running' => (const BreathingDot(size: 6), colors.accentSoft),
      'error' => (Icon(Icons.close, size: 11, color: colors.danger), colors.diffRemoved),
      'interrupted' => (Icon(Icons.remove, size: 11, color: colors.muted), colors.border),
      _ => (Icon(Icons.check, size: 11, color: colors.accent), colors.accentSoft),
    };
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Container(
            width: 18,
            height: 18,
            decoration: BoxDecoration(color: tint, shape: BoxShape.circle),
            alignment: Alignment.center,
            child: mark,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: context.text.bodySmall?.copyWith(fontSize: 13, color: colors.ink),
            ),
          ),
          if (durationMs != null)
            Text(
              durationMs! < 1000 ? '$durationMs 毫秒' : '${(durationMs! / 1000).toStringAsFixed(1)} 秒',
              style: context.text.bodySmall?.copyWith(color: colors.muted),
            ),
        ],
      ),
    );
  }
}

class _Fact extends StatelessWidget {
  const _Fact({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: colors.card,
        border: Border.all(color: colors.border),
        borderRadius: BorderRadius.circular(context.radius),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(label, style: context.text.labelSmall?.copyWith(color: colors.muted)),
          const SizedBox(height: 2),
          Text(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: context.serif(context.text.titleMedium).copyWith(fontSize: 17, fontWeight: FontWeight.w600),
          ),
        ],
      ),
    );
  }
}

/// The desk or template task this session is running.
class _TaskCard extends StatelessWidget {
  const _TaskCard({required this.task});

  final TaskInfo task;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 6, 10),
      decoration: BoxDecoration(
        color: colors.card,
        border: Border.all(color: colors.border),
        borderRadius: BorderRadius.circular(context.radius),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('${task.sourceLabel}任务', style: context.label),
          const SizedBox(height: 4),
          Text(
            task.title,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: context.text.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              TaskStatusChip(status: task.status),
              const Spacer(),
              TextButton(onPressed: () => showTaskDetails(context, task), child: const Text('详情')),
            ],
          ),
        ],
      ),
    );
  }
}
