import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'common.dart';

class ScheduleInfo {
  ScheduleInfo.fromJson(Json json)
    : id = json['id'] as String? ?? '',
      name = json['name'] as String? ?? '',
      prompt = json['prompt'] as String? ?? '',
      cwd = json['cwd'] as String? ?? '',
      kind = json['kind'] as String? ?? 'task',
      trigger = (json['trigger'] as Map?)?.cast<String, dynamic>() ?? const {},
      missedPolicy = json['missedPolicy'] as String? ?? 'latest',
      sessionMode = json['sessionMode'] as String? ?? 'fresh',
      sessionFile = json['sessionFile'] as String?,
      allowedTools = [for (final t in (json['allowedTools'] as List? ?? const [])) if (t is String) t],
      status = json['status'] as String? ?? 'active',
      describe = json['describe'] as String? ?? '',
      nextRunAt = (json['nextRunAt'] as num?)?.toInt(),
      createdBy = json['createdBy'] as String? ?? 'user',
      lastRun = json['lastRun'] is Map ? ScheduleRunInfo.fromJson((json['lastRun'] as Map).cast<String, dynamic>()) : null;

  final String id;
  final String name;
  final String prompt;
  final String cwd;
  final String kind;
  final Json trigger;
  final String missedPolicy;
  final String sessionMode;
  final String? sessionFile;
  final List<String> allowedTools;
  final String status;
  final String describe;
  final int? nextRunAt;
  final String createdBy;
  final ScheduleRunInfo? lastRun;

  String get kindLabel => scheduleKinds[kind] ?? kind;
  String get statusLabel => switch (status) { 'active' => '启用中', 'paused' => '已暂停', 'pending_approval' => '等你批准', 'finished' => '已结束', _ => status };
}

const scheduleKinds = {'task': '普通任务', 'report': '定期报告', 'monitor': '监控变化'};

class ScheduleRunInfo {
  ScheduleRunInfo.fromJson(Json json)
    : id = json['id'] as String? ?? '',
      status = json['status'] as String? ?? '',
      scheduledAt = (json['scheduledAt'] as num?)?.toInt(),
      startedAt = (json['startedAt'] as num?)?.toInt(),
      endedAt = (json['endedAt'] as num?)?.toInt(),
      manual = json['manual'] == true,
      catchUp = json['catchUp'] == true,
      attempt = (json['attempt'] as num?)?.toInt() ?? 1,
      sessionFile = json['sessionFile'] as String?,
      result = json['result'] as String?,
      error = json['error'] as String?,
      note = json['note'] as String?,
      deliveries = [for (final d in (json['deliveries'] as List? ?? const [])) if (d is Map) d.cast<String, dynamic>()];

  final String id;
  final String status;
  final int? scheduledAt;
  final int? startedAt;
  final int? endedAt;
  final bool manual;
  final bool catchUp;
  final int attempt;
  final String? sessionFile;
  final String? result;
  final String? error;
  final String? note;
  final List<Json> deliveries;

  String get statusLabel => switch (status) {
    'waiting' => '等待',
    'running' => '运行中',
    'needs_input' => '需要确认',
    'done' => '完成',
    'no_change' => '无变化',
    'failed' => '失败',
    'interrupted' => '中断',
    'skipped' => '已跳过',
    _ => status,
  };

  Color color(BuildContext context) => switch (status) {
    'done' || 'no_change' => context.colors.success,
    'failed' => context.colors.danger,
    'needs_input' => context.colors.warning,
    'running' || 'waiting' => Theme.of(context).colorScheme.primary,
    _ => context.colors.muted,
  };

  String get deliveryLabel {
    if (deliveries.isEmpty) return status == 'no_change' ? '无需通知' : '';
    final d = deliveries.last;
    final channel = d['channel'] == 'window' ? '窗口' : '系统通知';
    final state = switch (d['status']) { 'delivered' => '已送达', 'undelivered' => '未送达', _ => '不明' };
    return '$channel$state';
  }
}

/// The scheduled tasks list (a tab of the tasks page).
class SchedulesTab extends StatefulWidget {
  const SchedulesTab({super.key});

  @override
  State<SchedulesTab> createState() => _SchedulesTabState();
}

class _SchedulesTabState extends State<SchedulesTab> {
  late final AgentController _agent;
  List<ScheduleInfo> _schedules = const [];
  String? _error;
  var _loading = true;

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
      _schedules = jsonRows(await _agent.backend.call('schedules.list')).map(ScheduleInfo.fromJson).toList();
      _error = null;
    } catch (e) {
      _error = SessionRuntime.describeError(e);
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _call(String method, Json params, {String? done}) async {
    try {
      await _agent.backend.call(method, params, const Duration(seconds: 120));
      if (done != null && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(done), behavior: SnackBarBehavior.floating, width: 520));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('操作失败：${SessionRuntime.describeError(e)}'), behavior: SnackBarBehavior.floating, width: 520),
        );
      }
    }
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) return Center(child: Text(_error!, style: TextStyle(color: context.colors.danger)));
    if (_loading) return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    return PageBody(
      children: [
        ContentHeader(
          title: '定时',
          description: '到时间由后台自动执行（关掉窗口也会运行），带上你的记忆；只能用你允许的工具，不会弹确认框。可以每次新开一个会话，也可以一直接着同一个会话。',
          actions: [
            FilledButton.icon(
              onPressed: () async {
                if (await showScheduleEditor(context)) await _load();
              },
              icon: const Icon(Icons.add, size: 18),
              label: const Text('新建定时任务'),
            ),
          ],
        ),
        if (_schedules.isEmpty) const EmptyState(title: '还没有定时任务', message: '也可以直接对 Agent 说「每天早上 8 点帮我……」，它会提交给你确认。'),
        for (final s in _schedules) _ScheduleCard(schedule: s, onAction: _call, onChanged: _load),
      ],
    );
  }
}

class _ScheduleCard extends StatelessWidget {
  const _ScheduleCard({required this.schedule, required this.onAction, required this.onChanged});

  final ScheduleInfo schedule;
  final Future<void> Function(String method, Json params, {String? done}) onAction;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final s = schedule;
    final colors = context.colors;
    final muted = context.text.bodySmall?.copyWith(color: colors.muted);
    final pending = s.status == 'pending_approval';
    final last = s.lastRun;
    return OutlinedCard(
      highlight: pending ? colors.warning : null,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.schedule, size: 18, color: s.status == 'active' ? Theme.of(context).colorScheme.primary : colors.muted),
              const SizedBox(width: AppTokens.gap),
              Expanded(child: Text(s.name, style: context.text.titleSmall, overflow: TextOverflow.ellipsis)),
              TagChip(s.kindLabel),
              const SizedBox(width: 6),
              TagChip(s.statusLabel, color: s.status == 'active' ? colors.success : pending ? colors.warning : colors.muted),
              PopupMenuButton<String>(
                tooltip: '操作',
                icon: const Icon(Icons.more_horiz, size: 18),
                onSelected: (v) async {
                  switch (v) {
                    case 'edit':
                      if (await showScheduleEditor(context, existing: s)) onChanged();
                    case 'history':
                      await showScheduleHistory(context, s);
                    case 'remove':
                      if (await confirmAction(context, title: '删除定时任务「${s.name}」？', message: '执行记录也会一起删除，已经产生的会话和文件保留。', confirm: '删除', danger: true)) {
                        await onAction('schedules.remove', {'id': s.id});
                      }
                  }
                },
                itemBuilder: (_) => const [
                  PopupMenuItem(value: 'edit', child: ListTile(dense: true, leading: Icon(Icons.edit_outlined), title: Text('修改'))),
                  PopupMenuItem(value: 'history', child: ListTile(dense: true, leading: Icon(Icons.history), title: Text('执行记录'))),
                  PopupMenuItem(value: 'remove', child: ListTile(dense: true, leading: Icon(Icons.delete_outline), title: Text('删除'))),
                ],
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(s.prompt, maxLines: 2, overflow: TextOverflow.ellipsis),
          const SizedBox(height: 6),
          Text(
            [
              s.describe,
              p.basename(s.cwd),
              if (s.sessionMode == 'bound') '接着同一个会话',
              if (s.nextRunAt != null) '下次：${formatDate(s.nextRunAt)}',
              if (last != null) '上次：${last.statusLabel}${last.deliveryLabel.isNotEmpty ? '（${last.deliveryLabel}）' : ''}',
              if (s.createdBy == 'agent') 'Agent 创建',
            ].join(' · '),
            style: muted,
          ),
          const SizedBox(height: AppTokens.gap),
          Wrap(
            spacing: AppTokens.gap,
            children: [
              if (pending) ...[
                FilledButton(onPressed: () => onAction('schedules.setStatus', {'id': s.id, 'status': 'active'}, done: '已批准，会按时执行'), child: const Text('批准')),
                OutlinedButton(onPressed: () => onAction('schedules.setStatus', {'id': s.id, 'status': 'rejected'}), child: const Text('拒绝')),
              ] else ...[
                OutlinedButton.icon(
                  onPressed: last?.status == 'running' ? null : () => onAction('schedules.runNow', {'id': s.id}, done: '已开始运行'),
                  icon: const Icon(Icons.play_arrow, size: 18),
                  label: const Text('立即运行'),
                ),
                if (s.status == 'active')
                  TextButton(onPressed: () => onAction('schedules.setStatus', {'id': s.id, 'status': 'paused'}), child: const Text('暂停')),
                if (s.status == 'paused')
                  TextButton(onPressed: () => onAction('schedules.setStatus', {'id': s.id, 'status': 'active'}), child: const Text('恢复')),
              ],
            ],
          ),
        ],
      ),
    );
  }
}

/// Run history: planned vs actual time, status, attempts, delivery.
Future<void> showScheduleHistory(BuildContext context, ScheduleInfo schedule) async {
  final agent = AgentScope.read(context);
  List<ScheduleRunInfo> runs = const [];
  try {
    final detail = asJsonMap(await agent.backend.call('schedules.get', {'id': schedule.id}));
    runs = jsonRows(detail['runs']).map(ScheduleRunInfo.fromJson).toList();
  } catch (_) {}
  if (!context.mounted) return;
  await showDialog<void>(
    context: context,
    builder: (context) {
      final muted = context.text.bodySmall?.copyWith(color: context.colors.muted);
      return AlertDialog(
        title: Text('「${schedule.name}」的执行记录'),
        content: SizedBox(
          width: 680,
          height: 480,
          child: runs.isEmpty
              ? const EmptyNote('还没有执行过。')
              : ListView(
                  children: [
                    for (final r in runs)
                      OutlinedCard(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                TagChip(r.statusLabel, color: r.color(context)),
                                const SizedBox(width: AppTokens.gap),
                                Expanded(
                                  child: Text(
                                    [
                                      if (r.manual) '手动运行' else if (r.scheduledAt != null) '原定 ${formatDate(r.scheduledAt)}',
                                      if (r.startedAt != null && !r.manual) '实际 ${formatDate(r.startedAt)}',
                                      if (r.attempt > 1) '第 ${r.attempt} 次尝试',
                                      if (r.deliveryLabel.isNotEmpty) r.deliveryLabel,
                                    ].join(' · '),
                                    style: muted,
                                  ),
                                ),
                                if (r.sessionFile != null)
                                  TextButton(
                                    onPressed: () {
                                      Navigator.pop(context);
                                      agent.continueWork(sessionFile: r.sessionFile, cwd: schedule.cwd, text: '');
                                    },
                                    child: const Text('打开会话'),
                                  ),
                              ],
                            ),
                            if ((r.note ?? '').isNotEmpty && r.note != '手动运行') Text(r.note!, style: muted),
                            if ((r.error ?? '').isNotEmpty) Text(r.error!, style: TextStyle(color: context.colors.danger)),
                            if ((r.result ?? '').isNotEmpty) ...[const SizedBox(height: 4), Text(r.result!, maxLines: 4, overflow: TextOverflow.ellipsis)],
                          ],
                        ),
                      ),
                  ],
                ),
        ),
        actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('关闭'))],
      );
    },
  );
}

/// New or edit; returns true when saved. [session] starts a new schedule
/// that keeps running in that session (from the chat's menu).
Future<bool> showScheduleEditor(BuildContext context, {ScheduleInfo? existing, String? session}) async {
  final saved = await showDialog<bool>(context: context, builder: (_) => _ScheduleEditor(existing: existing, session: session));
  return saved == true;
}

class _ScheduleEditor extends StatefulWidget {
  const _ScheduleEditor({this.existing, this.session});

  final ScheduleInfo? existing;
  final String? session;

  @override
  State<_ScheduleEditor> createState() => _ScheduleEditorState();
}

class _ScheduleEditorState extends State<_ScheduleEditor> {
  static const _cronPresets = {
    '0 9 * * *': '每天 9:00',
    '0 9 * * 1-5': '工作日 9:00',
    '0 9 * * 1': '每周一 9:00',
    '0 9 1 * *': '每月 1 日 9:00',
    '0 * * * *': '每小时整点',
  };
  static const _optionalTools = {'bash': '运行命令', 'write': '写入文件', 'edit': '修改文件'};

  late final AgentController _agent = AgentScope.read(context);
  late final _name = TextEditingController(text: widget.existing?.name ?? '');
  late final _prompt = TextEditingController(text: widget.existing?.prompt ?? '');
  late final _cron = TextEditingController(text: widget.existing?.trigger['cron'] as String? ?? '0 9 * * *');
  late final _timezone = TextEditingController(text: widget.existing?.trigger['timezone'] as String? ?? '');
  late final _every = TextEditingController(text: _initialEvery());
  late var _type = widget.existing?.trigger['type'] as String? ?? 'cron';
  late var _unit = ((widget.existing?.trigger['everyMs'] as num?)?.toInt() ?? 0) % 3600000 == 0 && widget.existing != null ? 'h' : 'm';
  late var _kind = widget.existing?.kind ?? 'task';
  late var _missed = widget.existing?.missedPolicy ?? 'latest';
  late var _cwd = widget.existing?.cwd ?? _agent.workspace;
  late final Set<String> _tools = {...?widget.existing?.allowedTools};
  late var _sessionMode = widget.session != null ? 'bound' : widget.existing?.sessionMode ?? 'fresh';
  late String? _sessionFile = widget.session ?? widget.existing?.sessionFile;

  /// Sessions of the chosen workspace, as (path, title), for "keep running in".
  List<(String, String)> _sessions = const [];
  late DateTime _at = (widget.existing?.trigger['at'] as num?) != null
      ? DateTime.fromMillisecondsSinceEpoch((widget.existing!.trigger['at'] as num).toInt())
      : DateTime.now().add(const Duration(hours: 1));
  List<int> _preview = const [];
  String? _problem;
  var _saving = false;

  String _initialEvery() {
    final ms = (widget.existing?.trigger['everyMs'] as num?)?.toInt();
    if (ms == null) return '60';
    return ms % 3600000 == 0 ? '${ms ~/ 3600000}' : '${ms ~/ 60000}';
  }

  @override
  void initState() {
    super.initState();
    _loadSessions();
    if (_timezone.text.isEmpty) {
      _agent.backend.call('schedules.defaults').then((v) {
        if (mounted && _timezone.text.isEmpty) setState(() => _timezone.text = asJsonMap(v)['timezone'] as String? ?? '');
        _updatePreview();
      }).catchError((_) {});
    } else {
      WidgetsBinding.instance.addPostFrameCallback((_) => _updatePreview());
    }
  }

  @override
  void dispose() {
    for (final c in [_name, _prompt, _cron, _timezone, _every]) {
      c.dispose();
    }
    super.dispose();
  }

  Json get _trigger => switch (_type) {
    'once' => {'type': 'once', 'at': _at.millisecondsSinceEpoch},
    'interval' => {'type': 'interval', 'everyMs': (int.tryParse(_every.text.trim()) ?? 0) * (_unit == 'h' ? 3600000 : 60000)},
    _ => {'type': 'cron', 'cron': _cron.text.trim(), 'timezone': _timezone.text.trim()},
  };

  Future<void> _updatePreview() async {
    try {
      final result = asJsonMap(await _agent.backend.call('schedules.preview', {'trigger': _trigger}));
      if (!mounted) return;
      setState(() {
        _problem = result['error'] as String?;
        _preview = [for (final n in (result['next'] as List? ?? const [])) (n as num).toInt()];
      });
    } catch (_) {}
  }

  Future<void> _loadSessions() async {
    try {
      final rows = jsonRows(await _agent.backend.call('sessions.list', {'cwd': _cwd}));
      if (!mounted) return;
      setState(() => _sessions = [for (final r in rows) if (r['path'] is String) (r['path'] as String, r['title'] as String? ?? '未命名会话')]);
    } catch (_) {}
  }

  Future<void> _pickTime() async {
    final date = await showDatePicker(context: context, initialDate: _at, firstDate: DateTime.now().subtract(const Duration(days: 1)), lastDate: DateTime.now().add(const Duration(days: 3650)));
    if (date == null || !mounted) return;
    final time = await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(_at));
    if (time == null) return;
    setState(() => _at = DateTime(date.year, date.month, date.day, time.hour, time.minute));
    _updatePreview();
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    try {
      await _agent.backend.call('schedules.save', {
        'id': ?widget.existing?.id,
        'name': _name.text.trim(),
        'prompt': _prompt.text.trim(),
        'cwd': _cwd,
        'kind': _kind,
        'trigger': _trigger,
        'missedPolicy': _missed,
        'sessionMode': _sessionMode,
        'sessionFile': ?(_sessionMode == 'bound' ? _sessionFile : null),
        'allowedTools': _tools.isEmpty ? null : _tools.toList(),
      });
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      setState(() {
        _saving = false;
        _problem = SessionRuntime.describeError(e);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final muted = context.text.bodySmall?.copyWith(color: context.colors.muted);
    final label = context.text.labelMedium;
    return AlertDialog(
      title: Text(widget.existing == null ? '新建定时任务' : '修改定时任务'),
      content: SizedBox(
        width: 640,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(controller: _name, autofocus: widget.existing == null, decoration: const InputDecoration(labelText: '名称'), onChanged: (_) => setState(() {})),
              const SizedBox(height: AppTokens.pad),
              TextField(
                controller: _prompt,
                minLines: 3,
                maxLines: 8,
                decoration: const InputDecoration(labelText: '每次要做的事', hintText: '例如：查看 Hacker News 首页，挑出和 AI Agent 相关的 5 条，各用一句话总结。', alignLabelWithHint: true),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: AppTokens.padLg),
              Text('什么时候执行', style: label),
              const SizedBox(height: 6),
              SegmentedButton<String>(
                segments: const [
                  ButtonSegment(value: 'cron', label: Text('按日历')),
                  ButtonSegment(value: 'interval', label: Text('固定间隔')),
                  ButtonSegment(value: 'once', label: Text('只执行一次')),
                ],
                selected: {_type},
                onSelectionChanged: (s) {
                  setState(() => _type = s.first);
                  _updatePreview();
                },
              ),
              const SizedBox(height: AppTokens.gap),
              if (_type == 'cron') ...[
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    for (final e in _cronPresets.entries)
                      ChoiceChip(
                        label: Text(e.value),
                        selected: _cron.text.trim() == e.key,
                        onSelected: (_) {
                          setState(() => _cron.text = e.key);
                          _updatePreview();
                        },
                      ),
                  ],
                ),
                const SizedBox(height: AppTokens.gap),
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _cron,
                        decoration: const InputDecoration(labelText: 'cron 表达式（分 时 日 月 周）'),
                        onChanged: (_) => _updatePreview(),
                      ),
                    ),
                    const SizedBox(width: AppTokens.gap),
                    SizedBox(
                      width: 200,
                      child: TextField(controller: _timezone, decoration: const InputDecoration(labelText: '时区'), onChanged: (_) => _updatePreview()),
                    ),
                  ],
                ),
              ],
              if (_type == 'interval')
                Row(
                  children: [
                    const Text('每'),
                    const SizedBox(width: AppTokens.gap),
                    SizedBox(width: 100, child: TextField(controller: _every, keyboardType: TextInputType.number, onChanged: (_) => _updatePreview())),
                    const SizedBox(width: AppTokens.gap),
                    SegmentedButton<String>(
                      segments: const [ButtonSegment(value: 'm', label: Text('分钟')), ButtonSegment(value: 'h', label: Text('小时'))],
                      selected: {_unit},
                      onSelectionChanged: (s) {
                        setState(() => _unit = s.first);
                        _updatePreview();
                      },
                    ),
                  ],
                ),
              if (_type == 'once')
                Align(
                  alignment: Alignment.centerLeft,
                  child: OutlinedButton.icon(onPressed: _pickTime, icon: const Icon(Icons.event, size: 18), label: Text(formatDate(_at.millisecondsSinceEpoch))),
                ),
              const SizedBox(height: 6),
              if (_problem != null)
                Text(_problem!, style: TextStyle(color: context.colors.danger))
              else if (_preview.isNotEmpty)
                Text('接下来：${_preview.map(formatDate).join('、')}', style: muted),
              const SizedBox(height: AppTokens.padLg),
              Text('类型', style: label),
              const SizedBox(height: 6),
              SegmentedButton<String>(
                segments: [for (final e in scheduleKinds.entries) ButtonSegment(value: e.key, label: Text(e.value))],
                selected: {_kind},
                onSelectionChanged: (s) => setState(() => _kind = s.first),
              ),
              const SizedBox(height: 4),
              Text(
                switch (_kind) {
                  'monitor' => '和上次的结果比较，没有变化就不打扰你；错过的检查合并成一次补查。',
                  'report' => '每次都给出结果。电脑关机错过时间时：',
                  _ => '错过时间时补做最近一次。',
                },
                style: muted,
              ),
              if (_kind == 'report')
                RadioGroup<String>(
                  groupValue: _missed,
                  onChanged: (v) => setState(() => _missed = v!),
                  child: const Row(
                    children: [
                      Expanded(child: RadioListTile<String>(value: 'latest', title: Text('补做最近一次'), dense: true)),
                      Expanded(child: RadioListTile<String>(value: 'skip', title: Text('跳过'), dense: true)),
                    ],
                  ),
                ),
              const SizedBox(height: AppTokens.pad),
              Text('在哪个会话里运行', style: label),
              const SizedBox(height: 6),
              SegmentedButton<String>(
                segments: const [ButtonSegment(value: 'fresh', label: Text('每次新开一个会话')), ButtonSegment(value: 'bound', label: Text('接着同一个会话'))],
                selected: {_sessionMode},
                onSelectionChanged: (s) => setState(() => _sessionMode = s.first),
              ),
              const SizedBox(height: 4),
              Text(
                _sessionMode == 'bound'
                    ? '每次都在这个会话里继续，Agent 能看到之前几次的结果，适合「接着上次的进度」。会话变长后会自动压缩。'
                    : '每次都是干净的新会话，互不影响。',
                style: muted,
              ),
              if (_sessionMode == 'bound') ...[
                const SizedBox(height: 6),
                DropdownButtonFormField<String>(
                  initialValue: _sessions.any((s) => s.$1 == _sessionFile) ? _sessionFile : null,
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: '选择会话'),
                  hint: Text(_sessions.isEmpty ? '这个工作区还没有会话' : '选择一个会话'),
                  items: [for (final (path, title) in _sessions) DropdownMenuItem(value: path, child: Text(title, overflow: TextOverflow.ellipsis))],
                  onChanged: (v) => setState(() => _sessionFile = v),
                ),
              ],
              const SizedBox(height: AppTokens.pad),
              Text('允许使用的工具（读取、查找、抓取网页总是允许）', style: label),
              Wrap(
                spacing: 6,
                children: [
                  for (final e in _optionalTools.entries)
                    FilterChip(
                      label: Text(e.value),
                      selected: _tools.contains(e.key),
                      onSelected: (v) => setState(() => v ? _tools.add(e.key) : _tools.remove(e.key)),
                    ),
                ],
              ),
              const SizedBox(height: AppTokens.pad),
              Row(
                children: [
                  Text('工作区：', style: label),
                  Expanded(child: Text(_cwd, overflow: TextOverflow.ellipsis, style: muted)),
                  TextButton(
                    onPressed: () async {
                      final dir = await getDirectoryPath(initialDirectory: _cwd, confirmButtonText: '选择');
                      if (dir == null) return;
                      setState(() {
                        _cwd = dir;
                        if (widget.session == null) _sessionFile = null;
                      });
                      _loadSessions();
                    },
                    child: const Text('更换'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
        FilledButton(
          onPressed: _saving || _name.text.trim().isEmpty || _prompt.text.trim().isEmpty || (_sessionMode == 'bound' && _sessionFile == null) ? null : _save,
          child: const Text('保存'),
        ),
      ],
    );
  }
}
