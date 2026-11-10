import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'memory_details.dart';

class UnsavedMemoryNote extends StatefulWidget {
  const UnsavedMemoryNote({super.key, required this.replies});
  final List<AssistantItem> replies;
  @override
  State<UnsavedMemoryNote> createState() => _UnsavedMemoryNoteState();
}

class _UnsavedMemoryNoteState extends State<UnsavedMemoryNote> {
  bool _busy = false;
  String? _error;
  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    return ListenableBuilder(
      listenable: agent.memoryUi,
      builder: (context, _) {
        final claim = agent.memoryUi.unsaved[agent.activeSessionId];
        if (claim == null ||
            claim['replyEntryId'] == null ||
            !widget.replies.any((r) => r.entryId == claim['replyEntryId'])) {
          return const SizedBox.shrink();
        }
        final pending =
            claim['pending'] == true ||
            (claim['pendingIds'] as List? ?? []).isNotEmpty;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    pending ? '这条记忆等你确认' : '这件事还没记下',
                    style: context.text.bodySmall?.copyWith(
                      color: context.colors.muted,
                    ),
                  ),
                ),
                TextButton(
                  onPressed: _busy
                      ? null
                      : () async {
                          if (pending) {
                            agent.main.showSection(AppSection.tasks);
                            return;
                          }
                          setState(() => _busy = true);
                          try {
                            await showUnsavedMemoryEditor(context, claim);
                          } catch (e) {
                            if (mounted) {
                              setState(
                                () => _error = SessionRuntime.describeError(e),
                              );
                            }
                          } finally {
                            if (mounted) setState(() => _busy = false);
                          }
                        },
                  child: Text(pending ? '等你处理' : '保存'),
                ),
                IconButton(
                  tooltip: '关闭',
                  onPressed: _busy ? null : () => agent.memoryUi.dismiss(claim),
                  icon: const Icon(Icons.close, size: 15),
                ),
              ],
            ),
            if (_error != null)
              Text(_error!, style: TextStyle(color: context.colors.danger)),
          ],
        );
      },
    );
  }
}
