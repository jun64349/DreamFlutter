import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/session_runtime.dart' show ConnectionStatus;
import '../state/side_chat.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'common.dart' show TagChip;
import 'extension_dialogs.dart';
import 'conversation_cards.dart';
import 'markdown_view.dart' show ReplyMarkdown;
import 'motion.dart';
import 'message_widgets.dart' show ChatRow, QuestionRow, ReplyRow, WorkBlock;

/// The side conversation in the details panel (0.4, roadmap 4.7): the passage
/// it is about, the questions and answers asked here, an input box, and
/// 「带回主对话」. It listens to its own session only, so its streaming does
/// not rebuild the main conversation.
class SideChatView extends StatefulWidget {
  const SideChatView({super.key, required this.side});

  final SideChat side;

  @override
  State<SideChatView> createState() => _SideChatViewState();
}

class _SideChatViewState extends State<SideChatView> {
  final _input = TextEditingController();
  final _focus = FocusNode();
  bool _sending = false;
  final _seen = <String>{};
  bool _historySeen = false;

  @override
  void dispose() {
    _input.dispose();
    _focus.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _input.text.trim();
    if (_sending || text.isEmpty || !widget.side.isReady || widget.side.runtime.isRunning) return;
    _sending = true;
    try {
      final accepted = await widget.side.ask(text);
      if (mounted && accepted && _input.text.trim() == text) _input.clear();
    } finally {
      _sending = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.read(context);
    final colors = context.colors;
    final side = widget.side;
    return ListenableBuilder(
      listenable: side.runtime,
      builder: (context, _) {
        final runtime = side.runtime;
        final rows = ChatRow.fromItems(side.items);
        if (!_historySeen && side.isReady) { _seen.addAll(rows.map((row) => row.key)); _historySeen = true; }
        final fresh = {for (final row in rows) if (_seen.add(row.key)) row.key};
        final running = runtime.isRunning;
        return LayoutBuilder(builder: (context, constraints) => Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (side.parentMissing || !runtime.willPersist)
              Padding(padding: const EdgeInsets.fromLTRB(14, 10, 14, 0), child: Wrap(spacing: 8, children: [
                if (side.parentMissing) Text('来源对话已删除', style: context.text.bodySmall?.copyWith(color: colors.muted)),
                if (!runtime.willPersist) TagChip('不保存', color: colors.muted),
              ])),
            Container(
              margin: const EdgeInsets.fromLTRB(14, 12, 14, 6),
              padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
              decoration: BoxDecoration(
                color: colors.card,
                borderRadius: BorderRadius.circular(6),
              ),
              child: Text(side.quote, maxLines: 4, overflow: TextOverflow.ellipsis, style: context.text.bodySmall?.copyWith(color: colors.ink2, height: 1.6)),
            ),
            Expanded(
              child: !side.isReady
                  ? Center(
                      child: runtime.status == ConnectionStatus.crashed
                          ? Text('暂时打不开：${runtime.statusDetail}', style: TextStyle(color: colors.danger))
                          : const CircularProgressIndicator(strokeWidth: 2),
                    )
                  : ListView(
                      padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
                      children: [
                        for (final row in rows)
                          FadeSlideIn(key: ValueKey(row.key), animate: fresh.contains(row.key), child: switch (row) {
                            QuestionRow(:final item) => _Question(text: item.text),
                            ReplyRow() => _Answer(row: row, transcript: runtime.transcript, active: running && identical(row, rows.last), awaitingApproval: running && identical(row, rows.last) && runtime.pendingDialogs.any(isConversationApproval)),
                          }),
                        ConversationApprovalLane(runtime: runtime),
                      ],
                    ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 0, 14, 6),
              child: Row(
                children: [
                  TextButton.icon(
                    onPressed: side.lastAnswer == null || running ? null : agent.bringBackSideChat,
                    icon: const Icon(Icons.keyboard_return, size: 16),
                    label: const Text('带回去'),
                  ),
                  const Spacer(),
                  TextButton(onPressed: agent.closeSideChat, child: const Text('关掉')),
                ],
              ),
            ),
            if (runtime.pendingDialogs.any((request) => !isConversationApproval(request)))
              ConstrainedBox(
                constraints: BoxConstraints(maxHeight: constraints.maxHeight * .5),
                child: Padding(padding: const EdgeInsets.fromLTRB(14, 0, 14, 8), child: SideExtensionDialog(runtime: runtime)),
              ),
            Container(
              margin: const EdgeInsets.fromLTRB(14, 0, 14, 14),
              padding: const EdgeInsets.only(left: 12, right: 4),
              decoration: BoxDecoration(color: colors.card, border: Border.all(color: colors.border), borderRadius: BorderRadius.circular(10)),
              child: Row(
                children: [
                  Expanded(
                    child: CallbackShortcuts(
                      bindings: {const SingleActivator(LogicalKeyboardKey.enter): _send},
                      child: TextField(
                        controller: _input,
                        focusNode: _focus,
                        autofocus: true,
                        minLines: 1,
                        maxLines: 4,
                        style: context.text.bodyMedium,
                        decoration: const InputDecoration(hintText: '就这段问点什么', border: InputBorder.none, isDense: true),
                      ),
                    ),
                  ),
                  running
                      ? IconButton(tooltip: '停止', onPressed: runtime.abort, icon: const Icon(Icons.stop_rounded))
                      : IconButton(tooltip: '在问一下里发送', onPressed: side.isReady ? _send : null, icon: const Icon(Icons.arrow_upward_rounded)),
                ],
              ),
            ),
          ],
        ));
      },
    );
  }
}

/// A question asked on the side (the first one without the quoted passage, shown above).
class _Question extends StatelessWidget {
  const _Question({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    var shown = text;
    if (shown.startsWith(SideChat.lead)) {
      final cut = shown.indexOf('\n\n');
      if (cut > 0) shown = shown.substring(cut + 2);
    }
    return Align(
      alignment: Alignment.centerRight,
      child: Container(
        margin: const EdgeInsets.only(left: 32, bottom: 10),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(color: colors.userBubble, borderRadius: BorderRadius.circular(10)),
        child: Text(shown, style: context.text.bodyMedium?.copyWith(color: colors.onUserBubble, height: 1.6)),
      ),
    );
  }
}

/// An answer: its work folded in one block, then its words.
class _Answer extends StatelessWidget {
  const _Answer({required this.row, required this.transcript, required this.active, required this.awaitingApproval});

  final ReplyRow row;
  final Transcript transcript;
  final bool active;
  final bool awaitingApproval;

  @override
  Widget build(BuildContext context) {
    final steps = <Object>[
      for (final a in row.assistants)
        for (final part in a.parts)
          if (part is ThinkingPart)
            part
          else if (part is ToolCallPart)
            ?transcript.tool(part.toolCallId),
    ];
    final text = [for (final a in row.assistants) for (final part in a.parts.whereType<TextPart>()) part.text].join('\n\n').trim();
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (steps.isNotEmpty && !awaitingApproval) ...[WorkBlock(steps: steps, active: active && text.isEmpty), const SizedBox(height: 6)],
          if (text.isNotEmpty) ReplyMarkdown(text: text) else if (active && steps.isEmpty) const LinearProgressIndicator(minHeight: 2),
        ],
      ),
    );
  }
}
