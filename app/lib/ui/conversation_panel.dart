import 'dart:async';

import 'package:flutter/material.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'dashboard_page.dart' show formatCost;

/// "1.2 万" / "100 万" — the same wording the prototype uses for token counts.
String formatWan(int tokens) {
  if (tokens < 10000) return '$tokens';
  final wan = tokens / 10000;
  return '${wan >= 100 || wan == wan.roundToDouble() ? wan.round() : wan.toStringAsFixed(1)} 万';
}

/// The right panel's context block (0.8.1 R.2): how much of the window this conversation fills,
/// what it took in and gave out, and tidying it up. Replaces the old centred "上下文" dialog.
class ConversationContextSection extends StatefulWidget {
  const ConversationContextSection({super.key});
  @override
  State<ConversationContextSection> createState() => _ConversationContextSectionState();
}

class _ConversationContextSectionState extends State<ConversationContextSection> with SingleTickerProviderStateMixin {
  late final _flash = AnimationController(vsync: this, duration: AppTokens.slow * 2.5);
  AgentController? _agent;
  bool _busy = false;
  String? _result;
  bool _failed = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final agent = AgentScope.read(context);
    if (identical(agent, _agent)) return;
    _agent?.contextFocus.removeListener(_focus);
    _agent = agent..contextFocus.addListener(_focus);
  }

  @override
  void dispose() { _agent?.contextFocus.removeListener(_focus); _flash.dispose(); super.dispose(); }

  /// The composer's ring asked for this block: bring it into view and light it up once.
  void _focus() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(Scrollable.ensureVisible(context, alignment: .3, duration: AppTokens.motion(context, AppTokens.medium)));
      if (!MediaQuery.disableAnimationsOf(context)) unawaited(_flash.forward(from: 0));
    });
  }

  Future<void> _compact() async {
    final agent = AgentScope.read(context);
    final before = agent.stats.contextPercent;
    setState(() { _busy = true; _result = null; _failed = false; });
    final result = await agent.compact();
    if (!mounted) return;
    setState(() {
      _busy = false;
      _failed = result == null;
      _result = result == null
          ? agent.active?.lastCompactionError ?? '暂时整理不了，稍后再试'
          : '整理好了：${formatWan(result.tokensBefore)} → 约 ${formatWan(result.estimatedTokensAfter)}${before > 0 ? '（原来 ${before.toStringAsFixed(0)}%）' : ''}，前面的内容留了摘要';
    });
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final stats = agent.stats;
    final known = stats.contextKnown && stats.contextWindow > 0;
    final percent = known ? stats.contextPercent.clamp(0, 100).toDouble() : 0.0;
    final barColor = percent >= 85 ? colors.danger : percent >= 60 ? colors.warning : colors.accent;
    final seen = stats.inputTokens + stats.cacheReadTokens;
    final rows = <(String, String)>[
      if (stats.inputTokens > 0 || stats.cacheReadTokens > 0) ('输入', formatWan(stats.inputTokens + stats.cacheReadTokens)),
      if (stats.outputTokens > 0) ('输出', formatWan(stats.outputTokens)),
      if (seen > 0 && stats.cacheReadTokens > 0) ('缓存命中', '${(stats.cacheReadTokens * 100 / seen).round()}%'),
      if (stats.cost > 0) ('花费', '约 ${formatCost(stats.cost)}'),
    ];
    final compacting = _busy || agent.isCompacting;
    return Column(key: const ValueKey('panel-context'), crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text('上下文', style: context.label), const SizedBox(height: 8),
      AnimatedBuilder(
        animation: _flash,
        builder: (context, child) {
          final t = _flash.isAnimating ? (1 - _flash.value) : 0.0;
          return DecoratedBox(
            decoration: BoxDecoration(
              color: colors.card,
              border: Border.all(color: Color.lerp(colors.border, colors.accent, t)!, width: 1 + t),
              borderRadius: BorderRadius.circular(context.radiusLg),
            ),
            child: child,
          );
        },
        child: Padding(padding: const EdgeInsets.fromLTRB(14, 12, 14, 12), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(known ? '${formatWan(stats.contextTokens)} / ${formatWan(stats.contextWindow)}' : '还没有用量', style: context.text.titleSmall),
          const SizedBox(height: 8),
          ClipRRect(
            borderRadius: BorderRadius.circular(3),
            child: TweenAnimationBuilder<double>(
              tween: Tween(end: percent / 100), duration: AppTokens.motion(context, AppTokens.medium), curve: AppTokens.curve,
              builder: (context, value, _) => LinearProgressIndicator(value: value, minHeight: 6, color: barColor, backgroundColor: colors.border),
            ),
          ),
          if (rows.isNotEmpty) const SizedBox(height: 10),
          for (final (name, value) in rows) Padding(
            padding: const EdgeInsets.symmetric(vertical: 2),
            child: Row(children: [
              Text(name, style: context.text.bodySmall?.copyWith(color: colors.muted)),
              const Spacer(),
              Text(value, style: context.text.bodySmall),
            ]),
          ),
          const SizedBox(height: 10),
          OutlinedButton.icon(
            key: const ValueKey('panel-compact'),
            onPressed: compacting || agent.isRunning || !known ? null : _compact,
            icon: compacting ? const SizedBox.square(dimension: 14, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.compress, size: 16),
            label: Text(compacting ? '正在整理…' : '整理上下文'),
          ),
          AnimatedSize(
            duration: AppTokens.motion(context, AppTokens.medium), curve: AppTokens.curve,
            child: _result == null ? const SizedBox(width: double.infinity) : Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_result!, style: context.text.bodySmall?.copyWith(color: _failed ? colors.danger : colors.ink2)),
            ),
          ),
        ])),
      ),
    ]);
  }
}

/// The right panel's common actions (0.8.1 R.3): what used to hide in the title bar's "⋯" menu.
/// Scheduling is something you tell the agent; "don't remember" is what 无痕 is for.
class ConversationActionsSection extends StatefulWidget {
  const ConversationActionsSection({super.key});
  @override
  State<ConversationActionsSection> createState() => _ConversationActionsSectionState();
}

class _ConversationActionsSectionState extends State<ConversationActionsSection> {
  bool _drafting = false;

  Future<void> _saveSkill() async {
    setState(() => _drafting = true);
    try { await AgentScope.read(context).draftSkillFromSession(); }
    finally { if (mounted) setState(() => _drafting = false); }
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final saved = agent.active?.incognito != true && agent.currentSessionPath != null;
    final content = saved && !(agent.active?.isPristine ?? true);
    void action(String value) => agent.requestConversationAction(value);
    Widget button(String key, IconData icon, String label, VoidCallback? onPressed, {bool danger = false, bool busy = false}) => OutlinedButton.icon(
      key: ValueKey('panel-$key'),
      style: OutlinedButton.styleFrom(
        alignment: Alignment.centerLeft,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        foregroundColor: danger ? context.colors.danger : null,
      ),
      onPressed: onPressed,
      icon: busy ? const SizedBox.square(dimension: 14, child: CircularProgressIndicator(strokeWidth: 2)) : Icon(icon, size: 16),
      label: Text(label, overflow: TextOverflow.ellipsis),
    );
    final buttons = [
      button('skill', Icons.auto_awesome_outlined, _drafting ? '正在整理…' : '存成技能', content && !agent.isRunning && !_drafting ? _saveSkill : null, busy: _drafting),
      button('export', Icons.description_outlined, '导出 Markdown', content ? () => action('export') : null),
      button('archive', Icons.inventory_2_outlined, '归档', saved ? () => action('archive') : null),
      button('delete', Icons.delete_outline, '删除', agent.active == null ? null : () => action('delete'), danger: true),
    ];
    return Column(key: const ValueKey('panel-actions'), crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text('常用操作', style: context.label), const SizedBox(height: 8),
      LayoutBuilder(builder: (context, c) {
        final half = (c.maxWidth - 8) / 2;
        return Wrap(spacing: 8, runSpacing: 8, children: [for (final b in buttons) SizedBox(width: half, child: b)]);
      }),
    ]);
  }
}

