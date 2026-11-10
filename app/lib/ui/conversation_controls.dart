import 'package:flutter/material.dart';

import '../state/preferences.dart';
import '../theme.dart';
import 'agent_scope.dart';

class IncognitoToggle extends StatelessWidget {
  const IncognitoToggle({super.key});
  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final on = agent.active?.incognito ?? false;
    // A labelled chip, as in the 1.0 prototype (interaction-v2.html): an eye icon alone did not say what it does.
    return Tooltip(
      message: '无痕',
      child: Semantics(
        toggled: on,
        child: TextButton.icon(
          style: TextButton.styleFrom(
            visualDensity: VisualDensity.compact,
            padding: const EdgeInsets.symmetric(horizontal: 9),
            shape: const StadiumBorder(),
            foregroundColor: on ? context.colors.accent : context.colors.muted,
            backgroundColor: on ? context.colors.accentSoft : null,
          ),
          onPressed: agent.isReady && !agent.isRunning ? () => on ? agent.newSession() : agent.newTemporarySession() : null,
          icon: const Icon(Icons.visibility_off_outlined, size: 16),
          label: const Text('无痕', style: TextStyle(fontSize: 12.5)),
        ),
      ),
    );
  }
}

class AskBeforeActingToggle extends StatelessWidget {
  const AskBeforeActingToggle({super.key});
  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final on = agent.approvalMode != ApprovalMode.off;
    return Semantics(
      label: '操作前问我', toggled: on,
      child: IconButton(
        tooltip: '操作前问我', isSelected: on, visualDensity: VisualDensity.compact,
        style: IconButton.styleFrom(foregroundColor: on ? context.colors.accent : context.colors.muted, backgroundColor: on ? context.colors.accentSoft : null),
        onPressed: agent.isReady ? () => agent.setApprovalMode(on ? ApprovalMode.off : ApprovalMode.changes) : null,
        icon: Icon(on ? Icons.verified_user_outlined : Icons.shield_outlined, size: 18),
      ),
    );
  }
}

class ComposerQuote extends StatelessWidget {
  const ComposerQuote({super.key, required this.text, required this.onRemove});
  final String text;
  final VoidCallback onRemove;
  @override
  Widget build(BuildContext context) => Container(
    key: const ValueKey('composer-quote'),
    margin: const EdgeInsets.only(bottom: 8), padding: const EdgeInsets.fromLTRB(10, 6, 2, 6),
    decoration: BoxDecoration(color: context.colors.background, borderRadius: BorderRadius.circular(context.radius)),
    child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Icon(Icons.format_quote, size: 18, color: context.colors.accent), const SizedBox(width: 8),
      Expanded(child: Text(text, maxLines: 3, overflow: TextOverflow.ellipsis, style: context.text.bodySmall?.copyWith(color: context.colors.ink2))),
      IconButton(tooltip: '移除引用', onPressed: onRemove, visualDensity: VisualDensity.compact, icon: const Icon(Icons.close, size: 15)),
    ]),
  );
}

Future<void> showConversationContext(BuildContext context) {
  final agent = AgentScope.read(context);
  return showDialog<void>(context: context, builder: (_) => AgentScope(controller: agent, child: const _ConversationContext()));
}

class _ConversationContext extends StatefulWidget {
  const _ConversationContext();
  @override
  State<_ConversationContext> createState() => _ConversationContextState();
}

class _ConversationContextState extends State<_ConversationContext> {
  var _busy = false;
  String? _result;
  Future<void> _compact() async {
    setState(() { _busy = true; _result = null; });
    final agent = AgentScope.read(context);
    final result = await agent.compact();
    if (mounted) setState(() { _busy = false; _result = result == null ? agent.active?.lastCompactionError ?? '暂时无法整理，请稍后重试' : '上下文已整理'; });
  }
  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    return AlertDialog(
      title: const Text('上下文'),
      content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(agent.stats.contextKnown ? '已用 ${agent.stats.contextPercent.toStringAsFixed(0)}%' : '尚无用量记录'),
        if (_result != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_result!)),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('关闭')),
        FilledButton(onPressed: _busy || agent.isRunning || agent.isCompacting ? null : _compact, child: Text(_busy ? '正在整理…' : '整理上下文')),
      ],
    );
  }
}
