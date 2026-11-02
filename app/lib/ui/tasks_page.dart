import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'common.dart';
import 'schedules.dart';
import 'sidebar.dart' show WorkspaceSwitcher;
import 'task_widgets.dart';

enum _Filter {
  all('全部', null),
  active('进行中', ['waiting', 'running', 'needs_input']),
  done('已完成', ['done', 'no_change']),
  problems('失败或中断', ['failed', 'interrupted']);

  const _Filter(this.label, this.statuses);
  final String label;
  final List<String>? statuses;
}

/// Everything waiting for the user (the inbox), the task history and the
/// scheduled tasks, as sections in a left panel.
class TasksPage extends StatefulWidget {
  const TasksPage({super.key});

  @override
  State<TasksPage> createState() => _TasksPageState();
}

class _TasksPageState extends State<TasksPage> {
  late final AgentController _agent;
  List<InboxItem> _inbox = const [];
  List<TaskInfo> _tasks = const [];
  var _scheduleCount = 0;
  var _section = 0;
  var _filter = _Filter.all;
  var _allWorkspaces = false;
  String? _error;
  var _loading = true;

  @override
  void initState() {
    super.initState();
    _agent = AgentScope.read(context);
    _agent.workRevision.addListener(_load);
    _agent.libraryRevision.addListener(_load);
    _load();
  }

  @override
  void dispose() {
    _agent.workRevision.removeListener(_load);
    _agent.libraryRevision.removeListener(_load);
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final results = await Future.wait([
        _agent.backend.call('inbox.list'),
        _agent.backend.call('tasks.list', {if (!_allWorkspaces) 'cwd': _agent.workspace, 'status': ?_filter.statuses, 'limit': 200}),
        _agent.backend.call('schedules.list'),
      ]);
      _inbox = jsonRows(results[0]).map(InboxItem.fromJson).toList();
      _tasks = jsonRows(results[1]).map(TaskInfo.fromJson).toList();
      _scheduleCount = jsonRows(results[2]).length;
      _error = null;
    } catch (e) {
      _error = SessionRuntime.describeError(e);
    }
    if (mounted) setState(() => _loading = false);
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return SectionedPage(
      title: '任务',
      header: WorkspaceSwitcher(key: ValueKey(_agent.workspace), compact: true),
      items: [
        SideNavItem('待处理', Icons.inbox_outlined, count: _inbox.length, alert: true),
        SideNavItem('全部任务', Icons.task_alt, count: _tasks.length),
        SideNavItem('定时', Icons.schedule, count: _scheduleCount),
      ],
      selected: _section,
      onSelect: (i) => setState(() => _section = i),
      panel: [
        if (_section == 1) ...[
          const PanelLabel('筛选'),
          for (final f in _Filter.values)
            FilterRow(
              label: f.label,
              selected: f == _filter,
              onTap: () {
                setState(() => _filter = f);
                _load();
              },
            ),
          const SizedBox(height: AppTokens.gap),
          SwitchListTile(
            dense: true,
            contentPadding: const EdgeInsets.symmetric(horizontal: 10),
            title: Text('所有工作区', style: context.text.bodyMedium),
            value: _allWorkspaces,
            onChanged: (v) {
              setState(() => _allWorkspaces = v);
              _load();
            },
          ),
        ],
      ],
      child: _error != null
          ? Center(
              child: Text(_error!, style: TextStyle(color: colors.danger)),
            )
          : _loading
          ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
          : switch (_section) {
              0 => _inboxSection(),
              1 => _tasksSection(),
              _ => const SchedulesTab(),
            },
    );
  }

  Widget _inboxSection() {
    return PageBody(
      children: [
        const ContentHeader(title: '待处理', description: '等你批准的操作、要你补充的信息、被上限暂停或中断的任务，以及候选记忆和技能建议，都集中在这里。'),
        if (_inbox.isEmpty) const EmptyState(title: '没有等你处理的事', message: 'Agent 需要你点头或补充信息时，会出现在这里。'),
        for (final item in _inbox) InboxCard(key: ValueKey('${item.kind}-${item.id}'), item: item, onDone: _load),
      ],
    );
  }

  Widget _tasksSection() {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    String group(TaskInfo t) {
      final at = t.updatedAt;
      if (at == null || at.isBefore(today.subtract(const Duration(days: 6)))) return '更早';
      if (!at.isBefore(today)) return '今天';
      if (!at.isBefore(today.subtract(const Duration(days: 1)))) return '昨天';
      return '这一周';
    }

    final groups = <String, List<TaskInfo>>{};
    for (final t in _tasks) {
      groups.putIfAbsent(group(t), () => []).add(t);
    }
    return PageBody(
      children: [
        ContentHeader(title: '全部任务', description: '每个会话、写笺和模板运行都是一个任务。点开看目标、结果、产物和每次运行。${_filter == _Filter.all ? '' : '（只看「${_filter.label}」）'}'),
        if (_tasks.isEmpty) EmptyState(title: _allWorkspaces ? '还没有任务' : '这个工作区还没有任务', message: '在工作台里提一个要求，或者在「蝶君 › 工作」里把写笺交给蝶君。'),
        for (final e in groups.entries) ...[
          PanelLabel(e.key, count: e.value.length),
          for (final t in e.value) TaskTile(task: t, showWorkspace: _allWorkspaces),
        ],
      ],
    );
  }
}

/// One inbox item with the actions it needs.
class InboxCard extends StatefulWidget {
  const InboxCard({super.key, required this.item, required this.onDone});

  final InboxItem item;
  final VoidCallback onDone;

  @override
  State<InboxCard> createState() => _InboxCardState();
}

class _InboxCardState extends State<InboxCard> {
  final _answer = TextEditingController();
  var _busy = false;

  @override
  void dispose() {
    _answer.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() => _busy = true);
    await action();
    if (mounted) setState(() => _busy = false);
    widget.onDone();
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final item = widget.item;
    final colors = context.colors;
    final muted = context.text.bodySmall?.copyWith(color: colors.muted);
    final (label, color, icon) = switch (item.kind) {
      'approval' => ('需要批准', colors.warning, Icons.gpp_maybe_outlined),
      'trust' => ('信任工作区', colors.warning, Icons.verified_user_outlined),
      'question' => ('需要补充信息', Theme.of(context).colorScheme.primary, Icons.help_outline),
      'limit' => ('已暂停', colors.danger, Icons.pause_circle_outline),
      'memory' => ('候选记忆', Theme.of(context).colorScheme.primary, Icons.psychology_alt_outlined),
      'proposal' => ('技能建议', Theme.of(context).colorScheme.primary, Icons.auto_fix_high_outlined),
      'interrupted' => ('被中断的任务', colors.muted, Icons.history),
      'schedule' => ('定时任务待批准', colors.warning, Icons.schedule),
      _ => (item.kind, colors.muted, Icons.inbox_outlined),
    };
    final lines = item.title.split('\n');
    final headline = item.kind == 'memory' || item.kind == 'proposal' || item.kind == 'interrupted' || item.kind == 'schedule' ? item.title : lines.first;
    final details = item.kind == 'approval' || item.kind == 'question' || item.kind == 'trust' ? lines.skip(1).join('\n').trim() : (item.body ?? '');
    return OutlinedCard(
      highlight: color,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 18, color: color),
              const SizedBox(width: 6),
              TagChip(label, color: color),
              const SizedBox(width: AppTokens.gap),
              Expanded(
                child: Text(
                  [if (item.cwd != null) p.basename(item.cwd!), formatDate(item.createdAt?.millisecondsSinceEpoch)].join(' · '),
                  style: muted,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              if (item.sessionFile != null && item.kind != 'interrupted')
                TextButton(
                  onPressed: () => agent.continueWork(sessionFile: item.sessionFile, cwd: item.cwd, text: ''),
                  child: const Text('打开会话'),
                ),
            ],
          ),
          const SizedBox(height: 6),
          Text(headline, style: context.text.titleSmall, maxLines: 3, overflow: TextOverflow.ellipsis),
          if (details.isNotEmpty) ...[
            const SizedBox(height: 4),
            Container(
              width: double.infinity,
              constraints: const BoxConstraints(maxHeight: 160),
              padding: const EdgeInsets.all(AppTokens.gap),
              decoration: BoxDecoration(color: colors.codeBackground, borderRadius: BorderRadius.circular(context.radiusSm)),
              child: SingleChildScrollView(child: SelectableText(details, style: context.text.bodySmall)),
            ),
          ],
          const SizedBox(height: AppTokens.gap),
          if (_busy) const LinearProgressIndicator() else _actions(context, agent),
        ],
      ),
    );
  }

  Widget _actions(BuildContext context, AgentController agent) {
    final item = widget.item;
    final method = item.data['method'] as String?;
    final options = [
      for (final o in (item.data['options'] as List? ?? const []))
        if (o is String) o,
    ];
    switch (item.kind) {
      case 'approval' || 'trust' || 'question':
        if (method == 'confirm') {
          return Wrap(
            spacing: AppTokens.gap,
            children: [
              FilledButton(onPressed: () => _run(() => agent.answerConfirmation(item.id, {'confirmed': true})), child: const Text('是')),
              OutlinedButton(onPressed: () => _run(() => agent.answerConfirmation(item.id, {'confirmed': false})), child: const Text('否')),
            ],
          );
        }
        if (method == 'input' || method == 'editor') {
          return Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _answer,
                  minLines: 1,
                  maxLines: method == 'editor' ? 6 : 1,
                  decoration: const InputDecoration(hintText: '你的回答'),
                ),
              ),
              const SizedBox(width: AppTokens.gap),
              FilledButton(onPressed: () => _run(() => agent.answerConfirmation(item.id, {'value': _answer.text})), child: const Text('提交')),
              const SizedBox(width: AppTokens.gap),
              TextButton(onPressed: () => _run(() => agent.answerConfirmation(item.id, {'cancelled': true})), child: const Text('跳过')),
            ],
          );
        }
        return Wrap(
          spacing: AppTokens.gap,
          runSpacing: 6,
          children: [
            for (final (i, o) in options.indexed)
              i == 0
                  ? FilledButton(onPressed: () => _run(() => agent.answerConfirmation(item.id, {'value': o})), child: Text(o))
                  : OutlinedButton(onPressed: () => _run(() => agent.answerConfirmation(item.id, {'value': o})), child: Text(o)),
          ],
        );
      case 'limit':
        return Wrap(
          spacing: AppTokens.gap,
          children: [
            FilledButton(onPressed: () => _run(() => agent.resolveNotice(item.id, continueRun: true)), child: const Text('继续')),
            OutlinedButton(onPressed: () => _run(() => agent.resolveNotice(item.id, continueRun: false)), child: const Text('到此为止')),
          ],
        );
      case 'memory':
        return FilledButton.tonal(onPressed: () => agent.showSection(AppSection.memory), child: const Text('去「记忆」确认'));
      case 'proposal':
        return FilledButton.tonal(onPressed: () => agent.showSection(AppSection.library), child: const Text('去「技能」查看'));
      case 'schedule':
        return Wrap(
          spacing: AppTokens.gap,
          children: [
            FilledButton(
              onPressed: () => _run(() async => agent.backend.call('schedules.setStatus', {'id': item.id, 'status': 'active'})),
              child: const Text('批准'),
            ),
            OutlinedButton(
              onPressed: () => _run(() async => agent.backend.call('schedules.setStatus', {'id': item.id, 'status': 'rejected'})),
              child: const Text('拒绝'),
            ),
          ],
        );
      case 'interrupted':
        final run = InterruptedRun.fromJson(item.data);
        return Wrap(
          spacing: AppTokens.gap,
          children: [
            FilledButton(onPressed: () => _run(() async => agent.resumeInterrupted(run)), child: const Text('继续')),
            OutlinedButton(onPressed: () => _run(() => agent.dismissInterrupted(run)), child: const Text('放弃')),
          ],
        );
      default:
        return const SizedBox();
    }
  }
}
