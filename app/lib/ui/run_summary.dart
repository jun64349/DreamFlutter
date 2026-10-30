import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'artifact_widgets.dart';
import 'message_widgets.dart' show ChatRow, ReplyRow, toolSubject;
import 'motion.dart';
import 'task_widgets.dart';
import 'usage_page.dart' show formatCost, formatTokens;

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
      decoration: BoxDecoration(color: colors.sidebar, border: Border(left: BorderSide(color: colors.border, width: 0.5))),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            height: 56,
            child: Padding(
              padding: const EdgeInsets.only(left: 18, right: 8),
              child: Row(
                children: [
                  Text('本次运行', style: context.text.titleMedium?.copyWith(fontSize: 15)),
                  if (running) ...[const SizedBox(width: 10), const BreathingDot(), const SizedBox(width: 6), Text('进行中', style: context.label)],
                  const Spacer(),
                  IconButton(tooltip: '收起右栏', onPressed: widget.onClose, icon: const Icon(Icons.close, size: 18)),
                ],
              ),
            ),
          ),
          Divider(height: 0.5, color: colors.border),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(18, 14, 18, 18),
              children: [
                if (task != null && task.source != 'chat') ...[_TaskCard(task: task), const SizedBox(height: 18)],
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
                      Expanded(child: _Fact(label: '耗时', value: formatDuration(run.duration))),
                      const SizedBox(width: 10),
                      Expanded(child: _Fact(label: '花费', value: run.cost > 0 ? formatCost(run.cost) : '—')),
                    ],
                  ),
                  const SizedBox(height: 10),
                  Row(
                    children: [
                      Expanded(child: _Fact(label: '工具调用', value: run.toolErrors > 0 ? '${run.toolCalls}（${run.toolErrors} 出错）' : '${run.toolCalls}')),
                      const SizedBox(width: 10),
                      Expanded(child: _Fact(label: 'Token', value: run.tokens > 0 ? formatTokens(run.tokens) : '—')),
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
        for (final part in a.parts.whereType<ToolCallPart>())
          ?agent.transcript.tool(part.toolCallId),
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
      'grep' || 'find' => '搜索',
      'ls' => '查看目录',
      'bash' || 'powershell' => '运行',
      'edit' => '修改',
      'write' => '写入',
      'web_fetch' => '读取网页',
      _ => tool,
    };
    return subject == null || subject.isEmpty ? verb : '$verb  $subject';
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
          Container(width: 18, height: 18, decoration: BoxDecoration(color: tint, shape: BoxShape.circle), alignment: Alignment.center, child: mark),
          const SizedBox(width: 10),
          Expanded(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: context.text.bodySmall?.copyWith(fontSize: 13, color: colors.ink))),
          if (durationMs != null) Text(durationMs! < 1000 ? '$durationMs 毫秒' : '${(durationMs! / 1000).toStringAsFixed(1)} 秒', style: context.text.bodySmall?.copyWith(color: colors.muted)),
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
      decoration: BoxDecoration(color: colors.card, border: Border.all(color: colors.border), borderRadius: BorderRadius.circular(AppTokens.radius)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(label, style: context.text.labelSmall?.copyWith(color: colors.muted)),
          const SizedBox(height: 2),
          Text(value, maxLines: 1, overflow: TextOverflow.ellipsis, style: context.serif(context.text.titleMedium).copyWith(fontSize: 17, fontWeight: FontWeight.w600)),
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
      decoration: BoxDecoration(color: colors.card, border: Border.all(color: colors.border), borderRadius: BorderRadius.circular(AppTokens.radius)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('${task.sourceLabel}任务', style: context.label),
          const SizedBox(height: 4),
          Text(task.title, maxLines: 2, overflow: TextOverflow.ellipsis, style: context.text.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
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
