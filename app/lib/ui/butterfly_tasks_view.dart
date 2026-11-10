import 'dart:io';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../state/butterfly_tasks.dart';
import '../state/memory_ui.dart';
import '../theme.dart';
import 'artifact_widgets.dart';
import 'butterfly_motion.dart';
import 'butterfly_start_button.dart';
import 'common.dart';
import 'greetings.dart';
import 'motion.dart';

Color taskColor(BuildContext context, Json task) => switch (task['status']) {
  'waiting' => context.colors.warning,
  'completed' => context.colors.success,
  'failed' => context.colors.danger,
  _ => context.colors.accent,
};

class ButterflyTaskStatus extends StatelessWidget {
  const ButterflyTaskStatus({super.key, required this.task});
  final Json task;
  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      Icon(Icons.circle, size: 6, color: taskColor(context, task)),
      const SizedBox(width: 7),
      Text(
        butterflyTaskLabel(task),
        style: context.text.bodySmall?.copyWith(
          color: taskColor(context, task),
        ),
      ),
    ],
  );
}

class ButterflyTasksHome extends StatelessWidget {
  const ButterflyTasksHome({super.key, required this.tasks});
  final ButterflyTasks tasks;
  static const examples = [
    '每周一帮我整理上周的组会纪要',
    '把这 30 篇文献统一成 GB/T 7714 格式',
    '查一下三款温湿度传感器，列个对比表',
  ];
  @override
  Widget build(BuildContext context) {
    final (line, source) = pickLiteraryLine(DateTime.now().day);
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(28, 24, 28, 28),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 800),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Center(
                child: ButterflyAvatar(
                  size: 58,
                  activity: tasks.tasks.any((t) => t['status'] == 'in_progress')
                      ? ButterflyActivity.working
                      : tasks.tasks.any((t) => t['status'] == 'waiting')
                      ? ButterflyActivity.waiting
                      : ButterflyActivity.idle,
                ),
              ),
              const SizedBox(height: 14),
              Text(
                '交给我吧，你去忙别的',
                textAlign: TextAlign.center,
                style: context.handwriting(context.text.headlineMedium),
              ),
              const SizedBox(height: 16),
              Text(
                '$line  $source',
                textAlign: TextAlign.center,
                style: context
                    .serif(context.text.bodySmall)
                    .copyWith(color: context.colors.muted, height: 1.8),
              ),
              const SizedBox(height: 20),
              Wrap(
                alignment: WrapAlignment.center,
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final example in examples)
                    OutlinedButton(
                      onPressed: tasks.preparing
                          ? null
                          : () => tasks.worker?.insertIntoComposer(example),
                      child: Text(example),
                    ),
                ],
              ),
              const SizedBox(height: 28),
              if (tasks.tasks.isNotEmpty) ...[
                Text(
                  '正在做和最近做完的',
                  style: context.text.titleSmall?.copyWith(
                    color: context.colors.muted,
                  ),
                ),
                const SizedBox(height: 10),
              ],
              MotionRows(children: [for (final task in tasks.tasks)
                  KeyedSubtree(
                    key: ValueKey(task['id']),
                    child: ButterflyTaskRow(
                      task: task,
                      onTap: () => tasks.open(task),
                    ),
                  ),]),
            ],
          ),
        ),
      ),
    );
  }
}

class ButterflyTaskRow extends StatelessWidget {
  const ButterflyTaskRow({super.key, required this.task, required this.onTap});
  final Json task;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => InkWell(
    onTap: onTap,
    borderRadius: BorderRadius.circular(context.radius),
    child: Container(
      padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 12),
      decoration: BoxDecoration(
        border: Border(
          bottom: BorderSide(color: context.colors.border, width: 0.5),
        ),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  task['title'] as String? ?? '任务',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                if ((task['progress'] as String? ?? '').isNotEmpty && task['progress'] != butterflyTaskLabel(task)) ...[
                  const SizedBox(height: 5),
                  Text(
                  task['progress'] as String? ?? '',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: context.text.bodySmall?.copyWith(
                    color: context.colors.muted,
                  ),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(width: 16),
          ButterflyTaskStatus(task: task),
        ],
      ),
    ),
  );
}

class ButterflyTaskHeader extends StatelessWidget {
  const ButterflyTaskHeader({super.key, required this.tasks});
  final ButterflyTasks tasks;
  Future<void> _act(
    BuildContext context,
    Future<void> Function() action,
  ) async {
    try {
      await action();
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('没有完成：${SessionRuntime.describeError(e)}')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final task = tasks.selected!;
    final intent = memoryMap(task['intent']);
    final delivery = memoryMap(task['delivery']);
    return ConstrainedBox(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * 0.56,
      ),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(24, 14, 24, 10),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 860),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    IconButton(
                      tooltip: '蝶君首页',
                      onPressed: tasks.newTask,
                      icon: const Icon(Icons.arrow_back, size: 19),
                    ),
                    Expanded(
                      child: Text(
                        task['title'] as String? ?? '任务',
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: context.text.titleMedium,
                      ),
                    ),
                    const SizedBox(width: 12),
                    ButterflyTaskStatus(task: task),
                  ],
                ),
                if (intent.isNotEmpty)
                  Container(
                    margin: const EdgeInsets.only(top: 8),
                    padding: const EdgeInsets.all(18),
                    decoration: BoxDecoration(
                      color: context.colors.accentSoft,
                      borderRadius: BorderRadius.circular(context.radius),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          intent['restatement'] as String? ?? '',
                          style: context.text.titleLarge,
                        ),
                        const SizedBox(height: 8),
                        Text(
                          intent['plan'] as String? ?? '',
                          style: context.text.bodyMedium?.copyWith(height: 1.6),
                        ),
                        if (intent['missing'] != null)
                          Padding(
                            padding: const EdgeInsets.only(top: 10),
                            child: Text(intent['missing'] as String),
                          ),
                        const SizedBox(height: 10),
                        Wrap(
                          spacing: 10,
                          children: [
                            if (intent['state'] != 'needs_input')
                              ButterflyStartButton(
                                intent: intent,
                                onPressed: tasks.preparing
                                    ? null
                                    : () => _act(
                                        context,
                                        () => tasks.start(intent),
                                      ),
                              ),
                            TextButton(
                              onPressed: tasks.preparing
                                  ? null
                                  : () => _act(
                                      context,
                                      () => tasks.cancel(intent),
                                    ),
                              child: const Text('取消'),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                if (delivery.isNotEmpty)
                  ButterflyDelivery(delivery: delivery, agent: tasks.worker!),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class ButterflyDelivery extends StatelessWidget {
  const ButterflyDelivery({
    super.key,
    required this.delivery,
    required this.agent,
  });
  final Json delivery;
  final AgentController agent;
  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.only(top: 12),
    padding: const EdgeInsets.all(20),
    decoration: BoxDecoration(
      border: Border.all(color: context.colors.accent.withValues(alpha: 0.45)),
      borderRadius: BorderRadius.circular(context.radius),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('交付', style: context.text.titleLarge),
        const SizedBox(height: 10),
        Text(
          delivery['summary'] as String? ?? '',
          style: context.text.bodyMedium?.copyWith(height: 1.7),
        ),
        for (final file in memoryRows(delivery['files']))
          ButterflyDeliveryFile(file: file, agent: agent),
        const SizedBox(height: 12),
        Text(
          '${formatDuration(Duration(milliseconds: (delivery['durationMs'] as num?)?.toInt() ?? 0))} · \$${((delivery['cost'] as num?)?.toDouble() ?? 0).toStringAsFixed(3)}',
          style: context.text.bodySmall?.copyWith(color: context.colors.muted),
        ),
      ],
    ),
  );
}

class ButterflyDeliveryFile extends StatelessWidget {
  const ButterflyDeliveryFile({
    super.key,
    required this.file,
    required this.agent,
  });
  final Json file;
  final AgentController agent;
  Future<void> _act(BuildContext context, String action) async {
    final path = file['path'] as String;
    try {
      if (action == 'preview') {
        await showFilePreview(context, path);
      } else if (action == 'open') {
        await agent.openFile(path);
      } else {
        final location = await getSaveLocation(suggestedName: p.basename(path));
        if (location != null && !SessionStore.samePath(location.path, path)) {
          await File(path).copy(location.path);
        }
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('文件暂时打不开：${SessionRuntime.describeError(e)}')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final path = file['path'] as String? ?? '';
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Row(
        children: [
          Icon(fileIcon(path), size: 20, color: context.colors.muted),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              p.basename(path),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          PopupMenuButton<String>(
            tooltip: '交付物操作',
            onSelected: (a) => _act(context, a),
            itemBuilder: (_) => [
              if (canPreview(path))
                const PopupMenuItem(value: 'preview', child: Text('预览')),
              const PopupMenuItem(value: 'open', child: Text('打开')),
              const PopupMenuItem(value: 'save', child: Text('另存为')),
            ],
          ),
        ],
      ),
    );
  }
}

class ButterflyTaskProgress extends StatelessWidget {
  const ButterflyTaskProgress({super.key, required this.tasks});
  final ButterflyTasks tasks;
  @override
  Widget build(BuildContext context) => ColoredBox(
    color: context.colors.sidebar,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(18, 10, 8, 0),
          child: Row(
            children: [
              Expanded(child: Text('任务进度', style: context.text.titleSmall)),
              IconButton(
                tooltip: '收起任务进度',
                onPressed: () => tasks.worker?.setRunPanelOpen(false),
                icon: const Icon(Icons.close, size: 18),
              ),
            ],
          ),
        ),
        Expanded(child: _content(context)),
      ],
    ),
  );
  Widget _content(BuildContext context) {
    final task = tasks.selected;
    if (task == null) {
      return ListView(
        padding: const EdgeInsets.all(18),
        children: [
          for (final t in tasks.tasks)
            ButterflyTaskRow(task: t, onTap: () => tasks.open(t)),
        ],
      );
    }
    final schedules = tasks.schedules.where(
      (s) =>
          s['id'] == task['scheduleId'] ||
          task['sessionFile'] != null &&
              s['sessionFile'] == task['sessionFile'],
    );
    return ListView(
      padding: const EdgeInsets.all(18),
      children: [
        Text(task['title'] as String? ?? '', style: context.text.titleMedium),
        const SizedBox(height: 12),
        ButterflyTaskStatus(task: task),
        const SizedBox(height: 12),
        Text(
          task['progress'] as String? ?? '',
          style: context.text.bodyMedium?.copyWith(height: 1.6),
        ),
        if (task['error'] != null)
          Padding(
            padding: const EdgeInsets.only(top: 14),
            child: Text(
              task['error'] as String,
              style: TextStyle(color: context.colors.danger),
            ),
          ),
        if (task['status'] == 'waiting' && memoryMap(task['intent']).isEmpty)
          TextButton(
            onPressed: () => tasks.root.showSection(AppSection.tasks),
            child: const Text('等你处理'),
          ),
        for (final s in schedules)
          Padding(
            padding: const EdgeInsets.only(top: 28),
            child: ButterflySchedule(schedule: s, tasks: tasks),
          ),
      ],
    );
  }
}

class ButterflySchedule extends StatelessWidget {
  const ButterflySchedule({
    super.key,
    required this.schedule,
    required this.tasks,
  });
  final Json schedule;
  final ButterflyTasks tasks;
  @override
  Widget build(BuildContext context) {
    final active = schedule['status'] == 'active';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          schedule['name'] as String? ?? '定时任务',
          style: context.text.titleSmall,
        ),
        const SizedBox(height: 8),
        Text(
          schedule['status'] == 'paused'
              ? '已暂停'
              : schedule['nextRunAt'] == null
              ? '没有下一次安排'
              : '下次 ${formatDate((schedule['nextRunAt'] as num).toInt())}',
          style: context.text.bodySmall?.copyWith(color: context.colors.muted),
        ),
        Wrap(
          spacing: 6,
          children: [
            TextButton(
              onPressed: () async {
                try {
                  await tasks.changeSchedule(
                    schedule['id'] as String,
                    active ? 'paused' : 'active',
                  );
                } catch (e) {
                  if (context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(content: Text(SessionRuntime.describeError(e))),
                    );
                  }
                }
              },
              child: Text(active ? '暂停' : '继续'),
            ),
            TextButton(
              onPressed: () async {
                final confirmed = await showDialog<bool>(context: context, builder: (dialogContext) => AlertDialog(
                  title: const Text('删除定时任务？'),
                  content: const Text('删除后不能撤销。'),
                  actions: [TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('取消')), FilledButton(style: FilledButton.styleFrom(backgroundColor: context.colors.danger, foregroundColor: context.colors.onAccent), onPressed: () => Navigator.pop(dialogContext, true), child: const Text('删除'))],
                ));
                if (confirmed != true) return;
                try {
                  await tasks.changeSchedule(schedule['id'] as String, null);
                  if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已删除')));
                } catch (e) {
                  if (context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(content: Text(SessionRuntime.describeError(e))),
                    );
                  }
                }
              },
              child: const Text('删除'),
            ),
          ],
        ),
      ],
    );
  }
}
