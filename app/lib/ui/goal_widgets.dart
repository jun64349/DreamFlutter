import 'package:flutter/material.dart';
import 'proto_icon.dart';
import '../state/agent_controller.dart';
import '../state/goal_conversation.dart';
import '../state/memory_ui.dart';
import '../theme.dart';
import '../craft_style.dart';
import 'craft_surface.dart';
import 'agent_scope.dart';
import 'message_widgets.dart' show todoItems;
import 'motion.dart';
import 'details_panel_widgets.dart';

// Shapes follow docs/design/prototype/v0.12-additions.html (.blk, .card, .job,
// .plan, .ask, .opt, .hint); colours are the theme's.
ShapeDecoration _card(BuildContext context, {double radius = 10}) =>
    craftSurfaceDecoration(context, radius: radius);
TextStyle? _mono(BuildContext context, {double size = 12, Color? color}) => context.text.bodySmall?.copyWith(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback, fontSize: size, color: color);

class GoalConversationHost extends StatefulWidget {
  const GoalConversationHost({super.key, required this.agent, required this.child});
  final AgentController agent;
  final Widget child;
  @override State<GoalConversationHost> createState() => _GoalConversationHostState();
}
class _GoalConversationHostState extends State<GoalConversationHost> {
  late GoalConversation model = GoalConversation(widget.agent);
  @override void didUpdateWidget(GoalConversationHost old) { super.didUpdateWidget(old); if (old.agent != widget.agent) { model.dispose(); model = GoalConversation(widget.agent); } }
  @override void dispose() { model.dispose(); super.dispose(); }
  @override Widget build(BuildContext context) => GoalScope(model: model, child: widget.child);
}
class GoalScope extends InheritedNotifier<GoalConversation> {
  const GoalScope({super.key, required GoalConversation model, required super.child}) : super(notifier: model);
  static GoalConversation? of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<GoalScope>()?.notifier;
}

class ConversationGoalSections extends StatelessWidget {
  const ConversationGoalSections({super.key, this.showEmpty = false, this.showJobs = true});
  final bool showEmpty;
  final bool showJobs;
  @override Widget build(BuildContext context) {
    final state = GoalScope.of(context);
    if (state == null) return const SizedBox.shrink();
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (state.goal != null) GoalCard(state: state)
      else if (showEmpty) DetailsPanelCard(icon: 'flag', title: '目标', child: Text('这段对话还没有目标',
        style: context.text.bodySmall?.copyWith(fontSize: 12.5, color: context.colors.muted))),
      if (showJobs && (state.jobs.isNotEmpty || showEmpty)) GoalJobs(state: state),
      if (state.error != null) Padding(padding: const EdgeInsets.only(bottom: 12), child: Text(state.error!, style: context.text.bodySmall?.copyWith(color: context.colors.danger))),
    ]);
  }
}

class GoalCard extends StatefulWidget {
  const GoalCard({super.key, required this.state});
  final GoalConversation state;
  @override State<GoalCard> createState() => _GoalCardState();
}
class _GoalCardState extends State<GoalCard> {
  bool emergency = false;
  @override Widget build(BuildContext context) {
    final state = widget.state, goal = widget.state.goal!, colors = context.colors;
    final budget = memoryMap(goal['budgetStatus']), used = memoryMap(budget['used']);
    final limit = (memoryMap(budget['limits'])['maxCostUsd'] as num?)?.toDouble();
    final cost = (used['costUsd'] as num?)?.toDouble() ?? 0;
    final paused = goal['status'] == 'paused';
    final ended = ['completed', 'cancelled', 'failed'].contains(goal['status']);
    final status = switch (goal['status']) { 'paused' => '暂停了', 'blocked' || 'uncertain' => '卡住了', 'completed' => '已完成', 'cancelled' => '已停止', 'failed' => '没做成', _ => '在推进' };
    final objective = memoryMap(goal['spec'])['objective'] as String?;
    final body = context.text.bodySmall?.copyWith(fontSize: 12.5, color: colors.ink2);
    final small = OutlinedButton.styleFrom(visualDensity: VisualDensity.compact, padding: const EdgeInsets.symmetric(horizontal: 10), minimumSize: const Size(0, 30), textStyle: context.text.bodySmall?.copyWith(fontSize: 12.5), shape: craftButtonShape(context.painting.craftGeometry));
    final busy = state.busy.contains('goal');
    final statusColor = paused || goal['status'] == 'blocked' || goal['status'] == 'uncertain' ? colors.ochre
        : goal['status'] == 'failed' ? colors.danger : colors.success;
    return DetailsPanelCard(
      icon: 'flag',
      title: '目标',
      trailing: DecoratedBox(
        decoration: BoxDecoration(color: statusColor.withValues(alpha: .13), borderRadius: BorderRadius.circular(999)),
        child: Padding(padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1), child: Text(status, style: TextStyle(fontSize: 11, color: statusColor))),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('${goal['title'] ?? objective ?? ''}', style: context.serif(context.text.titleSmall).copyWith(fontWeight: FontWeight.w600, fontSize: 15)),
        if (objective != null && objective != goal['title']) Padding(padding: const EdgeInsets.only(top: 2, bottom: 8), child: Text(objective, style: body)),
        if ('${goal['next'] ?? ''}'.isNotEmpty) Padding(padding: const EdgeInsets.only(bottom: 8), child: Container(padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6), decoration: BoxDecoration(color: colors.sunk, borderRadius: BorderRadius.circular(8)), child: Text('下一步：${goal['next']}', style: body?.copyWith(color: colors.ink)))),
        Padding(padding: const EdgeInsets.only(top: 2), child: Row(children: [Text('预算', style: body), const Spacer(), Text('\$${cost.toStringAsFixed(2)} / ${limit == null ? '不限' : '\$${limit.toStringAsFixed(2)}'}', style: body)])),
        Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: ClipRRect(borderRadius: BorderRadius.circular(3), child: LinearProgressIndicator(value: limit == null || limit <= 0 ? 0 : (cost / limit).clamp(0, 1), minHeight: 5, color: colors.accent, backgroundColor: colors.border))),
        Row(children: [Text('用时', style: body), const Spacer(), Text(formatDuration(Duration(milliseconds: (used['activeMs'] as num?)?.toInt() ?? 0)), style: body)]),
        const SizedBox(height: 8),
        Row(children: [
          OutlinedButton.icon(style: small, onPressed: busy || ended ? null : () => state.control(paused ? 'resume' : 'pause'), icon: ProtoIcon(paused ? 'play' : 'pause', size: 13), label: Text(paused ? '继续' : '暂停')),
          const SizedBox(width: 8),
          OutlinedButton(style: small.copyWith(foregroundColor: WidgetStatePropertyAll(colors.seal)), onPressed: busy || ended ? null : () => state.control('cancel'), child: const Text('停止')),
          const Spacer(),
          IconButton(tooltip: '更多', visualDensity: VisualDensity.compact, onPressed: () => setState(() => emergency = !emergency), icon: ProtoIcon('more', color: colors.ink2)),
        ]),
        if (goal['emergency'] == true) Padding(padding: const EdgeInsets.only(top: 6), child: Row(children: [Expanded(child: Text('已紧急停止，所有目标都停着', style: body?.copyWith(color: colors.seal))), TextButton(onPressed: busy ? null : () => state.emergency(false), child: const Text('解除'))])),
        if (emergency) Container(margin: const EdgeInsets.only(top: 8), padding: const EdgeInsets.fromLTRB(12, 10, 12, 10), decoration: BoxDecoration(color: colors.card, border: Border.all(color: colors.seal), borderRadius: BorderRadius.circular(10)), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('紧急停止', style: context.text.bodyMedium?.copyWith(fontSize: 13, fontWeight: FontWeight.w600, color: colors.seal)),
          Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: Text('停下所有目标（蝶君和工作台）和后台任务，正在发的请求会取消。已经写好的文件不会删。', style: body)),
          Row(children: [
            OutlinedButton(style: small.copyWith(foregroundColor: WidgetStatePropertyAll(colors.seal)), onPressed: busy ? null : () { setState(() => emergency = false); state.emergency(true); }, child: const Text('全部停下')),
            const SizedBox(width: 6),
            OutlinedButton(style: small, onPressed: () => setState(() => emergency = false), child: const Text('算了')),
          ]),
        ])),
      ]),
    );
  }
}

class GoalJobs extends StatelessWidget {
  const GoalJobs({super.key, required this.state, this.showHeading = true});
  final GoalConversation state;
  final bool showHeading;
  @override Widget build(BuildContext context) {
    final colors = context.colors;
    final running = state.jobs.where((j) => j['status'] == 'running').length;
    final rows = <Widget>[];
    final iconButtonStyle = IconButton.styleFrom(fixedSize: const Size.square(30), minimumSize: const Size.square(30),
      padding: EdgeInsets.zero, tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      shape: craftButtonShape(context.painting.craftGeometry));
    for (final job in state.jobs) {
      final id = '${job['id']}', live = job['status'] == 'running';
      final now = DateTime.now().millisecondsSinceEpoch;
      final elapsed = ((job['ended_at'] as num?)?.toInt() ?? now) - ((job['started_at'] as num?)?.toInt() ?? now);
      final command = job['command'] as String?;
      final name = command ?? '${job['label'] ?? ''}';
      rows.add(Opacity(opacity: live ? 1 : .55, child: Container(
        padding: const EdgeInsets.symmetric(vertical: 5),
        child: Row(children: [
          if (live) Padding(padding: const EdgeInsets.only(right: 8), child: Container(width: 7, height: 7, decoration: BoxDecoration(color: colors.success, shape: BoxShape.circle))),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: command != null ? _mono(context, color: colors.ink) : context.text.bodySmall?.copyWith(fontSize: 12.5, color: colors.ink)),
            Text('${live ? '' : '结束 · '}${formatDuration(Duration(milliseconds: elapsed.clamp(0, 1 << 53)))}', style: context.text.bodySmall?.copyWith(fontSize: 11.5, color: colors.muted)),
          ])),
          if (live) ...[
            IconButton(tooltip: '查看输出', style: iconButtonStyle, isSelected: state.outputs.containsKey(id), onPressed: () => state.toggleOutput(id), icon: ProtoIcon('eye', size: 14, color: colors.ink2)),
            IconButton(tooltip: '停止后台任务', style: iconButtonStyle, onPressed: state.busy.contains('job:$id') ? null : () => state.stopJob(id), icon: ProtoIcon('stop', size: 14, color: colors.ink2)),
          ],
        ]),
      )));
      if (state.outputs.containsKey(id)) {
        rows.add(Container(margin: const EdgeInsets.only(bottom: 6), padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6), constraints: const BoxConstraints(maxHeight: 96), decoration: BoxDecoration(color: colors.codeBackground, borderRadius: BorderRadius.circular(6)), child: SingleChildScrollView(child: SelectableText(state.outputs[id]!, style: _mono(context, size: 11.5, color: colors.ink2)))));
      }
    }
    final Widget body = rows.isEmpty
        ? Text('还没有后台任务', style: context.text.bodySmall?.copyWith(fontSize: 12.5, color: colors.muted))
        : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: rows);
    return showHeading
        ? DetailsPanelCard(icon: 'term', title: '后台', trailing: Text('$running 个在跑'), child: body)
        : body;
  }
}

class GoalPlanBox extends StatelessWidget {
  const GoalPlanBox({super.key, required this.composer, this.plan});
  final Widget composer;
  final List<Object?>? plan;
  @override Widget build(BuildContext context) => Center(child: ConstrainedBox(
    constraints: const BoxConstraints(maxWidth: AppTokens.contentMaxWidth + 48),
    child: Padding(padding: const EdgeInsets.fromLTRB(24, 0, 24, 18), child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      GoalPlan(plan: plan, contained: true),
      composer,
    ])),
  ));
}

/// The plan and its input share one centered column; opening it only fades in the steps.
class GoalPlan extends StatefulWidget {
  const GoalPlan({super.key, this.plan, this.contained = false});
  final List<Object?>? plan;
  final bool contained;
  @override State<GoalPlan> createState() => _GoalPlanState();
}
class _GoalPlanState extends State<GoalPlan> {
  bool open = false;
  @override Widget build(BuildContext context) {
    final todos = todoItems(widget.plan ?? AgentScope.of(context).todos);
    if (todos.isEmpty) return const SizedBox.shrink();
    final colors = context.colors;
    final done = todos.where((t) => t.status == 'completed').length;
    final current = todos.where((t) => t.status == 'in_progress').firstOrNull;
    final style = context.text.bodySmall?.copyWith(fontSize: 12.5, color: colors.ink2, height: 1.55);
    // 原型 .plan / .planlist：一块 sunk 底（主题的暖纸色，不是另调的灰）、圆角 10；
    // 头：旗标、「计划 2/5 · 正在：…」（…为 500 ink）、70 宽 4 高进度条、展开箭头；
    // 清单：完成 = 绿勾 + 删除线淡字，当前 = 赭色呼吸点 + 600 ink，没做 = 空 14 位 + ink2。
    final plan = Padding(padding: const EdgeInsets.only(bottom: 8), child: Container(
      decoration: BoxDecoration(color: colors.sunk, borderRadius: BorderRadius.circular(10)),
      clipBehavior: Clip.antiAlias,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Material(type: MaterialType.transparency, child: InkWell(
          key: const ValueKey('plan-header'),
          onTap: () => setState(() => open = !open),
          child: Padding(padding: const EdgeInsets.fromLTRB(12, 6, 12, 6), child: Row(children: [
            ProtoIcon('flag', size: 13, color: colors.accent), const SizedBox(width: 8),
            Expanded(child: Text.rich(TextSpan(text: '计划 $done/${todos.length}', children: [if (!open && current != null) ...[const TextSpan(text: ' · 正在：'), TextSpan(text: current.content, style: TextStyle(color: colors.ink, fontWeight: FontWeight.w500))]]), maxLines: 1, overflow: TextOverflow.ellipsis, style: style)),
            const SizedBox(width: 10),
            SizedBox(width: 70, child: ClipRRect(borderRadius: BorderRadius.circular(2), child: LinearProgressIndicator(value: done / todos.length, minHeight: 4, color: colors.accent, backgroundColor: colors.border))),
            const SizedBox(width: 8),
            AnimatedRotation(turns: open ? .5 : 0, duration: AppTokens.motion(context, AppTokens.control), child: ProtoIcon('chev', size: 14, color: colors.muted)),
          ])),
        )),
        if (open) FadeIn(child: Padding(
          key: const ValueKey('plan-list'),
          padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            for (final todo in todos) Padding(padding: const EdgeInsets.symmetric(vertical: 2), child: Row(children: [
              SizedBox(width: 14, child: Center(child: switch (todo.status) {
                'completed' => ProtoIcon('check', size: 13, color: colors.success),
                'in_progress' => BreathingDot(size: 8, color: colors.ochre),
                _ => const SizedBox.shrink(),
              })),
              const SizedBox(width: 8),
              Expanded(child: Text(todo.content, style: style?.copyWith(
                color: todo.status == 'completed' ? colors.muted : todo.status == 'in_progress' ? colors.ink : colors.ink2,
                fontWeight: todo.status == 'in_progress' ? FontWeight.w600 : null,
                decoration: todo.status == 'completed' ? TextDecoration.lineThrough : null,
                decorationColor: colors.muted))),
            ])),
          ]),
        )),
      ]),
    ));
    if (widget.contained) return plan;
    return Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: AppTokens.contentMaxWidth + 48), child: Padding(padding: const EdgeInsets.symmetric(horizontal: 24), child: plan)));
  }
}

/// 「要不要设为目标？」: a slimmer question card (.ask) with two buttons.
class GoalProposals extends StatelessWidget {
  const GoalProposals({super.key});
  @override Widget build(BuildContext context) {
    final state = GoalScope.of(context);
    if (state == null || state.proposals.isEmpty) return const SizedBox.shrink();
    final shape = craftButtonShape(context.painting.craftGeometry);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [for (final proposal in state.proposals) ConstrainedBox(constraints: const BoxConstraints(maxWidth: 560), child: Container(
      margin: const EdgeInsets.symmetric(vertical: 10), padding: const EdgeInsets.fromLTRB(14, 10, 10, 10), decoration: _card(context, radius: 12),
      child: Row(children: [
        Icon(Icons.outlined_flag, size: 16, color: context.colors.accent), const SizedBox(width: 8),
        Expanded(child: Text('要不要把「${proposal['originText'] ?? memoryMap(proposal['draft'])['title'] ?? ''}」设为目标？', style: context.text.bodyMedium?.copyWith(fontWeight: FontWeight.w500))),
        const SizedBox(width: 8),
        FilledButton(style: FilledButton.styleFrom(visualDensity: VisualDensity.compact, shape: shape), onPressed: state.busy.contains('proposal:${proposal['id']}') ? null : () => state.resolveProposal(proposal, true), child: const Text('设为目标')),
        const SizedBox(width: 6),
        OutlinedButton(style: OutlinedButton.styleFrom(visualDensity: VisualDensity.compact, shape: shape), onPressed: state.busy.contains('proposal:${proposal['id']}') ? null : () => state.resolveProposal(proposal, false), child: const Text('不用')),
      ]),
    ))]);
  }
}

/// The agent's question in the conversation (.ask): options as cards, own answer, skip, countdown.
class GoalQuestions extends StatelessWidget {
  const GoalQuestions({super.key, this.maxWidth = 560});
  final double maxWidth;
  @override Widget build(BuildContext context) {
    final state = GoalScope.of(context);
    if (state == null) return const SizedBox.shrink();
    final colors = context.colors;
    String clean(String s) => s.replaceAll(RegExp(r'\s*(\(Recommended\)|（推荐）|\(推荐\))', caseSensitive: false), '');
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [for (final question in state.questions) Builder(builder: (context) {
      final request = memoryMap(question['request']);
      final options = (request['options'] as List? ?? []).whereType<String>().where((s) => !['自己回答…', '跳过这个问题'].contains(s)).toList();
      final recommended = options.where((s) => RegExp(r'\(Recommended\)|（推荐）|\(推荐\)', caseSensitive: false).hasMatch(s)).firstOrNull ?? options.firstOrNull;
      final title = '${question['title']}'.split('\n\n').last;
      if (question['status'] != 'pending') {
        final answer = memoryMap(question['answer'])['value'];
        // Answered: a quiet hint line between hairlines (prototype .hint).
        final style = context.text.bodySmall?.copyWith(fontSize: 12.5, color: colors.muted);
        return Padding(padding: const EdgeInsets.symmetric(vertical: 10), child: Row(children: [
          Expanded(child: Container(height: 1, color: colors.border)), const SizedBox(width: 8),
          Icon(Icons.check, size: 13, color: colors.success), const SizedBox(width: 6),
          Flexible(flex: 6, child: Text(answer == null ? '已结束' : answer == '跳过这个问题' ? '已跳过' : '你选了「${clean('$answer').split(' — ').first}」', maxLines: 1, overflow: TextOverflow.ellipsis, style: style)),
          const SizedBox(width: 8), Expanded(child: Container(height: 1, color: colors.border)),
        ]));
      }
      final timeout = (request['timeout'] as num?)?.toInt();
      final remaining = timeout == null ? null : (((question['createdAt'] as num?)?.toInt() ?? 0) + timeout - DateTime.now().millisecondsSinceEpoch).clamp(0, timeout) ~/ 1000;
      final busy = state.busy.contains('question:${question['id']}');
      Widget option(String value) {
        final on = value == recommended;
        final parts = clean(value).split(' — ');
        final note = parts.length > 1 ? parts.skip(1).join(' — ') : on ? '默认' : null;
        return Expanded(child: Padding(padding: const EdgeInsets.only(right: 8), child: Material(
          color: on ? colors.accentSoft : colors.background,
          shape: craftSurfaceShape(context, radius: 10, borderColor: on ? colors.accent : colors.border),
          clipBehavior: Clip.antiAlias,
          child: InkWell(onTap: busy ? null : () => state.answerQuestion(question, value), child: Padding(padding: const EdgeInsets.fromLTRB(10, 8, 10, 8), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(parts.first, style: context.text.bodyMedium?.copyWith(fontSize: 13.5)),
            if (note != null) Text(note, style: context.text.bodySmall?.copyWith(fontSize: 12, color: colors.muted)),
          ]))),
        )));
      }
      return ConstrainedBox(constraints: BoxConstraints(maxWidth: maxWidth), child: Container(margin: const EdgeInsets.symmetric(vertical: 10), padding: const EdgeInsets.fromLTRB(14, 12, 14, 12), decoration: _card(context, radius: 12), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          Icon(Icons.info_outline, size: 16, color: colors.accent), const SizedBox(width: 8),
          Expanded(child: Text(title, style: context.text.bodyMedium?.copyWith(fontWeight: FontWeight.w500))),
          if (remaining != null && recommended != null) Text('${remaining ~/ 60}:${(remaining % 60).toString().padLeft(2, '0')} 后按「${clean(recommended).split(' — ').first}」继续', style: context.text.bodySmall?.copyWith(fontSize: 12, color: colors.muted, fontFeatures: AppTokens.numberFeatures)),
        ]),
        if (options.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: IntrinsicHeight(child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [for (final o in options) option(o)]))),
        Padding(padding: const EdgeInsets.only(top: 8), child: Row(children: [
          Expanded(child: TextField(key: ValueKey('answer-${question['id']}'), enabled: !busy, style: context.text.bodyMedium?.copyWith(fontSize: 13.5),
            decoration: InputDecoration(hintText: '自己回答…', hintStyle: TextStyle(color: colors.muted), isDense: true, filled: true, fillColor: colors.sunk, contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9), border: craftInputBorder(context.painting.craftGeometry, radius: 8)),
            onSubmitted: (v) { if (v.trim().isNotEmpty) state.answerQuestion(question, v.trim(), custom: true); })),
          const SizedBox(width: 8),
          TextButton(onPressed: busy ? null : () => state.answerQuestion(question, question['method'] == 'select' ? '跳过这个问题' : ''), child: const Text('跳过')),
        ])),
      ])));
    })]);
  }
}

/// 「建了日程「…」 看日程」 between two hairlines (.hint).
class GoalScheduleNotice extends StatefulWidget {
  const GoalScheduleNotice({super.key, required this.id, required this.created});
  final String id;
  final bool created;
  @override State<GoalScheduleNotice> createState() => _GoalScheduleNoticeState();
}
class _GoalScheduleNoticeState extends State<GoalScheduleNotice> {
  Future<Object?>? _schedule;
  @override void didChangeDependencies() { super.didChangeDependencies(); _schedule ??= AgentScope.read(context).backend.call('schedules.get', {'id': widget.id}); }
  @override Widget build(BuildContext context) => FutureBuilder<Object?>(future: _schedule, builder: (context, snapshot) {
    final name = memoryMap(snapshot.data)['name'];
    if (name == null) return const SizedBox.shrink();
    final colors = context.colors;
    final style = context.text.bodySmall?.copyWith(fontSize: 12.5, color: colors.muted);
    return Padding(padding: const EdgeInsets.symmetric(vertical: 10), child: Row(children: [
      Expanded(child: Container(height: 1, color: colors.border)), const SizedBox(width: 8),
      Icon(Icons.calendar_today_outlined, size: 13, color: colors.muted), const SizedBox(width: 8),
      Flexible(flex: 6, child: Text('${widget.created ? '建了' : '改了'}日程「$name」', maxLines: 1, overflow: TextOverflow.ellipsis, style: style)),
      const SizedBox(width: 8),
      InkWell(onTap: () { scheduleNavigationRequest.value = null; scheduleNavigationRequest.value = widget.id; }, child: Text('看日程', style: style?.copyWith(color: colors.accent))),
      const SizedBox(width: 8), Expanded(child: Container(height: 1, color: colors.border)),
    ]));
  });
}
