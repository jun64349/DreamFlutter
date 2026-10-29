import 'package:flutter/material.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'artifact_widgets.dart';
import 'task_widgets.dart';
import 'usage_page.dart' show formatCost;

/// One-line summary of the session's last run (steps, time, cost, files),
/// expandable to the step list and the files it wrote.
class RunSummaryCard extends StatefulWidget {
  const RunSummaryCard({super.key, required this.sessionFile});

  final String sessionFile;

  @override
  State<RunSummaryCard> createState() => _RunSummaryCardState();
}

class _RunSummaryCardState extends State<RunSummaryCard> {
  late final AgentController _agent;
  RunInfo? _run;
  List<RunStepInfo>? _steps;
  var _expanded = false;

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
      final rows = jsonRows(await _agent.backend.call('runs.list', {'sessionFile': widget.sessionFile, 'limit': 1}));
      final run = rows.isEmpty ? null : RunInfo.fromJson(rows.first);
      if (run?.id != _run?.id) _steps = null;
      if (mounted) setState(() => _run = run);
      if (_expanded) await _loadSteps();
    } catch (_) {}
  }

  Future<void> _loadSteps() async {
    final run = _run;
    if (run == null) return;
    try {
      final steps = jsonRows(await _agent.backend.call('runs.steps', {'runId': run.id})).map(RunStepInfo.fromJson).toList();
      if (mounted) setState(() => _steps = steps);
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final run = _run;
    if (run == null || run.status == 'running') return const SizedBox();
    final colors = context.colors;
    final muted = context.text.bodySmall?.copyWith(color: colors.muted);
    final facts = [
      if (run.toolCalls > 0) '${run.toolCalls} 次工具调用${run.toolErrors > 0 ? '（${run.toolErrors} 次出错）' : ''}',
      formatDuration(run.duration),
      if (run.cost > 0) formatCost(run.cost),
      if (run.files.isNotEmpty) '改动 ${run.files.length} 个文件',
    ];
    return Container(
      decoration: BoxDecoration(border: Border.all(color: colors.border), borderRadius: BorderRadius.circular(AppTokens.radius)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(AppTokens.radius),
            onTap: () {
              setState(() => _expanded = !_expanded);
              if (_expanded && _steps == null) _loadSteps();
            },
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppTokens.pad, vertical: 6),
              child: Row(
                children: [
                  Icon(run.status == 'failed' ? Icons.error_outline : Icons.receipt_long_outlined, size: 16, color: run.status == 'failed' ? colors.danger : colors.muted),
                  const SizedBox(width: AppTokens.gap),
                  Expanded(child: Text('本次运行：${facts.join(' · ')}', style: muted, overflow: TextOverflow.ellipsis)),
                  Icon(_expanded ? Icons.expand_less : Icons.expand_more, size: 16, color: colors.muted),
                ],
              ),
            ),
          ),
          if (_expanded) ...[
            const Divider(),
            Padding(
              padding: const EdgeInsets.all(AppTokens.pad),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (_steps == null) const LinearProgressIndicator(),
                  if (_steps != null && _steps!.isEmpty) Text('这次没有调用工具。', style: muted),
                  for (final s in _steps ?? const <RunStepInfo>[])
                    Padding(
                      padding: const EdgeInsets.only(bottom: 2),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Icon(
                            s.status == 'error' ? Icons.close : s.status == 'interrupted' ? Icons.remove : Icons.check,
                            size: 14,
                            color: s.status == 'error' ? colors.danger : colors.muted,
                          ),
                          const SizedBox(width: 6),
                          Expanded(
                            child: Text(
                              '${switch (s.kind) { 'retry' => '重试', 'compaction' => '压缩上下文', 'error' => '错误', _ => s.name ?? '' }}  ${s.summary ?? ''}',
                              style: context.text.bodySmall,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          if (s.durationMs != null) Text(' ${(s.durationMs! / 1000).toStringAsFixed(1)}s', style: muted),
                        ],
                      ),
                    ),
                  if (run.files.isNotEmpty) ...[
                    const SizedBox(height: AppTokens.gap),
                    Text('改动的文件', style: context.text.labelMedium),
                    const SizedBox(height: 4),
                    for (final f in run.files)
                      ArtifactTile(
                        path: f,
                        exists: true,
                        onContinue: () => _agent.insertIntoComposer('继续修改 $f：'),
                      ),
                  ],
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// Shown above the conversation when the session runs a desk or template
/// task: its title, status, and a link to the details.
class TaskBanner extends StatefulWidget {
  const TaskBanner({super.key, required this.sessionFile});

  final String sessionFile;

  @override
  State<TaskBanner> createState() => _TaskBannerState();
}

class _TaskBannerState extends State<TaskBanner> {
  late final AgentController _agent;
  TaskInfo? _task;

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
      final row = await _agent.backend.call('tasks.forSession', {'sessionFile': widget.sessionFile});
      final task = row is Map ? TaskInfo.fromJson(row.cast<String, dynamic>()) : null;
      if (mounted) setState(() => _task = task);
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final task = _task;
    if (task == null || task.source == 'chat') return const SizedBox();
    final colors = context.colors;
    return Container(
      margin: const EdgeInsets.fromLTRB(AppTokens.padLg, AppTokens.pad, AppTokens.padLg, 0),
      padding: const EdgeInsets.symmetric(horizontal: AppTokens.pad, vertical: 6),
      decoration: BoxDecoration(color: Theme.of(context).colorScheme.primary.withValues(alpha: 0.06), borderRadius: BorderRadius.circular(AppTokens.radius)),
      child: Row(
        children: [
          Icon(Icons.task_alt, size: 16, color: Theme.of(context).colorScheme.primary),
          const SizedBox(width: AppTokens.gap),
          Text('${task.sourceLabel}任务', style: context.text.labelMedium),
          const SizedBox(width: AppTokens.gap),
          Expanded(child: Text(task.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: context.text.bodySmall)),
          TaskStatusChip(status: task.status),
          TextButton(onPressed: () => showTaskDetails(context, task), child: Text('详情', style: TextStyle(color: colors.muted))),
        ],
      ),
    );
  }
}
