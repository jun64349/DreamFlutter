import 'dart:async';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';
import '../state/goal_conversation.dart';
import '../state/memory_ui.dart';
import '../state/schedule_state.dart';
import '../state/session_runtime.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'motion.dart';
import 'proto_icon.dart';
import 'shell_widgets.dart';

String scheduleTime(Object? value) { if (value is! num) return '—'; final d = DateTime.fromMillisecondsSinceEpoch(value.toInt()); return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}'; }
bool sameDay(DateTime a, DateTime b) => a.year == b.year && a.month == b.month && a.day == b.day;

class SchedulePage extends StatefulWidget {
  const SchedulePage({super.key});
  @override State<SchedulePage> createState() => _SchedulePageState();
}
class _SchedulePageState extends State<SchedulePage> {
  ScheduleState? state;
  bool logOpen = false, creating = false;
  @override void didChangeDependencies() { super.didChangeDependencies(); if (state != null) return; state = ScheduleState(AgentScope.read(context).backend); scheduleNavigationRequest.addListener(_jump); _jump(); }
  void _jump() { final id = scheduleNavigationRequest.value; if (id != null) { scheduleNavigationRequest.value = null; unawaited(state!.select(id, locate: true)); } }
  @override void dispose() { scheduleNavigationRequest.removeListener(_jump); state?.dispose(); super.dispose(); }
  @override Widget build(BuildContext context) => ListenableBuilder(listenable: state!, builder: (context, _) {
    final s = state!, colors = context.colors;
    // Shapes follow the prototype (.day as its own card, .daylist, .it, .cnote).
    final card = BoxDecoration(color: colors.card, border: Border.all(color: colors.hairline), borderRadius: BorderRadius.circular(12));
    final small = context.text.bodySmall;
    final daily = s.schedules.where((r) => r['everyDay'] != null).map((r) => '${r['id']}').toSet();
    List<Json> on(DateTime date, {bool all = true}) => s.occurrences.where((r) => r['at'] is num && (all || !daily.contains('${r['scheduleId']}')) && sameDay(date, DateTime.fromMillisecondsSinceEpoch((r['at'] as num).toInt()))).toList()..sort((a, b) => (a['at'] as num).compareTo(b['at'] as num));
    Json scheduleOf(Object? id) => s.schedules.where((r) => r['id'] == id).firstOrNull ?? {};
    bool isDone(Object? status) => status == 'done' || status == 'completed' || status == 'succeeded';
    String everyDayText(Json row) {
      final times = (memoryMap(row['everyDay'])['times'] as List?)?.cast<String>();
      final timing = times != null && times.isNotEmpty && times.every((time) => RegExp(r'^\d{1,2}:00$').hasMatch(time))
          ? '${times.map((time) => int.parse(time.split(':').first)).join('、')} 点'
          : times?.join('、') ?? row['describe'];
      return '每天：${row['name']}${timing == null || timing == '' ? '' : ' · $timing'}';
    }
    Widget pill(String text, VoidCallback onTap) => TextButton(
      onPressed: onTap,
      style: TextButton.styleFrom(
        foregroundColor: colors.ink2, backgroundColor: colors.card,
        side: BorderSide(color: colors.border), shape: const StadiumBorder(),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
        minimumSize: Size.zero, visualDensity: VisualDensity.standard, tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        textStyle: small?.copyWith(fontSize: 13, height: 1.6),
      ),
      child: Text(text),
    );
    void open(Object? id) { setState(() => creating = false); s.select('$id'); }
    final last = memoryMap(s.patrol['lastRun']);
    final patrolText = s.patrol['running'] == true ? '巡检中' : last.isEmpty ? '巡检' : '巡检：${scheduleTime(last['endedAt'])} ${last['note'] ?? last['error'] ?? ''}';
    ButtonStyle smallButton({Color? background, Color? color, EdgeInsets padding = const EdgeInsets.symmetric(horizontal: 13, vertical: 5)}) => TextButton.styleFrom(
      foregroundColor: color ?? colors.ink2, backgroundColor: background, padding: padding,
      minimumSize: const Size(0, 30), visualDensity: VisualDensity.standard, tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(9)), textStyle: small?.copyWith(fontSize: 13, height: 1.6),
    );
    Widget calendar() {
      final first = s.month, count = DateTime(first.year, first.month + 1, 0).day, offset = first.weekday - 1, weeks = (count + offset + 6) ~/ 7, now = DateTime.now();
      final today = DateTime(now.year, now.month, now.day);
      Widget cell(int i, bool wide) {
        final date = DateTime(first.year, first.month, i - offset + 1), inMonth = i >= offset && i < offset + count, isToday = sameDay(date, today), selected = inMonth && sameDay(date, s.day);
        final rows = inMonth ? on(date, all: false) : const <Json>[];
        final horizontal = selected && wide;
        final dayNumber = Container(
          padding: isToday ? const EdgeInsets.symmetric(horizontal: 6) : null,
          decoration: isToday ? BoxDecoration(color: colors.accent, borderRadius: BorderRadius.circular(999)) : null,
          child: Text('${date.day}', maxLines: 1, overflow: TextOverflow.clip, style: small?.copyWith(fontSize: 12, height: 1.6, color: isToday ? colors.onAccent : colors.ink)),
        );
        final events = <Widget>[
          for (final row in rows.take(2)) Opacity(
            opacity: isDone(row['status']) ? .55 : 1,
            child: Container(
              margin: const EdgeInsets.only(top: 3), padding: const EdgeInsets.symmetric(horizontal: 5),
              decoration: BoxDecoration(color: row['status'] == 'failed' ? colors.seal.withValues(alpha: .16) : colors.accentSoft, borderRadius: BorderRadius.circular(4)),
              child: Text('${selected ? '${scheduleTime(row['at'])} ' : ''}${scheduleOf(row['scheduleId'])['name'] ?? ''}',
                maxLines: 1, overflow: TextOverflow.ellipsis, style: small?.copyWith(fontSize: 11, height: 1.6, color: colors.ink)),
            ),
          ),
          if (rows.length > 2) Text('+${rows.length - 2}', style: small?.copyWith(fontSize: 11, color: colors.muted)),
        ];
        return Semantics(
          key: inMonth ? ValueKey('schedule-day-${date.day}') : null,
          button: inMonth,
          selected: selected,
          child: Opacity(opacity: inMonth ? 1 : .4, child: Material(
            color: colors.card, borderRadius: BorderRadius.circular(10),
            child: InkWell(
              onTap: inMonth ? () { setState(() => creating = false); s.setDay(date); } : null,
              borderRadius: BorderRadius.circular(10),
              child: Container(
                constraints: const BoxConstraints(minHeight: 78),
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 5),
                decoration: BoxDecoration(borderRadius: BorderRadius.circular(10), border: Border.all(color: selected ? colors.accent : colors.hairline, width: selected ? 2 : 1)),
                child: horizontal
                    ? Row(children: [
                        dayNumber,
                        const SizedBox(width: 10),
                        Expanded(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.end, children: events)),
                      ])
                    : Column(crossAxisAlignment: CrossAxisAlignment.start, children: [dayNumber, ...events]),
              ),
            ),
          )),
        );
      }
      final visibleSchedules = s.occurrences.map((row) => row['scheduleId']).toSet();
      final recurring = s.schedules.where((row) => row['everyDay'] != null || (memoryMap(row['trigger'])['type'] == 'cron' && !visibleSchedules.contains(row['id'])));
      final showToday = first.year != today.year || first.month != today.month || !sameDay(s.day, today);
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Wrap(alignment: WrapAlignment.spaceBetween, crossAxisAlignment: WrapCrossAlignment.center, runSpacing: 6, children: [
          Wrap(spacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
            IconButton(tooltip: '上个月', style: smallButton(padding: EdgeInsets.zero).copyWith(fixedSize: const WidgetStatePropertyAll(Size.square(30))),
              onPressed: () => s.setMonth(DateTime(first.year, first.month - 1)), icon: const ProtoIcon('left')),
            Text('${first.year} 年 ${first.month} 月', style: context.serif(context.text.titleMedium).copyWith(fontSize: 16, fontWeight: FontWeight.w600)),
            IconButton(tooltip: '下个月', style: smallButton(padding: EdgeInsets.zero).copyWith(fixedSize: const WidgetStatePropertyAll(Size.square(30))),
              onPressed: () => s.setMonth(DateTime(first.year, first.month + 1)), icon: const ProtoIcon('right')),
            if (showToday) Tooltip(message: '今天', child: TextButton(
              style: smallButton(padding: EdgeInsets.zero).copyWith(fixedSize: const WidgetStatePropertyAll(Size.square(30))),
              onPressed: () { if (first.year != today.year || first.month != today.month) s.setMonth(today); s.setDay(today); },
              child: const ProtoIcon('cal'),
            )),
          ]),
          if (recurring.isNotEmpty) Wrap(spacing: 8, runSpacing: 8, alignment: WrapAlignment.end, children: [
            for (final row in recurring) pill(row['everyDay'] != null ? everyDayText(row) : '${row['describe'] ?? ''} ${row['name'] ?? ''}', () => open(row['id'])),
          ]),
        ]),
        const SizedBox(height: 8),
        LayoutBuilder(builder: (context, box) {
          const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
          final selectedColumn = s.day.weekday - 1;
          final expandedWidth = math.min(200.0, math.max(0.0, box.maxWidth - 24) * .32);
          Widget gridRow(Widget Function(int) buildCell) => Row(children: [
            for (var col = 0; col < 7; col++) ...[
              if (col > 0) const SizedBox(width: 4),
              if (col == selectedColumn) SizedBox(width: expandedWidth, child: buildCell(col)) else Expanded(child: buildCell(col)),
            ],
          ]);
          return Column(children: [
            gridRow((col) => Center(child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Text(weekdays[col], style: small?.copyWith(fontSize: 11.5, height: 1.6, color: colors.muted)),
            ))),
            const SizedBox(height: 4),
            for (var week = 0; week < weeks; week++) ...[
              if (week > 0) const SizedBox(height: 4),
              gridRow((col) => cell(week * 7 + col, expandedWidth >= 100)),
            ],
          ]);
        }),
      ]);
    }
    Widget dayList() {
      final rows = on(s.day);
      return Container(decoration: card, padding: const EdgeInsets.fromLTRB(16, 12, 16, 12), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(padding: const EdgeInsets.only(bottom: 6), child: Text('${s.day.month} 月 ${s.day.day} 日', style: context.serif(context.text.titleMedium).copyWith(fontSize: 16, height: 1.6, fontWeight: FontWeight.w600))),
        for (final row in rows) Builder(builder: (context) {
          final schedule = scheduleOf(row['scheduleId']);
          final failed = row['status'] == 'failed', done = isDone(row['status']);
          final isReminder = schedule['kind'] == 'reminder';
          final source = schedule['everyDay'] != null ? '每天' : schedule['createdBy'] == 'user' ? '你建的' : '蝶君建的';
          final sub = isReminder ? '$source · 只提醒' : schedule['createdBy'] == 'user' ? '$source · 蝶君去做' : '蝶君去做';
          final error = '${row['error'] ?? ''}'.replaceFirst('没做成：', '');
          final state = failed ? '没做成' : done ? (isReminder ? '已提醒' : '完成') : row['status'] == 'running' ? '在做' : '';
          return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            // .it：44px 宽时间、标题与详情、靠右状态。
            InkWell(onTap: () => open(row['scheduleId']), child: Container(
              padding: const EdgeInsets.symmetric(vertical: 9, horizontal: 4),
              decoration: BoxDecoration(color: s.selectedId == row['scheduleId'] ? colors.accentSoft.withValues(alpha: .45) : null, border: Border(top: BorderSide(color: colors.hairline))),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                SizedBox(width: 44, child: Text(scheduleTime(row['at']), style: small?.copyWith(fontSize: 13, height: 1.6, color: colors.muted, fontFeatures: AppTokens.numberFeatures))),
                const SizedBox(width: 10),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('${schedule['name'] ?? ''}', style: context.text.bodyMedium?.copyWith(fontSize: 13, height: 1.6)),
                  Text(sub, style: small?.copyWith(fontSize: 12, height: 1.6, color: colors.muted)),
                ])),
                if (state.isNotEmpty) Text(state, textAlign: TextAlign.right, style: small?.copyWith(fontSize: 12, height: 1.6, color: failed ? colors.seal : done ? colors.success : colors.muted)),
              ]))),
            // 没做成的在条目下面给原因和「现在再做一次」（原型 .cnote：朱砂 9% 底、圆角 10）
            if (failed) FadeIn(child: Container(
              key: ValueKey('schedule-failed-${row['scheduleId']}-${row['at']}'),
              margin: const EdgeInsets.only(bottom: 8),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
              decoration: BoxDecoration(color: colors.seal.withValues(alpha: .09), borderRadius: BorderRadius.circular(10)),
              child: Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
                Text(error.isEmpty ? '这次没有做成' : error, style: small?.copyWith(fontSize: 12.5, color: colors.seal)),
                ShellButton('现在再做一次', small: true, onPressed: s.busy ? null : () => s.action('schedules.runNow', {'id': row['scheduleId']})),
              ]))),
          ]);
        }),
        if (rows.isEmpty && s.detail.isEmpty && !creating) Container(alignment: Alignment.center, padding: const EdgeInsets.symmetric(vertical: 24), decoration: BoxDecoration(border: Border(top: BorderSide(color: colors.hairline))), child: Text('这天没有安排', style: small?.copyWith(fontSize: 13, color: colors.muted))),
        if (s.detail.isNotEmpty || creating) FadeIn(child: Padding(padding: const EdgeInsets.only(top: 8), child: ScheduleEditor(key: ValueKey('${creating ? 'new' : s.detail['id']}:${s.detail['version']}'), state: s, value: creating ? const {} : s.detail, onSaved: () => setState(() => creating = false)))),
      ]));
    }
    return Scaffold(body: Stack(children: [
      // 虚化高光（原型 .wash）：页头后一层很淡的主题色径向渐变，只作氛围，不挡内容
      Positioned(top: 0, left: 0, right: 0, height: 280, child: IgnorePointer(child: DecoratedBox(decoration: BoxDecoration(
        gradient: RadialGradient(center: const Alignment(0, -1.1), radius: 1.2, stops: const [0, .7], colors: [colors.accentSoft.withValues(alpha: colors.accentSoft.a * .7), colors.accentSoft.withValues(alpha: 0)]))))),
      ShellColumn(maxWidth: 1080, horizontalPadding: 28, padding: const EdgeInsets.only(top: 18, bottom: 40), children: [
        Wrap(alignment: WrapAlignment.spaceBetween, crossAxisAlignment: WrapCrossAlignment.end, spacing: 12, runSpacing: 8, children: [
          Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text('时令', style: context.handwriting(context.text.headlineSmall).copyWith(fontSize: 32, height: 1.15, letterSpacing: 32 * .06)),
            Text('日程', style: small?.copyWith(fontSize: 12, height: 1.6, color: colors.muted)),
          ]),
          Wrap(spacing: 12, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
            Tooltip(
              message: logOpen ? '收起记录' : '巡检记录',
              child: TextButton(
                onPressed: () => setState(() => logOpen = !logOpen),
                style: smallButton(padding: EdgeInsets.zero, color: colors.muted),
                child: Text('$patrolText · 下次 ${scheduleTime(s.patrol['nextAt'])}', style: small?.copyWith(fontSize: 12.5, height: 1.6, color: colors.muted, fontStyle: AppTokens.processFontStyle)),
              ),
            ),
            TextButton(
              style: smallButton(background: colors.accent, color: colors.onAccent),
              onPressed: () { s.setDay(s.day); setState(() => creating = true); },
              child: Row(mainAxisSize: MainAxisSize.min, children: [ProtoIcon('plus', size: 13, color: colors.onAccent), const SizedBox(width: 6), const Text('新建')]),
            ),
          ]),
        ]),
        const SizedBox(height: 18),
        if (s.error != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(s.error!, style: small?.copyWith(color: colors.danger))),
        if (logOpen) Container(margin: const EdgeInsets.only(bottom: 10), padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6), decoration: card.copyWith(borderRadius: BorderRadius.circular(10)), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Align(alignment: Alignment.centerRight, child: TextButton(style: smallButton(), onPressed: s.canPatrol ? () => s.action('patrol.runNow') : null, child: const Text('现在巡检'))),
          for (final row in s.log) Padding(padding: const EdgeInsets.symmetric(vertical: 3), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [SizedBox(width: 54, child: Text(scheduleTime(row['startedAt']), style: small?.copyWith(fontSize: 12.5, color: colors.muted, fontStyle: AppTokens.processFontStyle))), Expanded(child: Text('${row['error'] ?? row['note'] ?? ''}', style: small?.copyWith(fontSize: 12.5, color: colors.ink, fontStyle: AppTokens.processFontStyle)))])),
        ])),
        LayoutBuilder(builder: (context, box) => box.maxWidth < 760
            ? Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [calendar(), const SizedBox(height: 14), dayList()])
            : Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Expanded(child: calendar()), const SizedBox(width: 16), SizedBox(width: 320, child: dayList())])),
      ]),
    ]));
  });
}

class ScheduleEditor extends StatefulWidget {
  const ScheduleEditor({super.key, required this.state, required this.value, required this.onSaved});
  final ScheduleState state; final Json value; final VoidCallback onSaved;
  @override State<ScheduleEditor> createState() => _ScheduleEditorState();
}
class _ScheduleEditorState extends State<ScheduleEditor> {
  late final name = TextEditingController(text: '${widget.value['name'] ?? ''}');
  // The time is one line of Chinese, parsed by schedules.parseTime; timeText writes an existing trigger back the same way.
  late final String initialTime = widget.value.isEmpty ? '' : '${widget.value['timeText'] ?? widget.value['describe'] ?? ''}';
  late final time = TextEditingController(text: initialTime);
  late final prompt = TextEditingController(text: '${widget.value['prompt'] ?? ''}');
  late String kind = widget.value['kind'] as String? ?? 'reminder';
  String? error;
  @override void dispose() { name.dispose(); time.dispose(); prompt.dispose(); super.dispose(); }
  Future<void> save() async {
    setState(() => error = null);
    if (name.text.trim().isEmpty) { setState(() => error = '请写名称'); return; }
    if (kind != 'reminder' && prompt.text.trim().isEmpty) { setState(() => error = '请写要做的事'); return; }
    Json trigger = memoryMap(widget.value['trigger']);
    if (widget.value.isEmpty || time.text.trim() != initialTime.trim()) {
      try { trigger = memoryMap(memoryMap(await widget.state.backend.call('schedules.parseTime', {'text': time.text}))['trigger']); }
      catch (e) { if (mounted) setState(() => error = SessionRuntime.describeError(e)); return; }
    }
    final ok = await widget.state.action('schedules.save', {
      if (widget.value['id'] != null) 'id': widget.value['id'], if (widget.value['version'] != null) 'expectedVersion': widget.value['version'],
      'name': name.text.trim(), 'kind': kind, 'trigger': trigger,
      if (kind != 'reminder') 'prompt': prompt.text.trim(),
      // A new 「蝶君去做」 runs in 蝶君's own folder: the backend's default when cwd is left out.
      if (kind != 'reminder' && widget.value['cwd'] != null) 'cwd': widget.value['cwd'],
    });
    if (ok && mounted) widget.onSaved();
  }
  @override Widget build(BuildContext context) {
    // The prototype's .det: label on the left, a small filled field, then the buttons and the history.
    final colors = context.colors, small = context.text.bodySmall;
    final border = OutlineInputBorder(borderRadius: BorderRadius.circular(7), borderSide: BorderSide(color: colors.border));
    final field = InputDecoration(isDense: true, filled: true, fillColor: colors.background, contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7), border: border, enabledBorder: border);
    final text = context.text.bodyMedium?.copyWith(fontSize: 13);
    Widget row(String label, Widget child) => Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: Row(children: [SizedBox(width: 56, child: Text(label, style: small?.copyWith(fontSize: 12.5, color: colors.muted))), Expanded(child: child)]));
    final shape = RoundedRectangleBorder(borderRadius: BorderRadius.circular(8));
    final busy = widget.state.busy;
    return Container(padding: const EdgeInsets.only(top: 10), decoration: BoxDecoration(border: Border(top: BorderSide(color: colors.border))), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      row('名称', TextField(controller: name, style: text, decoration: field)),
      row('时间', TextField(controller: time, style: text, decoration: field.copyWith(hintText: '明天下午3点', hintStyle: text?.copyWith(color: colors.muted)), onSubmitted: busy ? null : (_) => save())),
      row('方式', DropdownButtonFormField<String>(initialValue: kind == 'reminder' ? 'reminder' : 'task', style: text, isDense: true, decoration: field, items: const [DropdownMenuItem(value: 'reminder', child: Text('到点提醒我')), DropdownMenuItem(value: 'task', child: Text('蝶君去做'))],
        // Keep an existing report / monitor kind when it stays on 「蝶君去做」.
        onChanged: (v) { if (v != null) setState(() => kind = v == 'reminder' ? 'reminder' : (widget.value['kind'] != null && widget.value['kind'] != 'reminder' ? widget.value['kind'] as String : 'task')); })),
      if (kind != 'reminder') Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [SizedBox(width: 56, child: Padding(padding: const EdgeInsets.only(top: 7), child: Text('要做的事', style: small?.copyWith(fontSize: 12.5, color: colors.muted)))), Expanded(child: TextField(controller: prompt, minLines: 2, maxLines: 6, style: text, decoration: field))])),
      if (error != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text(error!, style: small?.copyWith(color: colors.danger))),
      const SizedBox(height: 8),
      Wrap(spacing: 6, runSpacing: 6, children: [
        FilledButton(style: FilledButton.styleFrom(visualDensity: VisualDensity.compact, shape: shape), onPressed: busy ? null : save, child: const Text('保存')),
        if (widget.value['id'] != null) ...[
          OutlinedButton.icon(style: OutlinedButton.styleFrom(visualDensity: VisualDensity.compact, shape: shape), onPressed: busy ? null : () => widget.state.action('schedules.runNow', {'id': widget.value['id']}), icon: const Icon(Icons.play_arrow, size: 13), label: const Text('现在做一次')),
          OutlinedButton(style: OutlinedButton.styleFrom(visualDensity: VisualDensity.compact, shape: shape, foregroundColor: colors.seal), onPressed: busy ? null : () => widget.state.action('schedules.remove', {'id': widget.value['id'], 'expectedVersion': widget.value['version']}), child: const Text('删除')),
        ],
      ]),
      if (widget.value['id'] != null) for (final change in widget.state.history) Padding(padding: const EdgeInsets.only(top: 8), child: Wrap(crossAxisAlignment: WrapCrossAlignment.center, children: [
        Icon(Icons.undo, size: 12, color: colors.muted), const SizedBox(width: 4),
        Text('${change['summary'] ?? ''}', style: small?.copyWith(fontSize: 12, color: colors.muted)),
        if (change['undoneAt'] == null) ...[
          Text(' · ', style: small?.copyWith(fontSize: 12, color: colors.muted)),
          InkWell(onTap: busy ? null : () => widget.state.action('schedules.undo', {'changeId': change['id']}), child: Text('撤销这次修改', style: small?.copyWith(fontSize: 12, color: colors.accent))),
        ],
      ])),
    ]));
  }
}
