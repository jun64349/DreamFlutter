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
import 'common.dart';
import 'greetings.dart';
import 'shell_widgets.dart';

/// 蝶君's empty page (0.8.3): the greeting and a few things to hand over. Its conversations are in the
/// sidebar; what needs you is in 「等你处理」, so there are no task cards or state pills here.
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
    return ShellColumn(children: [
      Column(children: [
        const SizedBox(height: 12),
        const ButterflyAvatar(size: 56, activity: ButterflyActivity.idle),
        const SizedBox(height: 18),
        const ShellGreeting('交给我吧，你去忙别的', size: 30),
        const SizedBox(height: 18),
        ShellQuoteLine(line, source),
        const SizedBox(height: 18),
        Wrap(alignment: WrapAlignment.center, spacing: 8, runSpacing: 8, children: [
          for (final example in examples)
            ShellExample(example, onPressed: tasks.preparing ? null : () => tasks.worker?.insertIntoComposer(example)),
        ]),
        const SizedBox(height: 6),
      ]),
    ]);
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
  // 0.8.2 (user test): the summary is 蝶君's last reply, already in the
  // conversation below (it showed twice, the first time as raw Markdown).
  // The card keeps what the conversation does not: the files, time and cost.
  @override
  Widget build(BuildContext context) {
    final files = memoryRows(delivery['files']);
    final meta = context.text.bodySmall?.copyWith(color: context.colors.muted);
    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.fromLTRB(16, 10, 10, 10),
      decoration: BoxDecoration(
        color: context.colors.card,
        border: Border(left: BorderSide(color: context.colors.success, width: 3)),
        borderRadius: BorderRadius.circular(context.radiusSm),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(children: [
            Icon(Icons.task_alt, size: 18, color: context.colors.success),
            const SizedBox(width: 8),
            Text('交付', style: context.text.titleSmall),
            const Spacer(),
            Text(
              '${formatDuration(Duration(milliseconds: (delivery['durationMs'] as num?)?.toInt() ?? 0))} · \$${((delivery['cost'] as num?)?.toDouble() ?? 0).toStringAsFixed(3)}',
              style: meta,
            ),
          ]),
          for (final file in files) ButterflyDeliveryFile(file: file, agent: agent),
        ],
      ),
    );
  }
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
      padding: const EdgeInsets.only(top: 6),
      child: Row(
        children: [
          Icon(fileIcon(path), size: 20, color: fileTypeColor(context, path)),
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

/// 蝶君's right panel, 「这个对话」 like the workbench's (0.8.3): what this conversation handed over
/// and its schedules. No state pills: a failure shows in the conversation, a question in 「等你处理」.
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
              Expanded(child: Text('这个对话', style: context.text.titleSmall)),
              IconButton(
                tooltip: '收起详情',
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
    final delivery = memoryMap(task?['delivery']);
    final worker = tasks.worker;
    final schedules = task == null ? const <Json>[] : tasks.schedules.where(
      (s) =>
          s['id'] == task['scheduleId'] ||
          task['sessionFile'] != null &&
              s['sessionFile'] == task['sessionFile'],
    ).toList();
    return ListView(
      padding: const EdgeInsets.all(18),
      children: [
        if (delivery.isNotEmpty && worker != null)
          ButterflyDelivery(delivery: delivery, agent: worker)
        else
          Text('这段对话还没有交付的文件', style: context.text.bodySmall?.copyWith(color: context.colors.muted)),
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
