import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'artifact_widgets.dart';
import 'common.dart';
import 'dashboard_page.dart' show formatCost;

class TaskStatusChip extends StatelessWidget {
  const TaskStatusChip({super.key, required this.status});

  final TaskStatus status;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final color = switch (status) {
      TaskStatus.running || TaskStatus.waiting => Theme.of(context).colorScheme.primary,
      TaskStatus.needsInput => colors.warning,
      TaskStatus.done || TaskStatus.noChange => colors.success,
      TaskStatus.failed => colors.danger,
      TaskStatus.interrupted => colors.muted,
    };
    return TagChip(status.label, color: color);
  }
}

/// One task: status, title, source, where and how long; tap for details.
class TaskTile extends StatelessWidget {
  const TaskTile({super.key, required this.task, this.compact = false, this.showWorkspace = false});

  final TaskInfo task;
  final bool compact;
  final bool showWorkspace;

  @override
  Widget build(BuildContext context) {
    final muted = context.text.bodySmall?.copyWith(color: context.colors.muted);
    final facts = [
      task.sourceLabel,
      if (showWorkspace) p.basename(task.cwd),
      if (task.duration > Duration.zero) formatDuration(task.duration),
      if (task.cost > 0) formatCost(task.cost),
      formatDate(task.updatedAt?.millisecondsSinceEpoch),
    ];
    return InkWell(
      borderRadius: BorderRadius.circular(context.radius),
      onTap: () => showTaskDetails(context, task),
      child: OutlinedCard(
        highlight: task.status == TaskStatus.needsInput ? context.colors.warning : null,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(child: Text(task.title, maxLines: compact ? 2 : 1, overflow: TextOverflow.ellipsis)),
                const SizedBox(width: AppTokens.gap),
                TaskStatusChip(status: task.status),
              ],
            ),
            if (task.status == TaskStatus.running && task.currentStep != null) ...[
              const SizedBox(height: 4),
              Text('正在：${task.currentStep}', maxLines: 1, overflow: TextOverflow.ellipsis, style: muted),
            ],
            const SizedBox(height: 4),
            Text(facts.where((f) => f.isNotEmpty).join(' · '), maxLines: 1, overflow: TextOverflow.ellipsis, style: muted),
          ],
        ),
      ),
    );
  }
}

/// Goal, result, runs and artifacts of a task, with "open" and "continue".
Future<void> showTaskDetails(BuildContext context, TaskInfo task) async {
  final agent = AgentScope.read(context);
  List<RunInfo> runs = const [];
  List<ArtifactInfo> artifacts = const [];
  var current = task;
  try {
    final detail = asJsonMap(await agent.backend.call('tasks.get', {'id': task.id}));
    current = TaskInfo.fromJson(asJsonMap(detail['task']));
    runs = jsonRows(detail['runs']).map(RunInfo.fromJson).toList();
    artifacts = jsonRows(detail['artifacts']).map(ArtifactInfo.fromJson).toList();
  } catch (_) {}
  if (!context.mounted) return;
  await showDialog<void>(
    context: context,
    builder: (context) {
      final muted = context.text.bodySmall?.copyWith(color: context.colors.muted);
      return AlertDialog(
        title: Row(
          children: [
            Expanded(child: Text(current.title, maxLines: 2, overflow: TextOverflow.ellipsis)),
            const SizedBox(width: AppTokens.gap),
            TaskStatusChip(status: current.status),
          ],
        ),
        content: SizedBox(
          width: 640,
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${current.sourceLabel} · ${current.cwd} · 运行 ${current.runs} 次 · ${formatDuration(current.duration)}'
                  '${current.cost > 0 ? ' · ${formatCost(current.cost)}' : ''}',
                  style: muted,
                ),
                const SectionTitle('目标'),
                SelectableText(current.goal.length > 1200 ? '${current.goal.substring(0, 1200)}…' : current.goal),
                if ((current.result ?? '').isNotEmpty) ...[const SectionTitle('结果'), SelectableText(current.result!)],
                if ((current.error ?? '').isNotEmpty) ...[
                  const SectionTitle('错误'),
                  SelectableText(current.error!, style: TextStyle(color: context.colors.danger)),
                ],
                if (artifacts.isNotEmpty) ...[
                  SectionTitle('产物', count: artifacts.length),
                  for (final a in artifacts) ArtifactTile(path: a.path, exists: a.exists),
                ],
                if (runs.isNotEmpty) ...[
                  SectionTitle('运行记录', count: runs.length),
                  for (final r in runs)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 4),
                      child: Text(
                        '${formatDate(r.startedAt?.millisecondsSinceEpoch)} · ${_runStatus(r.status)} · ${r.turns} 轮 · ${r.toolCalls} 次工具调用'
                        '${r.cost > 0 ? ' · ${formatCost(r.cost)}' : ''}${r.error != null ? ' · ${r.error}' : ''}',
                        style: muted,
                      ),
                    ),
                ],
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () async {
              Navigator.pop(context);
              if (await confirmAction(context, title: '从列表中移除这个任务？', message: '只删除任务记录，会话和文件都会保留。', confirm: '移除')) {
                await agent.backend.call('tasks.remove', {'id': current.id});
              }
            },
            child: const Text('移除记录'),
          ),
          OutlinedButton(
            onPressed: current.sessionFile == null
                ? null
                : () {
                    Navigator.pop(context);
                    agent.continueWork(sessionFile: current.sessionFile, cwd: current.cwd, text: '在刚才的基础上继续：');
                  },
            child: const Text('继续处理'),
          ),
          FilledButton(
            onPressed: current.sessionFile == null
                ? null
                : () {
                    Navigator.pop(context);
                    agent.openTask(current);
                  },
            child: const Text('打开会话'),
          ),
        ],
      );
    },
  );
}

String _runStatus(String status) =>
    switch (status) { 'done' => '完成', 'failed' => '失败', 'aborted' => '已停止', 'interrupted' => '中断', 'running' => '运行中', _ => status };
