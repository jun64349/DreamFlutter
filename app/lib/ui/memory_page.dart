import 'dart:async';

import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../state/memory_page_model.dart';
import '../state/memory_ui.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'settings_layout.dart' show CardSurface;
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

  /// 0.8.2 (user test: "太乱了，没法快速查阅"): a filter by words and by group.
  final _filter = TextEditingController();
  String _group = '';
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
    _filter.dispose();
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
          persist: false,
          duration: const Duration(seconds: 5),
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
            constraints: const BoxConstraints(maxWidth: 760),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 24, 16, 0),
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
                  const SizedBox(height: 18),
                  Row(
                    children: [
                      _Tab(label: '全部', selected: !_recent, onTap: () => setState(() => _recent = false)),
                      _Tab(label: '最近', selected: _recent, onTap: () => setState(() => _recent = true)),
                      const Spacer(),
                      if (!_recent) ...[
                        SizedBox(
                          width: 200,
                          height: 34,
                          child: TextField(
                            controller: _filter,
                            onChanged: (_) => setState(() {}),
                            style: context.text.bodySmall,
                            decoration: InputDecoration(
                              hintText: '找一条记忆',
                              isDense: true,
                              prefixIcon: const Icon(Icons.search, size: 16),
                              prefixIconConstraints: const BoxConstraints(minWidth: 32),
                              contentPadding: const EdgeInsets.symmetric(vertical: 8),
                              suffixIcon: _filter.text.isEmpty ? null : IconButton(tooltip: '清除', iconSize: 14, onPressed: () => setState(_filter.clear), icon: const Icon(Icons.close)),
                            ),
                          ),
                        ),
                        const SizedBox(width: 10),
                        ShellButton('添加记忆', icon: Icons.add, small: true, onPressed: _add),
                      ],
                    ],
                  ),
                  Divider(height: 1, color: context.colors.border),
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
                        : _groups(),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  static const _groupNames = {'global': '关于你', 'workspace': '关于这个项目', 'butterfly': '蝶君自己的'};
  static String _groupOf(Json r) => r['scope'] == 'group' ? 'workspace' : '${r['scope']}';

  /// The three groups as cards, each entry on its own line between hairlines; a row of group
  /// chips with counts above them filters to one group, the search box by words (0.8.2).
  Widget _groups() {
    final colors = context.colors;
    final words = _filter.text.trim().toLowerCase();
    bool hit(Json r) => words.isEmpty || '${r['content'] ?? ''}'.toLowerCase().contains(words);
    final byGroup = {for (final key in _groupNames.keys) key: _model.items.where((r) => _groupOf(r) == key && hit(r)).toList()};
    final total = byGroup.values.fold<int>(0, (n, rows) => n + rows.length);
    const short = {'global': '你', 'workspace': '这个项目', 'butterfly': '蝶君'};
    Widget chip(String key, String label, int count) => Padding(
      padding: const EdgeInsets.only(right: 8),
      child: ChoiceChip(
        label: Text('$label $count'),
        selected: _group == key,
        showCheckmark: false,
        visualDensity: VisualDensity.compact,
        onSelected: (_) => setState(() => _group = key),
      ),
    );
    return ListView(
      key: const PageStorageKey('memory-groups'),
      padding: const EdgeInsets.only(top: 14),
      children: [
        Wrap(runSpacing: 8, children: [
          chip('', '全部', total),
          for (final e in _groupNames.entries) chip(e.key, short[e.key]!, byGroup[e.key]!.length),
        ]),
        const SizedBox(height: 18),
        for (final e in _groupNames.entries)
          if (_group.isEmpty || _group == e.key) _groupCard(e.key, e.value, byGroup[e.key]!, searching: words.isNotEmpty),
        if (words.isNotEmpty && total == 0)
          Padding(padding: const EdgeInsets.symmetric(vertical: 24), child: Center(child: Text('没有找到', style: context.text.bodySmall?.copyWith(color: colors.muted)))),
        const SizedBox(height: 36),
      ],
    );
  }

  /// Keyed by group so switching the filter moves a card instead of reusing another group's card
  /// by position (its rows fading out would then share GlobalKeys with the same rows coming in).
  Widget _groupCard(String group, String title, List<Json> rows, {bool searching = false}) {
    final colors = context.colors;
    if (searching && rows.isEmpty) return SizedBox.shrink(key: ValueKey('memory-group-$group'));
    return Padding(
      key: ValueKey('memory-group-$group'),
      padding: const EdgeInsets.only(bottom: 22),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
            child: Row(children: [
              ButterflyGlyph(size: 13, color: colors.accent.withValues(alpha: 0.75)),
              const SizedBox(width: 8),
              Text(title, style: context.text.titleSmall?.copyWith(color: colors.ink2, letterSpacing: 0.6)),
              const SizedBox(width: 8),
              Text('${rows.length}', style: context.text.bodySmall?.copyWith(color: colors.muted)),
            ]),
          ),
          CardSurface(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              child: MotionRows(children: [
                if (rows.isEmpty)
                  Padding(
                    key: const ValueKey('empty'),
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 14),
                    child: Text('还没有', style: context.text.bodySmall?.copyWith(color: colors.muted)),
                  ),
                for (final (i, item) in rows.indexed)
                  KeyedSubtree(
                    key: ValueKey(item['id']),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                      if (i > 0) Divider(height: 1, thickness: 0.5, indent: 10, endIndent: 10, color: colors.border),
                      MemoryEditableEntry(
                        key: _entryKeys.putIfAbsent(item['id'] as String, () => GlobalKey<MemoryEditableEntryState>()),
                        item: item,
                        agent: _agent,
                        highlighted: _selected == item['id'],
                        onDelete: _remove,
                        onSaved: _model.load,
                      ),
                    ]),
                  ),
              ]),
            ),
          ),
        ],
      ),
    );
  }
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


/// An underlined tab (.tabs button): ink and an accent bar when selected.
class _Tab extends StatelessWidget {
  const _Tab({required this.label, required this.selected, required this.onTap});
  final String label;
  final bool selected;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => InkWell(
    onTap: onTap,
    child: AnimatedContainer(
      duration: AppTokens.motion(context, AppTokens.medium),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: selected ? context.colors.accent : Colors.transparent, width: 2))),
      child: Text(label, style: context.text.bodyMedium?.copyWith(color: selected ? context.colors.ink : context.colors.muted)),
    ),
  );
}
