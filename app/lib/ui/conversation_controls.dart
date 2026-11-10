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

/// Whether the agent asks before changing files or running commands (0.8.1 C.1): the chip says the
/// current state in words ("先问我" / "直接做"), so it needs no hover to be understood.
class AskBeforeActingToggle extends StatelessWidget {
  const AskBeforeActingToggle({super.key});
  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final on = agent.approvalMode != ApprovalMode.off;
    return Semantics(
      label: '操作前问我', toggled: on,
      child: TextButton.icon(
        key: const ValueKey('ask-before-acting'),
        style: TextButton.styleFrom(
          visualDensity: VisualDensity.compact,
          padding: const EdgeInsets.symmetric(horizontal: 9),
          shape: const StadiumBorder(),
          foregroundColor: on ? context.colors.accent : context.colors.warning,
          backgroundColor: on ? context.colors.accentSoft : context.colors.warning.withValues(alpha: .12),
        ),
        onPressed: agent.isReady ? () async {
          await agent.setApprovalMode(on ? ApprovalMode.off : ApprovalMode.changes);
          if (!context.mounted) return;
          ScaffoldMessenger.of(context)..hideCurrentSnackBar()..showSnackBar(SnackBar(content: Text(on ? '改文件、跑命令不再先问你' : '改文件、跑命令前会先问你')));
        } : null,
        icon: Icon(on ? Icons.verified_user_outlined : Icons.bolt_outlined, size: 16),
        label: Text(on ? '先问我' : '直接做', style: const TextStyle(fontSize: 12.5)),
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
