import 'dart:async';

import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../state/memory_page_model.dart';
import '../state/memory_ui.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'memory_details.dart';
import 'memory_log.dart';
import 'motion.dart';
import 'shell_widgets.dart';

class MemoryPage extends StatefulWidget {
  const MemoryPage({super.key});
  @override
  State<MemoryPage> createState() => _MemoryPageState();
}

class _MemoryPageState extends State<MemoryPage> {
  late final AgentController _agent;
  late final MemoryPageModel _model;
  bool _recent = false;
  bool _setting = false;
  int _routeRevision = -1;
  String? _selected;
  String? _workspace;
  final _entryKeys = <String, GlobalKey<MemoryEditableEntryState>>{};
  @override
  void initState() {
    super.initState();
    _agent = AgentScope.read(context);
    _workspace = _agent.workspace;
    _model = MemoryPageModel(_agent)..load();
    _model.addListener(_revealSelection);
    _agent.memoryUi.addListener(_route);
    _agent.addListener(_workspaceChanged);
    _route();
  }

  void _workspaceChanged() {
    if (_workspace != _agent.workspace) {
      _workspace = _agent.workspace;
      unawaited(_model.load());
    }
  }

  void _route() {
    if (_routeRevision == _agent.memoryUi.routeRevision) return;
    _routeRevision = _agent.memoryUi.routeRevision;
    if (_agent.memoryUi.tab == 'pending') {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _agent.showSection(AppSection.tasks);
      });
      return;
    }
    _recent = _agent.memoryUi.tab == 'log';
    _selected = _agent.memoryUi.itemId;
    if (mounted) setState(() {});
    _revealSelection();
  }

  void _revealSelection() {
    if (_selected == null || _recent) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final target = _entryKeys[_selected]?.currentContext;
      if (mounted && target != null) {
        unawaited(
          Scrollable.ensureVisible(
            target,
            duration: AppTokens.motion(context, AppTokens.medium),
            curve: AppTokens.curve,
            alignment: 0.3,
          ),
        );
      }
    });
  }

  @override
  void dispose() {
    _agent.memoryUi.removeListener(_route);
    _agent.removeListener(_workspaceChanged);
    _model.removeListener(_revealSelection);
    _model.dispose();
    super.dispose();
  }

  void _error(Object e) {
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('没有完成：${SessionRuntime.describeError(e)}')),
      );
    }
  }

  Future<void> _remove(Json item) async {
    try {
      final batch = await _model.remove(item);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: const Text('已删除'),
          action: SnackBarAction(
            label: '撤销',
            onPressed: () async {
              try {
                await _model.undo(batch);
              } catch (e) {
                _error(e);
              }
            },
          ),
        ),
      );
    } catch (e) {
      _error(e);
    }
  }

  Future<void> _toggle(bool value) async {
    setState(() => _setting = true);
    try {
      await _agent.updateCoreSettings({'memoryEnabled': value});
    } catch (e) {
      _error(e);
    } finally {
      if (mounted) setState(() => _setting = false);
    }
  }

  Future<void> _add() async {
    final saved = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (_) => _AddMemoryDialog(agent: _agent),
    );
    if (saved == true) await _model.load();
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    return AnimatedBuilder(
      animation: _model,
      builder: (context, _) => LayoutBuilder(
        builder: (context, bounds) => Align(
          alignment: Alignment.topCenter,
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 900),
            child: Padding(
              padding: EdgeInsets.fromLTRB(
                bounds.maxWidth < 600 ? 20 : 40,
                28,
                bounds.maxWidth < 600 ? 20 : 40,
                0,
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Wrap(
                    alignment: WrapAlignment.spaceBetween,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    spacing: 24,
                    runSpacing: 16,
                    children: [
                      const PoeticPageTitle('记忆'),
                      Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text('自动记忆', style: context.text.bodySmall),
                          MotionSwitch(label: '自动记忆',
                            value: agent.coreSettings['memoryEnabled'] != false,
                            onChanged: _setting ? null : _toggle,
                          ),
                        ],
                      ),
                    ],
                  ),
                  const SizedBox(height: 22),
                  Row(
                    children: [
                      TextButton(
                        onPressed: () => setState(() => _recent = false),
                        style: TextButton.styleFrom(
                          foregroundColor: _recent
                              ? context.colors.muted
                              : context.colors.accent,
                        ),
                        child: const Text('全部'),
                      ),
                      TextButton(
                        onPressed: () => setState(() => _recent = true),
                        style: TextButton.styleFrom(
                          foregroundColor: _recent
                              ? context.colors.accent
                              : context.colors.muted,
                        ),
                        child: const Text('最近'),
                      ),
                      const Spacer(),
                      if (!_recent)
                        TextButton.icon(
                          onPressed: _add,
                          icon: const Icon(Icons.add, size: 17),
                          label: const Text('添加记忆'),
                        ),
                    ],
                  ),
                  const Divider(height: 1),
                  if (_model.error != null)
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            '记忆暂时打不开：${_model.error}',
                            style: TextStyle(color: context.colors.danger),
                          ),
                        ),
                        TextButton(
                          onPressed: _model.load,
                          child: const Text('重试'),
                        ),
                      ],
                    ),
                  Expanded(
                    child: _recent
                        ? const MemoryLog()
                        : _model.loading
                        ? const Center(child: CircularProgressIndicator())
                        : ListView(
                            key: const PageStorageKey('memory-groups'),
                            children: [
                              _group(
                                '关于你',
                                _model.items
                                    .where((r) => r['scope'] == 'global')
                                    .toList(),
                              ),
                              _group(
                                '关于这个项目',
                                _model.items
                                    .where(
                                      (r) =>
                                          r['scope'] == 'workspace' ||
                                          r['scope'] == 'group',
                                    )
                                    .toList(),
                              ),
                              _group(
                                '蝶君自己的',
                                _model.items
                                    .where((r) => r['scope'] == 'butterfly')
                                    .toList(),
                              ),
                              const SizedBox(height: 36),
                            ],
                          ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _group(String title, List<Json> rows) => Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 26, bottom: 10),
          child: Text(
            title,
            style: context.text.titleSmall?.copyWith(
              color: context.colors.muted,
            ),
          ),
        ),
        MotionRows(children: [if (rows.isEmpty)
          Padding(
            key: const ValueKey('empty'),
            padding: const EdgeInsets.symmetric(vertical: 16),
            child: Text(
              '还没有',
              style: context.text.bodySmall?.copyWith(
                color: context.colors.muted,
              ),
            ),
          ),
        for (final item in rows)
          KeyedSubtree(
            key: ValueKey(item['id']),
            child: MemoryEditableEntry(
              key: _entryKeys.putIfAbsent(
                item['id'] as String,
                () => GlobalKey<MemoryEditableEntryState>(),
              ),
              item: item,
              agent: _agent,
              highlighted: _selected == item['id'],
              onDelete: _remove,
              onSaved: _model.load,
            ),
          ),]),
      ],
  );
}

class _AddMemoryDialog extends StatefulWidget {
  const _AddMemoryDialog({required this.agent});
  final AgentController agent;
  @override
  State<_AddMemoryDialog> createState() => _AddMemoryDialogState();
}

class _AddMemoryDialogState extends State<_AddMemoryDialog> {
  final _text = TextEditingController();
  String _scope = 'global';
  bool _busy = false;
  String? _error;
  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_busy || _text.text.trim().isEmpty) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final result = memoryMap(
        await widget.agent.backend.call('memory.save', {
          'content': _text.text.trim(),
          'kind': 'background',
          'scope': _scope,
          if (_scope == 'workspace') 'cwd': widget.agent.workspace,
        }),
      );
      checkMemoryChange(result);
      if (memoryRows(result['applied']).isEmpty) throw StateError('没有保存，请重试');
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = SessionRuntime.describeError(e);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: !_busy,
    child: AlertDialog(
      title: const Text('添加记忆'),
      content: SizedBox(
        width: 480,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: _text,
              enabled: !_busy,
              autofocus: true,
              minLines: 2,
              maxLines: 6,
              decoration: const InputDecoration(hintText: '想记下什么？'),
            ),
            const SizedBox(height: 16),
            DropdownButtonFormField<String>(
              initialValue: _scope,
              decoration: const InputDecoration(labelText: '记在哪里'),
              items: const [
                DropdownMenuItem(value: 'global', child: Text('关于你')),
                DropdownMenuItem(value: 'workspace', child: Text('关于这个项目')),
                DropdownMenuItem(value: 'butterfly', child: Text('蝶君自己的')),
              ],
              onChanged: _busy
                  ? null
                  : (value) => setState(() => _scope = value ?? _scope),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(
                  _error!,
                  style: TextStyle(color: context.colors.danger),
                ),
              ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.pop(context, false),
          child: const Text('取消'),
        ),
        FilledButton(onPressed: _busy ? null : _save, child: const Text('添加')),
      ],
    ),
  );
}
