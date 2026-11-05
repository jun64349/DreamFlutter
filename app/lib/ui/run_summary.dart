import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../state/mentions.dart';
import '../state/session_runtime.dart' show QuestionNode;
import '../theme.dart';
import 'agent_scope.dart';
import 'artifact_widgets.dart';
import 'chat_view.dart' show SessionActions;
import 'message_widgets.dart' show ChatRow, ReplyRow, TodoList, todoItems, toolSubject;
import 'motion.dart';
import 'task_widgets.dart';
import 'dashboard_page.dart' show formatCost, formatTokens;

/// The panel beside the conversation: the task this session runs (if any)
/// and the latest run: its steps (live while it runs), the files it
/// changed, how long it took and what it cost.
class RunPanel extends StatefulWidget {
  const RunPanel({super.key, required this.sessionFile, required this.onClose, this.width = AppTokens.runPanelWidth});

  final String? sessionFile;
  final double width;
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
      width: widget.width,
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
                  _TabButton(label: '概览', selected: _tab == 0, onTap: () => setState(() => _tab = 0), dot: running),
                  // The desk is 蝶君's 「工作」 now: only its conversations get the tab.
                  if (agent.sandbox) _TabButton(label: '写笺', selected: _tab == 1, onTap: () => setState(() => _tab = 1)),
                  _TabButton(label: '分支', selected: _tab == 2, onTap: () => setState(() => _tab = 2)),
                  const Spacer(),
                  IconButton(tooltip: '收起详情', onPressed: widget.onClose, icon: const Icon(Icons.close, size: 18)),
                ],
              ),
            ),
          ),
          Divider(height: 0.5, color: colors.border),
          if (_tab == 1 && agent.sandbox)
            const Expanded(child: _DeskTab())
          else if (_tab == 2)
            const Expanded(child: _BranchTab())
          else
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(14, 10, 14, 18),
                children: [
                  if (task != null && task.source != 'chat') ...[_TaskCard(task: task), const SizedBox(height: 10)],
                  ..._sections(context, agent, running, run),
                ],
              ),
            ),
        ],
      ),
    );
  }

  /// Whether the step list shows every step (otherwise only the latest few).
  var _allSteps = false;

  /// The overview in blocks (0.4, roadmap 4.3 and the design's option 3):
  /// progress, steps, products and changes, subagents, context and cost, actions.
  List<Widget> _sections(BuildContext context, AgentController agent, bool running, RunInfo? run) {
    final colors = context.colors;
    final muted = context.text.bodySmall?.copyWith(color: colors.muted, height: 1.6);
    final todos = todoItems(agent.todos);
    final tools = _replyTools(agent);
    final steps = running ? _liveStepRows(tools) : _savedStepRows();
    final latest = running ? null : run;
    final changed = running
        ? {for (final t in tools) if ((t.name == 'edit' || t.name == 'write') && t.args['path'] is String) t.args['path'] as String}.toList()
        : latest?.files ?? const <String>[];
    final subagents = [for (final t in tools) if (t.name == 'agent') t];
    const shown = 5;
    final hidden = _allSteps ? 0 : (steps.length - shown).clamp(0, steps.length);
    final stats = agent.stats;
    final small = TextButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 4), visualDensity: VisualDensity.compact);
    return [
      if (todos.isNotEmpty || agent.planMode)
        _Section(
          id: 'progress',
          icon: Icons.checklist_rounded,
          title: '进度',
          trailing: todos.isEmpty ? null : '${todos.where((t) => t.status == 'completed').length} / ${todos.length}',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (agent.planMode) ...[_PlanModeNote(), if (todos.isNotEmpty) const SizedBox(height: 10)],
              if (todos.isNotEmpty) TodoList(todos: todos),
            ],
          ),
        ),
      _Section(
        id: 'steps',
        icon: Icons.timeline,
        title: '步骤',
        trailing: steps.isEmpty ? null : '${steps.length}',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (steps.isEmpty)
              Text(
                running
                    ? '正在思考…'
                    : run == null
                    ? '发出第一条消息后，这里会显示每次运行的步骤、改动的文件、耗时和花费。'
                    : _steps == null
                    ? '正在读取…'
                    : '这次没有调用工具。',
                style: muted,
              ),
            if (hidden > 0)
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton(style: small, onPressed: () => setState(() => _allSteps = true), child: Text('显示前面的 $hidden 步')),
              ),
            ...steps.skip(hidden),
            if (_allSteps && steps.length > shown)
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton(style: small, onPressed: () => setState(() => _allSteps = false), child: const Text('只看最近几步')),
              ),
            if (latest?.error != null && latest?.status == 'failed') ...[
              const SizedBox(height: 6),
              Text(latest!.error!, style: context.text.bodySmall?.copyWith(color: colors.danger)),
            ],
          ],
        ),
      ),
      if (changed.isNotEmpty)
        _Section(
          id: 'files',
          icon: Icons.description_outlined,
          title: '产物与改动',
          trailing: '${changed.length}',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [for (final f in changed) ArtifactTile(path: f, exists: true, onContinue: () => _agent.insertIntoComposer('继续修改 $f：'))],
          ),
        ),
      if (subagents.isNotEmpty || agent.backgroundRunning > 0)
        _Section(
          id: 'background',
          icon: Icons.hub_outlined,
          title: '子 Agent 与后台',
          trailing: subagents.any((t) => t.isActive) || agent.backgroundRunning > 0 ? '进行中' : null,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (final t in subagents) _subagentRow(t),
              if (agent.backgroundRunning > 0)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text('后台还有 ${agent.backgroundRunning} 项工作在进行，结束后 Agent 会接着处理。', style: muted),
                ),
            ],
          ),
        ),
      _Section(
        id: 'cost',
        icon: Icons.data_usage_rounded,
        title: '上下文与花费',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                _ContextGauge(percent: stats.contextKnown && stats.contextWindow > 0 ? stats.contextPercent : null),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    [
                      stats.contextKnown && stats.contextWindow > 0
                          ? '上下文 ${formatTokens(stats.contextTokens)} / ${formatTokens(stats.contextWindow)}'
                          : '上下文用量在下一次回复后显示',
                      '这个会话共花费 ${stats.cost > 0 ? formatCost(stats.cost) : '—'}',
                    ].join('\n'),
                    style: context.text.bodySmall?.copyWith(color: colors.ink2, height: 1.7),
                  ),
                ),
              ],
            ),
            if (latest != null) ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(child: _Fact(label: '上次耗时', value: formatDuration(latest.duration))),
                  const SizedBox(width: 8),
                  Expanded(child: _Fact(label: '上次花费', value: latest.cost > 0 ? formatCost(latest.cost) : '—')),
                ],
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: _Fact(label: '工具调用', value: latest.toolErrors > 0 ? '${latest.toolCalls}（${latest.toolErrors} 出错）' : '${latest.toolCalls}'),
                  ),
                  const SizedBox(width: 8),
                  Expanded(child: _Fact(label: 'Token', value: latest.tokens > 0 ? formatTokens(latest.tokens) : '—')),
                ],
              ),
            ],
          ],
        ),
      ),
      const _Section(id: 'actions', icon: Icons.bolt_outlined, title: '常用操作', child: SessionActions()),
    ];
  }

  Widget _subagentRow(ToolRun t) {
    final role = t.details['roleName'] as String? ?? '子 Agent';
    final what = t.details['description'] as String? ?? t.args['description'] as String? ?? '';
    final cost = (t.details['cost'] as num?)?.toDouble() ?? 0;
    return _StepRow(label: '$role  $what', status: _status(t.status), durationMs: t.durationMs, note: cost > 0 ? formatCost(cost) : null);
  }

  static String _status(ToolStatus status) => switch (status) {
    ToolStatus.error => 'error',
    ToolStatus.done => 'done',
    ToolStatus.interrupted => 'interrupted',
    _ => 'running',
  };

  /// The tool calls of the reply on screen (the latest one), in order.
  List<ToolRun> _replyTools(AgentController agent) {
    final rows = ChatRow.fromItems(agent.transcript.items);
    final reply = rows.lastOrNull is ReplyRow ? rows.last as ReplyRow : null;
    return [
      for (final a in reply?.assistants ?? const <AssistantItem>[])
        for (final part in a.parts.whereType<ToolCallPart>()) ?agent.transcript.tool(part.toolCallId),
    ];
  }

  /// While a run is going, its steps come straight from the transcript.
  List<Widget> _liveStepRows(List<ToolRun> tools) => [
    for (final t in tools) _StepRow(label: _stepLabel(t.name, toolSubject(t)), status: _status(t.status), durationMs: t.durationMs),
  ];

  /// The steps the core recorded for the latest finished run.
  List<Widget> _savedStepRows() => [
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
  ];

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
        // 蝶君 cannot open this machine's paths: only pasted text can be attached here.
        _materials = jsonRows(desk['materials']).map(MaterialInfo.fromJson).where((m) => m.kind == 'text').toList();
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
            child: Text('「工作」里还没有写笺和资料。', style: context.text.bodySmall?.copyWith(color: colors.muted)),
          ),
        const SizedBox(height: 12),
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(onPressed: () => _agent.openButterfly(tab: ButterflyTab.work), icon: const Icon(Icons.edit_note, size: 16), label: const Text('去「工作」')),
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
  const _StepRow({required this.label, required this.status, required this.durationMs, this.note});

  final String label;
  final String? status;
  final int? durationMs;

  /// A short figure after the time (a subagent's cost).
  final String? note;

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
          if (note != null) ...[
            const SizedBox(width: 6),
            Text(note!, style: context.text.bodySmall?.copyWith(color: colors.muted)),
          ],
        ],
      ),
    );
  }
}

/// One block of the details' overview: an icon, a title and a figure on its header,
/// folded or open (remembered for the window's lifetime, across conversations).
class _Section extends StatefulWidget {
  const _Section({required this.id, required this.icon, required this.title, required this.child, this.trailing});

  final String id;
  final IconData icon;
  final String title;
  final String? trailing;
  final Widget child;

  static final _folded = <String>{};

  @override
  State<_Section> createState() => _SectionState();
}

class _SectionState extends State<_Section> {
  bool get _open => !_Section._folded.contains(widget.id);

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final open = _open;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(
        color: colors.card,
        border: Border.all(color: colors.border),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(
            button: true,
            expanded: open,
            child: InkWell(
              borderRadius: BorderRadius.circular(10),
              onTap: () => setState(() => open ? _Section._folded.add(widget.id) : _Section._folded.remove(widget.id)),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
                child: Row(
                  children: [
                    Icon(widget.icon, size: 16, color: colors.ink2),
                    const SizedBox(width: 8),
                    Expanded(child: Text(widget.title, style: context.text.bodySmall?.copyWith(fontWeight: FontWeight.w600, color: colors.ink2))),
                    if (widget.trailing != null) Text(widget.trailing!, style: context.text.bodySmall?.copyWith(color: colors.muted)),
                    const SizedBox(width: 4),
                    Icon(open ? Icons.expand_less : Icons.expand_more, size: 16, color: colors.muted),
                  ],
                ),
              ),
            ),
          ),
          if (open) Padding(padding: const EdgeInsets.fromLTRB(12, 0, 12, 12), child: widget.child),
        ],
      ),
    );
  }
}

/// How full the context window is, as a ring with the percentage (unknown: an empty ring).
class _ContextGauge extends StatelessWidget {
  const _ContextGauge({required this.percent});

  final double? percent;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final value = percent;
    final color = value == null
        ? colors.muted
        : value >= 85
        ? colors.danger
        : value >= 70
        ? colors.warning
        : colors.accent;
    return Semantics(
      label: value == null ? '上下文用量未知' : '上下文已用 ${value.round()}%',
      child: SizedBox.square(
        dimension: 44,
        child: Stack(
          alignment: Alignment.center,
          children: [
            SizedBox.square(
              dimension: 44,
              child: CircularProgressIndicator(value: ((value ?? 0) / 100).clamp(0.0, 1.0), strokeWidth: 4, color: color, backgroundColor: colors.border),
            ),
            ExcludeSemantics(child: Text(value == null ? '—' : '${value.round()}%', style: context.text.labelSmall?.copyWith(color: colors.ink2))),
          ],
        ),
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
