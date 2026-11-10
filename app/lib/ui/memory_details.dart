import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../state/memory_page_model.dart';
import '../state/memory_ui.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'common.dart';

/// Shared inline editor: leaving the field saves through the versioned API.
class MemoryEditableEntry extends StatefulWidget {
  const MemoryEditableEntry({
    super.key,
    required this.item,
    required this.agent,
    this.onDelete,
    this.onSaved,
    this.highlighted = false,
  });
  final Json item;
  final AgentController agent;
  final Future<void> Function(Json)? onDelete;
  final Future<void> Function()? onSaved;
  final bool highlighted;
  @override
  State<MemoryEditableEntry> createState() => MemoryEditableEntryState();
}

class MemoryEditableEntryState extends State<MemoryEditableEntry> {
  late final _text = TextEditingController(
    text: widget.item['content'] as String? ?? '',
  );
  late Json _saved = {...widget.item};
  final _focus = FocusNode();
  late Future<Json> _detail;
  bool _saving = false;
  Future<bool>? _pendingSave;
  bool _conflict = false;
  String? _error;
  bool get _dirty => _text.text.trim() != _saved['content'];
  Future<Json> _loadDetail() async {
    final detail = memoryMap(
      await widget.agent.backend.call('memory.item', {'id': widget.item['id']}),
    );
    final ref =
        memoryRows(detail['sources'])
                .where((s) => s['kind'] == 'session')
                .firstOrNull?['ref']
            as String?;
    if (ref != null) {
      final summary = await SessionStore.readSummary(
        File(ref),
        includeSideConversations: true,
      );
      return {
        ...detail,
        'sourceTitle': summary?.title,
        'sourceCwd': summary?.cwd,
      };
    }
    return detail;
  }

  @override
  void initState() {
    super.initState();
    _detail = _loadDetail();
    _focus.addListener(() {
      if (mounted) setState(() {});
      if (!_focus.hasFocus) unawaited(save());
    });
  }

  @override
  void didUpdateWidget(MemoryEditableEntry oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!_saving && !_dirty && !_focus.hasFocus) {
      _saved = {...widget.item};
      _text.text = widget.item['content'] as String? ?? '';
    } else if (!_saving && widget.item['version'] != _saved['version']) {
      _conflict = true;
    }
  }

  Future<bool> save() => _pendingSave ??= _save().whenComplete(() {
    _pendingSave = null;
    if (mounted && _dirty && !_focus.hasFocus && _error == null && !_conflict) {
      unawaited(save());
    }
  });
  Future<bool> _save() async {
    if (!_dirty) return true;
    if (_saving || _conflict) return false;
    final content = _text.text.trim();
    if (content.isEmpty) {
      if (mounted) setState(() => _error = '内容不能为空');
      return false;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final result = memoryMap(
        await widget.agent.backend.call('memory.update', {
          'id': _saved['id'],
          'version': _saved['version'],
          'content': content,
        }),
      );
      checkMemoryChange(result);
      if (memoryRows(result['applied']).isEmpty) throw StateError('没有保存，请重试');
      _saved = memoryMap(result['item']);
      if (_saved.isEmpty) _saved = {...widget.item, 'content': content};
      await widget.onSaved?.call();
      if (mounted) setState(() {});
      return true;
    } catch (e) {
      if (mounted) setState(() => _error = SessionRuntime.describeError(e));
      return false;
    } finally {
      if (mounted) {
        setState(() => _saving = false);
      }
    }
  }

  @override
  void dispose() {
    _focus.dispose();
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedContainer(
    duration: AppTokens.motion(context, AppTokens.medium),
    curve: AppTokens.curve,
    padding: const EdgeInsets.fromLTRB(10, 8, 0, 10),
    decoration: BoxDecoration(
      color: widget.highlighted || _focus.hasFocus
          ? context.colors.accentSoft
          : Colors.transparent,
      borderRadius: BorderRadius.circular(context.radius),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TextField(
                key: ValueKey('memory-content-${widget.item['id']}'),
                controller: _text,
                focusNode: _focus,
                maxLines: null,
                textInputAction: TextInputAction.done,
                style: context.text.bodyMedium?.copyWith(height: 1.6),
                decoration: InputDecoration(
                  filled: false,
                  isDense: true,
                  contentPadding: const EdgeInsets.symmetric(vertical: 6),
                  border: InputBorder.none,
                  enabledBorder: InputBorder.none,
                  focusedBorder: UnderlineInputBorder(
                    borderSide: BorderSide(color: context.colors.accent),
                  ),
                ),
                onEditingComplete: () => _focus.unfocus(),
              ),
              FutureBuilder<Json>(
                future: _detail,
                builder: (context, snapshot) {
                  if (snapshot.hasError) {
                    return Row(
                      children: [
                        Text(
                          '出处暂时打不开',
                          style: context.text.bodySmall?.copyWith(
                            color: context.colors.muted,
                          ),
                        ),
                        TextButton(
                          onPressed: () =>
                              setState(() => _detail = _loadDetail()),
                          child: const Text('重试'),
                        ),
                      ],
                    );
                  }
                  if (!snapshot.hasData) return const SizedBox(height: 32);
                  final detail = snapshot.data ?? const <String, dynamic>{};
                  final sources = memoryRows(detail['sources']);
                  final source =
                      sources
                          .where((s) => s['kind'] == 'session')
                          .firstOrNull ??
                      sources.firstOrNull ??
                      const <String, dynamic>{};
                  final ref = source['ref'] as String?;
                  final session = ref == null
                      ? null
                      : widget.agent.sidebar
                            .where((s) => SessionStore.samePath(s.path, ref))
                            .firstOrNull;
                  final label = ref != null && source['kind'] == 'session'
                      ? session?.title ??
                            detail['sourceTitle'] as String? ??
                            '原对话'
                      : source['kind'] == 'user_edit'
                      ? '你记下的'
                      : '未记录出处';
                  return Wrap(
                    crossAxisAlignment: WrapCrossAlignment.center,
                    spacing: 6,
                    children: [
                      if (ref != null && source['kind'] == 'session')
                        TextButton(
                          style: TextButton.styleFrom(
                            padding: EdgeInsets.zero,
                            minimumSize: const Size(0, 32),
                            foregroundColor: context.colors.muted,
                          ),
                          onPressed: () async {
                            try {
                              if (!await File(ref).exists()) {
                                throw StateError('原对话已删除');
                              }
                              await widget.agent.continueWork(
                                sessionFile: ref,
                                cwd:
                                    detail['sourceCwd'] as String? ??
                                    (widget.item['scope'] == 'butterfly'
                                        ? widget.agent.butterflyHome
                                        : widget.item['workspacePath']
                                              as String?),
                                text: '',
                              );
                            } catch (e) {
                              if (context.mounted) {
                                ScaffoldMessenger.of(context).showSnackBar(
                                  SnackBar(
                                    content: Text(
                                      '这段对话暂时打不开：${SessionRuntime.describeError(e)}',
                                    ),
                                  ),
                                );
                              }
                            }
                          },
                          child: Text(
                            '来自 $label',
                            style: context.text.bodySmall?.copyWith(
                              decoration: TextDecoration.underline,
                            ),
                          ),
                        )
                      else
                        Text(
                          label,
                          style: context.text.bodySmall?.copyWith(
                            color: context.colors.muted,
                          ),
                        ),
                      Text(
                        formatDate(
                          (source['at'] as num?)?.toInt() ??
                              (widget.item['updatedAt'] as num?)?.toInt(),
                        ),
                        style: context.text.bodySmall?.copyWith(
                          color: context.colors.muted,
                        ),
                      ),
                      if (widget.item['possiblyOutdated'] == true)
                        Text(
                          '可能过时了',
                          style: context.text.bodySmall?.copyWith(
                            color: context.colors.warning,
                          ),
                        ),
                    ],
                  );
                },
              ),
              if (_saving) const LinearProgressIndicator(minHeight: 1),
              if (_error != null || _conflict)
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        _conflict ? '这条记忆刚有更新，重新查看后再改。' : '保存失败：$_error',
                        style: context.text.bodySmall?.copyWith(
                          color: context.colors.danger,
                        ),
                      ),
                    ),
                    TextButton(
                      onPressed: _saving
                          ? null
                          : () {
                              if (_conflict) {
                                setState(() {
                                  _saved = {...widget.item};
                                  _text.text =
                                      widget.item['content'] as String? ?? '';
                                  _conflict = false;
                                  _error = null;
                                });
                              } else {
                                unawaited(save());
                              }
                            },
                      child: Text(_conflict ? '重新查看' : '重试'),
                    ),
                  ],
                ),
            ],
          ),
        ),
        if (widget.onDelete != null)
          IconButton(
            tooltip: '删除记忆',
            onPressed: _saving
                ? null
                : () async {
                    _focus.unfocus();
                    if (await save()) await widget.onDelete!(_saved);
                  },
            icon: Icon(
              Icons.delete_outline,
              size: 18,
              color: context.colors.muted,
            ),
          ),
      ],
    ),
  );
}

Future<void> showMemoryDetails(BuildContext context, String id) =>
    showDialog<void>(
      context: context,
      builder: (_) =>
          MemoryDetailsDialog(id: id, agent: AgentScope.read(context)),
    );

class MemoryDetailsDialog extends StatefulWidget {
  const MemoryDetailsDialog({super.key, required this.id, required this.agent});
  final String id;
  final AgentController agent;
  @override
  State<MemoryDetailsDialog> createState() => _MemoryDetailsDialogState();
}

class _MemoryDetailsDialogState extends State<MemoryDetailsDialog> {
  late final _detail = widget.agent.backend.call('memory.item', {
    'id': widget.id,
  });
  final _editor = GlobalKey<MemoryEditableEntryState>();
  bool _closing = false;
  Future<void> _close() async {
    if (_closing) return;
    _closing = true;
    final saved = await _editor.currentState?.save() ?? true;
    if (saved && mounted) Navigator.pop(context);
    _closing = false;
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: false,
    onPopInvokedWithResult: (didPop, _) {
      if (!didPop) unawaited(_close());
    },
    child: AlertDialog(
      title: const Text('记忆'),
      content: SizedBox(
        width: 580,
        child: FutureBuilder<Object?>(
          future: _detail,
          builder: (context, snapshot) {
            if (snapshot.hasError) {
              return Text(
                '记忆暂时打不开：${SessionRuntime.describeError(snapshot.error!)}',
              );
            }
            if (!snapshot.hasData) {
              return const SizedBox(
                height: 100,
                child: Center(child: CircularProgressIndicator()),
              );
            }
            return SingleChildScrollView(
              child: MemoryEditableEntry(
                key: _editor,
                item: memoryMap(memoryMap(snapshot.data)['item']),
                agent: widget.agent,
              ),
            );
          },
        ),
      ),
      actions: [TextButton(onPressed: _close, child: const Text('关闭'))],
    ),
  );
}

Future<Json?> showUnsavedMemoryEditor(BuildContext context, Json claim) =>
    showDialog<Json>(
      context: context,
      builder: (_) =>
          _UnsavedEditor(claim: claim, agent: AgentScope.read(context)),
    );

class _UnsavedEditor extends StatefulWidget {
  const _UnsavedEditor({required this.claim, required this.agent});
  final Json claim;
  final AgentController agent;
  @override
  State<_UnsavedEditor> createState() => _UnsavedEditorState();
}

class _UnsavedEditorState extends State<_UnsavedEditor> {
  late final _content = TextEditingController(
    text: widget.claim['suggestion'] as String? ?? '',
  );
  bool _busy = false;
  String? _error;
  @override
  void dispose() {
    _content.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('记下这件事'),
    content: SizedBox(
      width: 520,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(controller: _content, minLines: 2, maxLines: 6),
          if (_error != null)
            Text(_error!, style: TextStyle(color: context.colors.danger)),
        ],
      ),
    ),
    actions: [
      TextButton(
        onPressed: _busy ? null : () => Navigator.pop(context),
        child: const Text('取消'),
      ),
      FilledButton(
        onPressed: _busy
            ? null
            : () async {
                setState(() {
                  _busy = true;
                  _error = null;
                });
                try {
                  final result = memoryMap(
                    await widget.agent.backend.call('memory.save', {
                      'content': _content.text.trim(),
                      'scope': 'workspace',
                      'cwd': widget.agent.workspace,
                      'unsavedRef': {
                        'sessionId': widget.claim['sessionId'],
                        'runId': widget.claim['runId'],
                      },
                    }),
                  );
                  checkMemoryChange(result);
                  if (memoryRows(result['applied']).isEmpty) {
                    throw StateError('没有保存，请重试');
                  }
                  widget.agent.memoryUi.setClaim(
                    widget.claim['sessionId'] as String,
                    null,
                  );
                  if (context.mounted) Navigator.pop(context, result);
                } catch (e) {
                  if (mounted) {
                    setState(() {
                      _busy = false;
                      _error = SessionRuntime.describeError(e);
                    });
                  }
                }
              },
        child: const Text('保存'),
      ),
    ],
  );
}
