import 'package:flutter/material.dart';

import '../craft_style.dart';
import '../state/preferences.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'proto_icon.dart';
import 'notes.dart';
import 'onboarding_tour.dart';

/// 原型 .pill：高 26、圆角 8、内边距 4/9、图标 14 与字间距 5、字 12.5；平时 ink2 无底，开着时强调色字 + accentSoft 底。
/// [warn]：「直接做」用警告色提醒。
ButtonStyle composerPillStyle(BuildContext context, {required bool on, bool warn = false}) {
  final c = context.colors;
  return craftControlStyle(context, TextButton.styleFrom(
    minimumSize: const Size(0, 26), fixedSize: const Size.fromHeight(26),
    padding: const EdgeInsets.symmetric(horizontal: 9),
    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
    visualDensity: VisualDensity.standard,
    shape: craftButtonShape(context.painting.craftGeometry),
    iconSize: 14,
    foregroundColor: warn ? c.warning : on ? c.accent : c.ink2,
    iconColor: warn ? c.warning : on ? c.accent : c.ink2,
    disabledForegroundColor: c.muted,
    backgroundColor: warn ? c.warning.withValues(alpha: .12) : on ? c.accentSoft : null,
    textStyle: const TextStyle(fontSize: 12.5),
  ).copyWith(iconSize: const WidgetStatePropertyAll(14)));
}

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
          style: composerPillStyle(context, on: on),
          onPressed: agent.isReady && !agent.isRunning ? () => on ? agent.newSession() : agent.newTemporarySession() : null,
          icon: const ProtoIcon('eye', size: 14),
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
      child: TourAnchor('ask-first', child: TextButton.icon(
        key: const ValueKey('ask-before-acting'),
        style: composerPillStyle(context, on: on, warn: !on),
        onPressed: agent.isReady ? () async {
          await agent.setApprovalMode(on ? ApprovalMode.off : ApprovalMode.changes);
          if (!context.mounted) return;
          showNote(on ? '改文件、跑命令不再先问你' : '改文件、跑命令前会先问你', kind: NoteKind.info);
        } : null,
        icon: ProtoIcon(on ? 'shield' : 'spark', size: 14),
        label: Text(on ? '先问我' : '直接做', style: const TextStyle(fontSize: 12.5)),
      )),
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
