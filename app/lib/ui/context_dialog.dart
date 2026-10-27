import 'package:flutter/material.dart';

import '../theme.dart';
import 'agent_scope.dart';

/// Context window usage, session totals and compaction controls.
Future<void> showContextDialog(BuildContext context) =>
    showDialog<void>(context: context, builder: (_) => const _ContextDialog());

String formatTokens(int n) => n >= 1000000
    ? '${(n / 1000000).toStringAsFixed(1)}M'
    : n >= 1000
    ? '${(n / 1000).toStringAsFixed(1)}k'
    : '$n';

class _ContextDialog extends StatefulWidget {
  const _ContextDialog();

  @override
  State<_ContextDialog> createState() => _ContextDialogState();
}

class _ContextDialogState extends State<_ContextDialog> {
  final _instructions = TextEditingController();
  String? _result;

  @override
  void dispose() {
    _instructions.dispose();
    super.dispose();
  }

  Future<void> _compact() async {
    final agent = AgentScope.read(context);
    setState(() => _result = null);
    final result = await agent.compact(instructions: _instructions.text);
    if (!mounted) return;
    setState(() {
      _result = result == null
          ? null
          : '压缩完成：约 ${formatTokens(result.tokensBefore)} → ${formatTokens(result.estimatedTokensAfter)} tokens';
    });
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final stats = agent.stats;
    final percent = stats.contextPercent;
    final barColor = percent >= 85 ? colors.danger : (percent >= 60 ? colors.warning : Theme.of(context).colorScheme.primary);
    final compacting = agent.isCompacting;
    final canCompact = agent.isReady && !agent.isRunning && !compacting && stats.totalMessages > 0;

    return Dialog(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560),
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(AppTokens.padLg + 4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Text('上下文', style: context.text.titleLarge),
                  const Spacer(),
                  IconButton(onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close), tooltip: '关闭'),
                ],
              ),
              Text(
                '模型每次回答都要「看」一遍当前会话的上下文。上下文越满，回答越慢越贵，满了以后就需要压缩：把较早的对话总结成摘要。原始记录不会删除。',
                style: context.text.bodySmall?.copyWith(color: colors.muted),
              ),
              const SizedBox(height: AppTokens.padLg),
              if (stats.contextWindow > 0) ...[
                Row(
                  crossAxisAlignment: CrossAxisAlignment.baseline,
                  textBaseline: TextBaseline.alphabetic,
                  children: [
                    Text(
                      stats.contextKnown ? '${percent.toStringAsFixed(percent < 10 ? 1 : 0)}%' : '—',
                      style: context.text.headlineMedium?.copyWith(color: barColor),
                    ),
                    const SizedBox(width: AppTokens.pad),
                    Text(
                      stats.contextKnown
                          ? '${formatTokens(stats.contextTokens)} / ${formatTokens(stats.contextWindow)} tokens'
                          : '刚压缩过，下次回复后更新',
                      style: context.text.bodyMedium?.copyWith(color: colors.muted),
                    ),
                  ],
                ),
                const SizedBox(height: AppTokens.gap),
                ClipRRect(
                  borderRadius: BorderRadius.circular(3),
                  child: LinearProgressIndicator(
                    value: stats.contextKnown ? (percent / 100).clamp(0, 1) : 0,
                    minHeight: 6,
                    color: barColor,
                    backgroundColor: colors.border,
                  ),
                ),
              ] else
                Text('当前模型没有报告上下文窗口大小。', style: context.text.bodyMedium?.copyWith(color: colors.muted)),
              const SizedBox(height: AppTokens.padLg),
              Wrap(
                spacing: AppTokens.padLg,
                runSpacing: AppTokens.gap,
                children: [
                  _Stat('你的消息', '${stats.userMessages}'),
                  _Stat('回复', '${stats.assistantMessages}'),
                  _Stat('工具调用', '${stats.toolCalls}'),
                  _Stat('累计输入', formatTokens(stats.inputTokens)),
                  _Stat('累计输出', formatTokens(stats.outputTokens)),
                  _Stat('缓存命中', formatTokens(stats.cacheReadTokens)),
                  if (stats.cost > 0) _Stat('费用', '\$${stats.cost.toStringAsFixed(4)}'),
                ],
              ),
              const Divider(height: AppTokens.padLg * 2),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: agent.autoCompactionEnabled,
                onChanged: agent.isReady ? agent.setSessionAutoCompaction : null,
                title: const Text('快满时自动压缩（本会话）'),
                subtitle: const Text('默认值在设置里修改'),
                dense: true,
              ),
              const SizedBox(height: AppTokens.gap),
              Text('立即压缩', style: context.text.titleSmall),
              const SizedBox(height: AppTokens.gap),
              TextField(
                controller: _instructions,
                minLines: 1,
                maxLines: 3,
                decoration: const InputDecoration(hintText: '可选：压缩时重点保留什么，比如「保留所有代码改动和待办事项」'),
              ),
              const SizedBox(height: AppTokens.pad),
              Row(
                children: [
                  FilledButton.icon(
                    onPressed: canCompact ? _compact : null,
                    icon: compacting
                        ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Icon(Icons.compress, size: 18),
                    label: Text(compacting ? '正在压缩…' : '压缩'),
                  ),
                  const SizedBox(width: AppTokens.pad),
                  Expanded(
                    child: Text(
                      _result ??
                          agent.active?.lastCompactionError ??
                          (agent.isRunning ? '等当前回复结束后才能压缩' : (stats.totalMessages == 0 ? '会话还是空的' : '')),
                      style: context.text.bodySmall?.copyWith(
                        color: _result != null ? colors.success : (agent.active?.lastCompactionError != null ? colors.warning : colors.muted),
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat(this.label, this.value);

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: 96,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: context.text.labelSmall?.copyWith(color: context.colors.muted)),
        Text(value, style: context.text.titleMedium),
      ],
    ),
  );
}
