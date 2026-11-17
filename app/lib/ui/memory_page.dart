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
import 'overlay_panel.dart';
import 'proto_icon.dart';
import 'settings_page.dart';
import 'shell_widgets.dart';
import 'notes.dart';

class MemoryOverlay extends StatelessWidget {
  const MemoryOverlay({super.key, required this.onClose});
  final VoidCallback onClose;
  @override
  Widget build(BuildContext context) => ShellOverlay(label: '梦君记', width: 1000, height: 760, padding: 24, color: context.colors.background, onClose: onClose, child: MemoryPage(onClose: onClose));
}

enum _MemoryTab { recent, log, settings }

class MemoryPage extends StatefulWidget {
  const MemoryPage({super.key, this.onClose});
  final VoidCallback? onClose;
  @override
  State<MemoryPage> createState() => _MemoryPageState();
}

class _MemoryPageState extends State<MemoryPage> {
  late final AgentController _agent;
  late final MemoryPageModel _model;
  _MemoryTab _tab = _MemoryTab.recent;
  int _routeRevision = -1;
  String? _selected;
  String? _workspace;

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
    _tab = _agent.memoryUi.tab == 'log' ? _MemoryTab.log : _MemoryTab.recent;
    _selected = _agent.memoryUi.itemId;
    if (mounted) setState(() {});
    _revealSelection();
  }

  void _revealSelection() {
    if (_selected == null || _tab != _MemoryTab.recent) return;
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
      showNote('没有完成：${SessionRuntime.describeError(e)}', kind: NoteKind.fail);
    }
  }

  Future<void> _remove(Json item) async {
    try {
      final batch = await _model.remove(item);
      if (!mounted) return;
      showNote('已删除', action: '撤销', onAction: () async {
              try {
                await _model.undo(batch);
              } catch (e) {
                _error(e);
              }
            });
    } catch (e) {
      _error(e);
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
    // 原型 .fp：底是 --bg；.fp-h 是药丸页签，.fp-b 是内容区（16/24/24）。
    return AnimatedBuilder(
      animation: _model,
      builder: (context, _) => Material(
        color: context.colors.background,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 14, 14, 0),
              child: Row(children: [
                _Tab(icon: 'memory', label: '最近', selected: _tab == _MemoryTab.recent, onTap: () => setState(() => _tab = _MemoryTab.recent)),
                const SizedBox(width: 6),
                _Tab(icon: 'clock', label: '日志', selected: _tab == _MemoryTab.log, onTap: () => setState(() => _tab = _MemoryTab.log)),
                const SizedBox(width: 6),
                _Tab(icon: 'gear', label: '设置', selected: _tab == _MemoryTab.settings, onTap: () => setState(() => _tab = _MemoryTab.settings)),
                const Spacer(),
                if (widget.onClose != null) OverlayCloseButton(onClose: widget.onClose!),
              ]),
            ),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(24, 16, 24, 24),
                child: switch (_tab) {
                  _MemoryTab.recent => _recent(),
                  _MemoryTab.log => const MemoryLog(),
                  _MemoryTab.settings => const SettingsPage(category: '记忆', embedded: true),
                },
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _recent() {
    final colors = context.colors;
    final rows = _filtered();
    // .banner：accent-soft 渐变铺在 card 底上，左边书法字标题，右边搜索。
    final banner = Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 18),
      decoration: BoxDecoration(
        color: colors.card,
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [colors.accentSoft, colors.accentSoft.withValues(alpha: 0)],
          stops: const [0, 0.7],
        ),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: colors.hairline),
      ),
      child: LayoutBuilder(builder: (context, bounds) {
        final title = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('梦君记', style: context.handwriting(context.text.headlineSmall).copyWith(fontSize: 28, letterSpacing: 2.24, height: 1.6)),
          Text('它记得的事，按天排。点一条就能改，删了能撤销', style: context.text.bodySmall?.copyWith(fontSize: 12.5, height: 1.6, color: colors.muted)),
        ]);
        final border = OutlineInputBorder(borderRadius: BorderRadius.circular(9), borderSide: BorderSide.none);
        final search = SizedBox(width: 240, child: TextField(
            controller: _filter,
            onChanged: (_) => setState(() {}),
            style: context.text.bodySmall?.copyWith(fontSize: 13, height: 1.6),
            decoration: InputDecoration(
              hintText: '搜索记忆',
              isDense: true,
              fillColor: colors.sunk,
              filled: true,
              border: border,
              enabledBorder: border,
              prefixIcon: Center(widthFactor: 1, heightFactor: 1, child: ProtoIcon('search', size: 14, color: colors.muted)),
              prefixIconConstraints: const BoxConstraints(minWidth: 32),
              contentPadding: const EdgeInsets.symmetric(vertical: 7, horizontal: 10),
              suffixIconConstraints: const BoxConstraints.tightFor(width: 30, height: 30),
              suffixIcon: _filter.text.isEmpty ? null : IconButton(tooltip: '清除', padding: EdgeInsets.zero, onPressed: () => setState(_filter.clear), icon: ProtoIcon('x', size: 14, color: colors.muted)),
            ),
        ));
        return bounds.maxWidth < 480
            ? Column(crossAxisAlignment: CrossAxisAlignment.start, children: [title, const SizedBox(height: 8), search])
            : Row(children: [Expanded(child: title), const SizedBox(width: 16), search]);
      }),
    );
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      banner,
      if (_model.error != null)
        Row(children: [
          Expanded(child: Text('记忆暂时打不开：${_model.error}', style: TextStyle(color: colors.danger))),
          TextButton(onPressed: _model.load, child: const Text('重试')),
        ]),
      Expanded(child: _model.loading ? const Center(child: CircularProgressIndicator()) : _groups(rows)),
    ]);
  }

  static const _groupNames = {'global': '关于你', 'workspace': '项目', 'butterflySelf': '蝶君自己记的', 'butterfly': '蝶君自己的'};
  static String _groupOf(Json r) => r['scope']=='butterfly'&&r['createdBy']=='main_agent'?'butterflySelf':r['scope'] == 'group' ? 'workspace' : '${r['scope']}';

  /// 搜索过滤后的条目，按更新时间从新到旧。
  List<Json> _filtered() {
    final words = _filter.text.trim().toLowerCase();
    bool hit(Json r) => words.isEmpty || '${r['content'] ?? ''}'.toLowerCase().contains(words);
    return _model.items.where(hit).toList()..sort((a, b) => ((b['updatedAt'] as num?)?.toInt() ?? 0).compareTo((a['updatedAt'] as num?)?.toInt() ?? 0));
  }

  Widget _groups(List<Json> rows) {
    final colors = context.colors;
    final byGroup = {for (final key in _groupNames.keys) key: rows.where((r) => _groupOf(r) == key).toList()};
    final total = rows.length;
    Widget chip(String key, String label, int count) => Tooltip(
      message: '$label $count',
      child: ChoiceChip(
        label: Text(label, style: context.text.bodySmall?.copyWith(fontSize: 13, height: 1.6, color: _group == key ? colors.ink : colors.ink2)),
        selected: _group == key,
        showCheckmark: false,
        shape: const StadiumBorder(),
        backgroundColor: colors.card,
        selectedColor: colors.accentSoft,
        side: BorderSide(color: _group == key ? colors.accent : colors.border),
        labelPadding: EdgeInsets.zero,
        padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 6),
        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
        visualDensity: VisualDensity.standard,
        onSelected: (_) => setState(() => _group = key),
      ),
    );
    final hasUserButterflyMemory = _group == 'butterfly' || _model.items.any((row) => _groupOf(row) == 'butterfly');
    DateTime dayOf(Json row) {
      final stamp = (row['updatedAt'] as num?)?.toInt();
      final date = stamp == null ? DateTime.fromMillisecondsSinceEpoch(0) : DateTime.fromMillisecondsSinceEpoch(stamp);
      return DateTime(date.year, date.month, date.day);
    }
    String dayLabel(DateTime day) {
      final now = DateTime.now(), today = DateTime(now.year, now.month, now.day);
      if (day == today) return '今天';
      if (day == today.subtract(const Duration(days: 1))) return '昨天';
      return day.year == today.year ? '${day.month}月${day.day}日' : '${day.year}年${day.month}月${day.day}日';
    }
    final shown = _group.isEmpty ? rows : rows.where((r) => _groupOf(r) == _group).toList();
    final days = shown.map(dayOf).toSet().toList()..sort((a, b) => b.compareTo(a));
    // .tl：左边一条 1px 竖线，每天一个 accent 圈点（.tli::before）。
    final timeline = Stack(children: [
      if (days.isNotEmpty) Positioned(left: 5, top: 6, bottom: 6, child: Container(width: 1, color: colors.border)),
      Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        for (final day in days) _daySection(dayLabel(day), shown.where((r) => dayOf(r) == day).toList()),
      ]),
    ]);
    return ListView(
      key: const PageStorageKey('memory-groups'),
      children: [
        Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
          Expanded(child: Wrap(spacing: 8, runSpacing: 8, children: [
            chip('', '全部', total),
            for (final e in _groupNames.entries)
              if (e.key != 'butterfly' || hasUserButterflyMemory) chip(e.key, e.value, byGroup[e.key]!.length),
          ])),
          IconButton(tooltip: '添加记忆', icon: ProtoIcon('plus', color: colors.ink2), onPressed: _add),
        ]),
        const SizedBox(height: 14),
        timeline,
        if (total == 0)
          Padding(padding: const EdgeInsets.symmetric(vertical: 24), child: Center(child: Text(_filter.text.trim().isEmpty ? '还没有记忆' : '没有找到', style: context.text.bodySmall?.copyWith(color: colors.muted)))),
        const SizedBox(height: 36),
      ],
    );
  }

  /// 一天：左边的圈点 + 日期小字 + 这天的记忆卡（.tli）。
  Widget _daySection(String label, List<Json> rows) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Stack(children: [
        Positioned(left: 0, top: 6, child: Container(
          width: 9, height: 9,
          decoration: BoxDecoration(color: colors.card, shape: BoxShape.circle, border: Border.all(color: colors.accent, width: 2)),
        )),
        Padding(
          padding: const EdgeInsets.only(left: 22),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(label, style: context.text.bodySmall?.copyWith(fontSize: 12, color: colors.muted)),
            for (final item in rows) Padding(padding: const EdgeInsets.only(top: 8), child: _memoryCard(item)),
          ]),
        ),
      ]),
    );
  }

  /// 一条记忆卡（.mcard）：左边书法字记号，中间内容，右边分组小标签。
  Widget _memoryCard(Json item) {
    final colors = context.colors;
    final group = _groupOf(item);
    String mark(Json it) {
      final text = (it['content'] as String? ?? '').trim();
      if (text.isEmpty) return '记';
      final first = text.split(RegExp(r'[\s，。；：、！？,.!?;:]')).firstWhere((s) => s.isNotEmpty, orElse: () => '记');
      return first.characters.first;
    }
    return KeyedSubtree(
      key: ValueKey(item['id']),
      child: CardSurface(
        radius: 12,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            SizedBox(width: 32, child: Text(mark(item), key: ValueKey('memory-mark-${item['id']}'), textAlign: TextAlign.center, style: context.handwriting(context.text.titleLarge).copyWith(fontSize: 26, height: 1, color: colors.accent))),
            const SizedBox(width: 12),
            Expanded(child: MemoryEditableEntry(
                key: _entryKeys.putIfAbsent(item['id'] as String, () => GlobalKey<MemoryEditableEntryState>()),
                item: item,
                agent: _agent,
                highlighted: _selected == item['id'],
                headingStyle: true,
                showEditButton: true,
                actionLeading: _GroupTag(group: group),
                onDelete: _remove,
                onSaved: _model.load,
            )),
          ]),
        ),
      ),
    );
  }
}

/// .tag：分组小标签；「蝶君自己记的」用 .tag.bf 的 accent 色，其余用默认的绿色。
class _GroupTag extends StatelessWidget {
  const _GroupTag({required this.group});
  final String group;
  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final self = group == 'butterflySelf';
    const names = {'global': '关于你', 'workspace': '项目', 'butterfly': '蝶君自己的', 'butterflySelf': '蝶君自己记的'};
    final fg = self ? colors.accent : colors.success;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
      decoration: BoxDecoration(
        color: self ? colors.accentSoft : fg.withValues(alpha: 0.13),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(names[group] ?? group, style: context.text.bodySmall?.copyWith(fontSize: 11, color: fg)),
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


/// 原型 .fp-h .tb 的页签：小图标 + 字，选中时 card 底加一圈细线。
class _Tab extends StatelessWidget {
  const _Tab({required this.icon, required this.label, required this.selected, required this.onTap});
  final String icon;
  final String label;
  final bool selected;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final fg = selected ? colors.ink : colors.muted;
    return Material(
      color: selected ? colors.card : Colors.transparent,
      borderRadius: BorderRadius.circular(9),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(9),
        child: AnimatedContainer(
          duration: AppTokens.motion(context, AppTokens.medium),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(9),
            border: Border.all(color: selected ? colors.hairline : Colors.transparent),
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            ProtoIcon(icon, size: 15, color: fg),
            const SizedBox(width: 6),
            Text(label, style: context.text.bodyMedium?.copyWith(fontSize: 13.5, color: fg, fontWeight: selected ? FontWeight.w500 : FontWeight.w400)),
          ]),
        ),
      ),
    );
  }
}
