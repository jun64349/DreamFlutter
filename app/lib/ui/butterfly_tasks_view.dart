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
import 'common.dart';
import 'composer.dart';
import 'details_panel_widgets.dart';
import 'greetings.dart';
import 'proto_icon.dart';
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
    '把这份资料整理成摘要',
    '明天下午三点提醒我交报告',
  ];
  @override
  Widget build(BuildContext context) {
    final (line, source) = pickLiteraryLine(DateTime.now().day);
    return Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 30, 20, 60),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const HomeButterflyMark(),
            const SizedBox(height: 14),
            const ShellGreeting('交给我吧，你去忙别的', size: 34),
            const SizedBox(height: 16),
            Container(width: 120, height: 10, decoration: BoxDecoration(borderRadius: const BorderRadius.all(Radius.elliptical(60, 5)), gradient: LinearGradient(colors: [context.colors.accentSoft.withValues(alpha: 0), context.colors.accentSoft, context.colors.accentSoft.withValues(alpha: 0)]))),
            const SizedBox(height: 14),
            ShellQuoteLine(line, source),
            const SizedBox(height: 22),
            const Composer(home: true),
            const SizedBox(height: 14),
            ConstrainedBox(constraints: const BoxConstraints(maxWidth: homeContentMaxWidth), child: Wrap(alignment: WrapAlignment.center, spacing: 8, runSpacing: 8, children: [
              for (final example in examples)
                ShellExample(example, onPressed: tasks.preparing ? null : () => tasks.worker?.insertIntoComposer(example)),
            ])),
          ]),
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
  // 0.8.2 (user test): the summary is 蝶君's last reply, already in the
  // conversation below (it showed twice, the first time as raw Markdown).
  // The card keeps what the conversation does not: the files, time and cost.
  @override
  Widget build(BuildContext context) {
    final files = memoryRows(delivery['files']);
    return DetailsPanelCard(
      icon: 'check',
      title: '交付',
      trailing: Text('${formatDuration(Duration(milliseconds: (delivery['durationMs'] as num?)?.toInt() ?? 0))} · \$${((delivery['cost'] as num?)?.toDouble() ?? 0).toStringAsFixed(3)}'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [for (final file in files) ButterflyDeliveryFile(file: file, agent: agent)],
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
            tooltip: '更多',
            icon: ProtoIcon('more', color: context.colors.ink2),
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
  const ButterflyTaskProgress({super.key, required this.tasks, this.leadingSections, this.captionInset = 0});
  final ButterflyTasks tasks;
  final Widget? leadingSections;
  final double captionInset;
  @override
  Widget build(BuildContext context) => ColoredBox(
    color: context.colors.sidebar,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DetailsPanelHeading(captionInset: captionInset, onClose: () => tasks.worker?.setRunPanelOpen(false)),
        Expanded(child: _content(context)),
      ],
    ),
  );
  Widget _content(BuildContext context) {
    final worker = tasks.worker;
    final sessionFile = worker?.currentSessionPath;
    bool inConversation(Object? file) => sessionFile != null && sessionFile.isNotEmpty &&
        file is String && file.isNotEmpty && SessionStore.samePath(file, sessionFile);
    final delivery = memoryMap(tasks.selected?['delivery']);
    final scheduleIds = {
      for (final task in tasks.tasks)
        if (inConversation(task['sessionFile']) && task['scheduleId'] is String) task['scheduleId'] as String,
    };
    final schedules = [
      for (final schedule in tasks.schedules)
        if (inConversation(schedule['sessionFile']) || scheduleIds.contains(schedule['id'])) schedule,
    ];
    final muted = context.text.bodySmall?.copyWith(fontSize: 12.5, color: context.colors.muted);
    return ListView(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
      children: [
        ?leadingSections,
        if (delivery.isNotEmpty && worker != null)
          ButterflyDelivery(delivery: delivery, agent: worker)
        else
          DetailsPanelCard(icon: 'check', title: '交付', trailing: const Text('还没有'),
            child: Text('做完会出现在这里，蝶君核对过才算交付。', style: muted)),
        DetailsPanelCard(icon: 'clock', title: '定时', child: schedules.isEmpty
          ? Text('这段对话还没有定时安排', style: muted)
          : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              for (final (i, schedule) in schedules.indexed) ...[
                if (i > 0) Divider(height: 1, color: context.colors.hairline),
                ButterflySchedule(schedule: schedule, tasks: tasks),
              ],
            ])),
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
    final note = schedule['status'] == 'paused'
          ? '已暂停'
          : schedule['nextRunAt'] == null
          ? '没有下一次安排'
          : formatDate((schedule['nextRunAt'] as num).toInt());
    final colors = context.colors;
    final text = context.text.bodySmall?.copyWith(fontSize: 12.5);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Padding(padding: const EdgeInsets.symmetric(vertical: 2), child: Row(children: [
        Expanded(child: Text(schedule['name'] as String? ?? '定时任务', style: text?.copyWith(color: colors.muted))),
        const SizedBox(width: 10),
        Text(note, style: text?.copyWith(color: colors.ink)),
      ])),
      Wrap(
          spacing: 6,
          children: [
            ShellButton(active ? '暂停' : '继续', small: true,
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
            ),
            ShellButton('删除', kind: ShellButtonKind.ghost, small: true,
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
            ),
          ],
      ),
    ]);
  }
}
