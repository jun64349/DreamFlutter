import 'dart:async';

import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'common.dart';
import 'gateway_pages.dart' show ChannelTestResult, channelTestResult, describeChannelFailure;
import 'settings_controls.dart';
import 'settings_layout.dart';

/// Model groups (0.8.3, docs/design/model-groups.md): a queue of channel models used as one model;
/// when the first cannot take a request the next one does. 设置 › 模型 has a card listing them
/// (this file's [GroupList]); a group opens in [GroupEditorPage], laid out like the channel editor.

/// A model of a channel as people know it: the model list's name, else its id.
String channelModelName(GatewayChannel? channel, String model) {
  final m = channel?.models.where((m) => m['id'] == model).firstOrNull;
  return m?['name'] is String ? m!['name'] as String : model;
}

/// The state of one member as a dot colour: usable, resting (comes back by itself), stopped.
Color memberColor(BuildContext context, GatewayChannel? channel, String model) {
  final colors = context.colors;
  if (channel == null || !channel.models.any((m) => m['id'] == model)) return colors.danger;
  if (!channel.enabled) return colors.border;
  final down = channel.unavailable;
  if (down == null) return colors.success;
  return down.resting ? colors.warning : colors.danger;
}

Widget _dot(Color color) => Container(width: 7, height: 7, decoration: BoxDecoration(color: color, shape: BoxShape.circle));

/// The groups in their order; drag a row to reorder, click it to edit.
class GroupList extends StatelessWidget {
  const GroupList({super.key});

  Future<void> _reorder(BuildContext context, AgentController agent, int from, int to) async {
    final ids = agent.modelGroups.map((g) => g.id).toList();
    ids.insert(to, ids.removeAt(from));
    try {
      await agent.backend.call('gateway.reorderGroups', {'ids': ids});
      await agent.refreshGateway(models: true);
    } catch (e) {
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(SessionRuntime.describeError(e))));
    }
  }

  static void open(BuildContext context, ModelGroup? group) =>
      Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => GroupEditorPage(existing: group)));

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final groups = agent.modelGroups;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (groups.isNotEmpty)
          ReorderableListView(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            buildDefaultDragHandles: false,
            onReorderItem: (from, to) => _reorder(context, agent, from, to),
            children: [
              for (final (index, group) in groups.indexed)
                Column(
                  key: ValueKey(group.id),
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (index > 0) Divider(height: 1, thickness: 0.5, color: colors.border),
                    _GroupRow(group: group, index: index, onTap: () => open(context, group)),
                  ],
                ),
            ],
          ),
        if (groups.isNotEmpty) Divider(height: 1, thickness: 0.5, color: colors.border),
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              key: const ValueKey('new-model-group'),
              onPressed: agent.gatewayChannels.isEmpty ? null : () => open(context, null),
              icon: const Icon(Icons.add, size: 18),
              label: const Text('新建模型组'),
            ),
          ),
        ),
      ],
    );
  }
}

/// The members in their tiers: `A → B / C → D` (one tier shares requests), each with its state.
List<List<GroupEntry>> groupTiers(List<GroupEntry> entries) {
  final sorted = [...entries]..sort((a, b) => a.priority.compareTo(b.priority));
  final tiers = <List<GroupEntry>>[];
  for (final e in sorted) {
    if (tiers.isNotEmpty && tiers.last.first.priority == e.priority) {
      tiers.last.add(e);
    } else {
      tiers.add([e]);
    }
  }
  return tiers;
}

class _GroupRow extends StatelessWidget {
  const _GroupRow({required this.group, required this.index, required this.onTap});

  final ModelGroup group;
  final int index;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final muted = context.text.bodySmall?.copyWith(color: colors.muted);
    GatewayChannel? channelOf(GroupEntry e) => agent.gatewayChannels.where((c) => c.id == e.channel).firstOrNull;
    final spans = <InlineSpan>[];
    for (final (t, tier) in groupTiers(group.entries).indexed) {
      if (t > 0) spans.add(TextSpan(text: '  →  ', style: muted));
      for (final (i, e) in tier.indexed) {
        if (i > 0) spans.add(TextSpan(text: ' / ', style: muted));
        final channel = channelOf(e);
        spans.add(WidgetSpan(alignment: PlaceholderAlignment.middle, child: Padding(padding: const EdgeInsets.only(right: 5), child: _dot(memberColor(context, channel, e.model)))));
        spans.add(TextSpan(text: '${channel?.name ?? '（已删除的渠道）'} · ${channelModelName(channel, e.model)}', style: muted));
      }
    }
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Row(
          children: [
            ReorderableDragStartListener(
              index: index,
              child: Tooltip(message: '拖动排序', child: Padding(padding: const EdgeInsets.only(right: 10), child: Icon(Icons.drag_indicator, size: 18, color: colors.muted))),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(group.name, style: context.text.bodyLarge),
                  const SizedBox(height: 3),
                  if (group.entries.isEmpty) Text('还没有模型', style: muted) else Text.rich(TextSpan(children: spans), maxLines: 2, overflow: TextOverflow.ellipsis),
                ],
              ),
            ),
            Icon(Icons.chevron_right, color: colors.muted),
          ],
        ),
      ),
    );
  }
}

class _Member {
  _Member(this.channel, this.model, {this.withPrevious = false, this.weight = 1});

  final String channel;
  final String model;

  /// Takes turns with the member above (same tier): requests are shared by [weight].
  bool withPrevious;
  int weight;

  /// Stable identity for the reorderable list.
  final key = UniqueKey();
}

/// Adds or edits a model group: its name, the queue, and (folded) 「高级」. Like the channel editor,
/// every change is a draft until 「保存」; leaving with unsaved changes asks first.
class GroupEditorPage extends StatefulWidget {
  const GroupEditorPage({super.key, this.existing});

  final ModelGroup? existing;

  @override
  State<GroupEditorPage> createState() => _GroupEditorPageState();
}

class _GroupEditorPageState extends State<GroupEditorPage> {
  late final _name = TextEditingController(text: widget.existing?.name ?? '');
  late bool _allowPaid = widget.existing?.allowPaidOverflow ?? true;
  late final List<_Member> _members = () {
    final sorted = [...?widget.existing?.entries]..sort((a, b) => a.priority.compareTo(b.priority));
    return [
      for (final (i, e) in sorted.indexed)
        _Member(e.channel, e.model, withPrevious: i > 0 && sorted[i - 1].priority == e.priority, weight: e.weight > 0 ? e.weight.round() : 1),
    ];
  }();
  late String? _id = widget.existing?.id;
  final _tests = <Key, ChannelTestResult?>{};
  var _busy = false;
  var _testing = false;
  String? _message;
  String? _saved;

  AgentController get _agent => AgentScope.read(context);
  bool get _editing => _id != null;

  @override
  void initState() {
    super.initState();
    _name.addListener(() { if (mounted) setState(() {}); });
    if (widget.existing != null) _saved = _fingerprint();
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  List<Json> _entries() {
    final out = <Json>[];
    var tier = -1;
    final shared = <int, int>{};
    for (final (i, m) in _members.indexed) {
      if (!(i > 0 && m.withPrevious)) tier++;
      shared[tier] = (shared[tier] ?? 0) + 1;
      out.add({'channel': m.channel, 'model': m.model, 'priority': tier, 'weight': m.weight});
    }
    // A member alone in its tier has nothing to share with: weight 0 means "in list order".
    return [for (final e in out) {...e, 'weight': shared[e['priority']]! > 1 ? e['weight'] : 0}];
  }

  Json _input() => {'id': ?_id, 'name': _name.text.trim(), 'entries': _entries(), 'allowPaidOverflow': _allowPaid};
  String _fingerprint() => _input().toString();
  bool get _dirty => _saved != _fingerprint();

  Future<bool> _save({bool quiet = false}) async {
    if (_busy) return false;
    if (_name.text.trim().isEmpty) {
      setState(() => _message = '给模型组起个名字');
      return false;
    }
    if (_members.isEmpty) {
      setState(() => _message = '至少加一个模型');
      return false;
    }
    setState(() { _busy = true; _message = null; });
    try {
      final result = asJsonMap(await _agent.backend.call('gateway.saveGroup', _input()));
      await _agent.refreshGateway(models: true);
      if (!mounted) return true;
      setState(() { _id = result['id'] as String? ?? _id; _saved = _fingerprint(); });
      if (!quiet) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已保存')));
      return true;
    } catch (e) {
      if (mounted) setState(() => _message = '没有保存：${SessionRuntime.describeError(e)}');
      return false;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Tries every member once, one after another; each result shows on its row.
  Future<void> _test() async {
    setState(() { _testing = true; _message = null; _tests.clear(); });
    for (final m in List.of(_members)) {
      if (!mounted) return;
      setState(() => _tests[m.key] = null);
      ChannelTestResult result;
      try {
        result = channelTestResult(asJsonMap(await _agent.backend.call('gateway.testChannel', {'channel': m.channel, 'model': m.model}, const Duration(seconds: 45))));
      } catch (e) {
        final raw = SessionRuntime.describeError(e);
        result = (ok: false, text: describeChannelFailure(raw), detail: raw);
      }
      if (mounted) setState(() => _tests[m.key] = result);
    }
    if (mounted) setState(() => _testing = false);
  }

  Future<void> _add() async {
    final chosen = await showDialog<List<(String, String)>>(
      context: context,
      builder: (_) => AddMembersDialog(existing: {for (final m in _members) (m.channel, m.model)}),
    );
    if (chosen == null || !mounted) return;
    setState(() => _members.addAll([for (final (c, m) in chosen) _Member(c, m)]));
  }

  Future<void> _remove() async {
    final ok = await confirmAction(context, title: '删除模型组「${_name.text.trim()}」？', message: '选了它的地方会改用默认模型。', confirm: '删除', danger: true);
    if (!ok || !mounted) return;
    try {
      await _agent.backend.call('gateway.removeGroup', {'id': _id});
      await _agent.refreshGateway(models: true);
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      if (mounted) setState(() => _message = SessionRuntime.describeError(e));
    }
  }

  Future<bool> _leave() async {
    if (!_dirty) return true;
    final choice = await showDialog<String>(context: context, builder: (dialog) => AlertDialog(
      title: const Text('改动还没保存'),
      actions: [
        TextButton(onPressed: () => Navigator.pop(dialog, 'discard'), child: const Text('不保存')),
        TextButton(onPressed: () => Navigator.pop(dialog), child: const Text('继续编辑')),
        FilledButton(onPressed: () => Navigator.pop(dialog, 'save'), child: const Text('保存')),
      ],
    ));
    if (choice == 'save') return _save(quiet: true);
    return choice == 'discard';
  }

  String _label(_Member m) {
    final channel = _agent.gatewayChannels.where((c) => c.id == m.channel).firstOrNull;
    return '${channel?.name ?? '（已删除的渠道）'} · ${channelModelName(channel, m.model)}';
  }

  Widget _memberRow(BuildContext context, int index, _Member m) {
    final colors = context.colors;
    final agent = AgentScope.of(context);
    final channel = agent.gatewayChannels.where((c) => c.id == m.channel).firstOrNull;
    final muted = context.text.bodySmall?.copyWith(color: colors.muted);
    final tested = _tests.containsKey(m.key);
    final test = _tests[m.key];
    final down = channel?.unavailable;
    return Column(
      key: m.key,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (index > 0) Divider(height: 1, thickness: 0.5, color: colors.border),
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 10),
          child: Row(children: [
            ReorderableDragStartListener(
              index: index,
              child: Tooltip(message: '拖动排序', child: Padding(padding: const EdgeInsets.only(right: 10), child: Icon(Icons.drag_indicator, size: 18, color: colors.muted))),
            ),
            _dot(memberColor(context, channel, m.model)),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Flexible(child: Text(channel?.name ?? '（已删除的渠道）', maxLines: 1, overflow: TextOverflow.ellipsis, style: context.text.bodyLarge)),
                  if (channel != null) ...[
                    const SizedBox(width: 8),
                    TagChip(channel.oauth && channel.kind == 'plan' ? '订阅' : channelKindNames[channel.kind] ?? channel.kind, color: channel.kind == 'plan' ? colors.accent : colors.ochre),
                  ],
                  if (index > 0 && m.withPrevious) ...[const SizedBox(width: 6), TagChip('和上一个轮流', color: colors.muted)],
                ]),
                const SizedBox(height: 2),
                if (tested && test == null)
                  Text('测试中…', style: muted)
                else if (test != null)
                  Tooltip(message: test.detail ?? '', child: Text(test.text, maxLines: 1, overflow: TextOverflow.ellipsis, style: muted?.copyWith(color: test.ok ? colors.success : colors.danger)))
                else
                  Text([channelModelName(channel, m.model), if (down != null) down.describe()].join(' · '), maxLines: 1, overflow: TextOverflow.ellipsis, style: muted),
              ]),
            ),
            IconButton(tooltip: '移出', onPressed: _testing ? null : () => setState(() => _members.removeAt(index)), icon: const Icon(Icons.close, size: 18)),
          ]),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final muted = context.text.bodySmall?.copyWith(color: colors.muted);
    final failed = _tests.values.whereType<ChannelTestResult>().where((t) => !t.ok).length;
    final done = !_testing && _tests.isNotEmpty;
    return PopScope(
      canPop: !_dirty,
      onPopInvokedWithResult: (popped, _) async {
        if (popped) return;
        if (await _leave() && context.mounted) Navigator.of(context).pop();
      },
      child: Scaffold(
        appBar: AppBar(
          title: Text(_editing ? '编辑模型组' : '新建模型组'),
          scrolledUnderElevation: 0,
          actions: [
            if (_editing) IconButton(tooltip: '删除模型组', onPressed: _busy ? null : _remove, icon: Icon(Icons.delete_outline, color: colors.danger)),
            const SizedBox(width: 8),
          ],
        ),
        body: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: settingsContentWidth),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
              children: [
                SettingsCard(title: '名字', children: [
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: TextField(key: const ValueKey('group-name'), controller: _name, decoration: const InputDecoration(hintText: '例如：GPT-5.5、日常', isDense: true)),
                  ),
                ]),
                SettingsCard(
                  title: '这一队',
                  trailing: TextButton.icon(key: const ValueKey('group-add'), onPressed: _testing ? null : _add, icon: const Icon(Icons.add, size: 16), label: const Text('添加')),
                  children: [
                    if (_members.isEmpty)
                      Padding(padding: const EdgeInsets.symmetric(vertical: 14), child: Text('还没有模型', style: muted))
                    else
                      ReorderableListView(
                        shrinkWrap: true,
                        physics: const NeverScrollableScrollPhysics(),
                        buildDefaultDragHandles: false,
                        onReorderItem: (from, to) => setState(() => _members.insert(to, _members.removeAt(from))),
                        children: [for (final (i, m) in _members.indexed) _memberRow(context, i, m)],
                      ),
                  ],
                ),
                SettingsCard(
                  title: '高级',
                  collapsed: _allowPaid && !_members.any((m) => m.withPrevious),
                  children: [
                    SettingRow('订阅用完后，转到按量付费的渠道', child: Switch(key: const ValueKey('group-allow-paid'), value: _allowPaid, onChanged: (v) => setState(() => _allowPaid = v))),
                    for (final (i, m) in _members.indexed.skip(1))
                      SettingRow(
                        '${_label(m)} 和上一个轮流用',
                        child: Row(mainAxisSize: MainAxisSize.min, children: [
                          if (m.withPrevious)
                            SettingMenu<int>(value: m.weight, choices: const {1: '1 份', 2: '2 份', 3: '3 份', 4: '4 份'}, onSelected: (v) => setState(() => m.weight = v)),
                          Switch(key: ValueKey('group-share-$i'), value: m.withPrevious, onChanged: (v) => setState(() => m.withPrevious = v)),
                        ]),
                      ),
                  ],
                ),
              ],
            ),
          ),
        ),
        bottomNavigationBar: Material(
          color: colors.background,
          child: Container(
            decoration: BoxDecoration(border: Border(top: BorderSide(color: colors.border, width: 0.5))),
            child: Center(
              heightFactor: 1,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: settingsContentWidth),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(24, 10, 24, 12),
                  child: Row(children: [
                    Expanded(
                      child: _message != null
                          ? Text(_message!, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: colors.danger))
                          : _testing
                          ? Row(children: [const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)), const SizedBox(width: 8), Text('正在逐个测试…', style: muted)])
                          : done
                          ? Row(children: [
                              Icon(failed == 0 ? Icons.check_circle : Icons.error_outline, size: 18, color: failed == 0 ? colors.success : colors.warning),
                              const SizedBox(width: 6),
                              Text(failed == 0 ? '都能用' : '$failed 个用不了', style: TextStyle(color: failed == 0 ? colors.success : colors.warning)),
                            ])
                          : _dirty && _editing
                          ? Text('有改动没保存', style: muted)
                          : const SizedBox.shrink(),
                    ),
                    const SizedBox(width: 12),
                    OutlinedButton.icon(onPressed: _busy || _testing || _members.isEmpty ? null : _test, icon: const Icon(Icons.network_check, size: 18), label: const Text('测试')),
                    const SizedBox(width: 10),
                    FilledButton(
                      key: const ValueKey('group-save'),
                      onPressed: _busy || _testing || (_editing && !_dirty) ? null : () async { final wasNew = !_editing; if (await _save() && mounted && wasNew) Navigator.of(this.context).pop(); },
                      child: _busy ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('保存'),
                    ),
                  ]),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A search field and every channel's models in sections; the common ones of a channel come first.
class _ChannelModelPicker extends StatelessWidget {
  const _ChannelModelPicker({required this.query, required this.row});

  final String query;
  final Widget Function(GatewayChannel channel, String model, String name) row;

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final q = query.trim().toLowerCase();
    final children = <Widget>[];
    for (final channel in agent.gatewayChannels) {
      final models = [
        for (final m in channel.models)
          if (q.isEmpty || '${m['id']} ${m['name'] ?? ''} ${channel.name}'.toLowerCase().contains(q)) m['id'] as String,
      ]..sort((a, b) => (channel.isCommon(a) ? 0 : 1).compareTo(channel.isCommon(b) ? 0 : 1));
      if (models.isEmpty) continue;
      children.add(Padding(
        padding: const EdgeInsets.fromLTRB(4, 14, 4, 4),
        child: Text(channel.name, style: context.text.labelMedium?.copyWith(color: colors.muted, letterSpacing: 0.4)),
      ));
      for (final id in models) {
        children.add(row(channel, id, channelModelName(channel, id)));
      }
    }
    if (children.isEmpty) children.add(Padding(padding: const EdgeInsets.all(16), child: Text('没有找到', style: context.text.bodySmall?.copyWith(color: colors.muted))));
    return ListView(shrinkWrap: true, children: children);
  }
}

/// Picks channel models to add to a group; several at once (the same model from three relays).
class AddMembersDialog extends StatefulWidget {
  const AddMembersDialog({super.key, required this.existing});

  final Set<(String, String)> existing;

  @override
  State<AddMembersDialog> createState() => _AddMembersDialogState();
}

class _AddMembersDialogState extends State<AddMembersDialog> {
  final _query = TextEditingController();
  final _chosen = <(String, String)>[];

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('添加到这一队'),
      content: SizedBox(
        width: 480,
        height: 460,
        child: Column(children: [
          TextField(controller: _query, autofocus: true, onChanged: (_) => setState(() {}), decoration: const InputDecoration(prefixIcon: Icon(Icons.search, size: 18), hintText: '找模型', isDense: true)),
          Expanded(
            child: _ChannelModelPicker(
              query: _query.text,
              row: (channel, model, name) {
                final pair = (channel.id, model);
                final already = widget.existing.contains(pair);
                return CheckboxListTile(
                  dense: true,
                  controlAffinity: ListTileControlAffinity.leading,
                  value: already || _chosen.contains(pair),
                  onChanged: already ? null : (v) => setState(() => v == true ? _chosen.add(pair) : _chosen.remove(pair)),
                  title: Text(name),
                  subtitle: name == model ? null : Text(model),
                );
              },
            ),
          ),
        ]),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(onPressed: _chosen.isEmpty ? null : () => Navigator.pop(context, List.of(_chosen)), child: Text(_chosen.isEmpty ? '添加' : '添加 ${_chosen.length} 个')),
      ],
    );
  }
}

/// Which models of a channel the model lists show (0.8.3; a sign-in lists forty-odd).
class CommonModelsDialog extends StatefulWidget {
  const CommonModelsDialog({super.key, required this.channel});

  final GatewayChannel channel;

  @override
  State<CommonModelsDialog> createState() => _CommonModelsDialogState();
}

class _CommonModelsDialogState extends State<CommonModelsDialog> {
  final _query = TextEditingController();
  late final _chosen = {for (final id in widget.channel.modelIds) if (widget.channel.isCommon(id)) id};

  /// The ones in use come first, so the list opens on them; the order stays put while ticking.
  late final _order = [...widget.channel.modelIds.where(_chosen.contains), ...widget.channel.modelIds.where((id) => !_chosen.contains(id))];
  var _busy = false;

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  Future<void> _save(List<String>? models) async {
    setState(() => _busy = true);
    final agent = AgentScope.read(context);
    try {
      await agent.backend.call('gateway.setCommonModels', {'channel': widget.channel.id, 'models': models});
      await agent.refreshGateway(models: true);
      if (mounted) Navigator.pop(context);
    } catch (e) {
      if (mounted) {
        setState(() => _busy = false);
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(SessionRuntime.describeError(e))));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final q = _query.text.trim().toLowerCase();
    final channel = widget.channel;
    final ids = [for (final id in _order) if (q.isEmpty || '$id ${channelModelName(channel, id)}'.toLowerCase().contains(q)) id];
    return AlertDialog(
      title: Text('常用模型 · ${channel.name}'),
      content: SizedBox(
        width: 440,
        height: 440,
        child: Column(children: [
          TextField(controller: _query, onChanged: (_) => setState(() {}), decoration: const InputDecoration(prefixIcon: Icon(Icons.search, size: 18), hintText: '找模型', isDense: true)),
          Expanded(
            child: ListView(children: [
              for (final id in ids)
                CheckboxListTile(
                  dense: true,
                  controlAffinity: ListTileControlAffinity.leading,
                  value: _chosen.contains(id),
                  onChanged: (v) => setState(() => v == true ? _chosen.add(id) : _chosen.remove(id)),
                  title: Text(channelModelName(channel, id)),
                ),
            ]),
          ),
        ]),
      ),
      actions: [
        TextButton(onPressed: _busy ? null : () => _save(null), child: const Text('恢复默认')),
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(
          onPressed: _busy || _chosen.isEmpty ? null : () => _save([for (final id in channel.modelIds) if (_chosen.contains(id)) id]),
          child: Text('保存（${_chosen.length} 个）'),
        ),
      ],
    );
  }
}

/// 「更多模型…」: every model, searchable, in the same sections as the lists.
Future<PiModel?> showModelSearch(BuildContext context) => showDialog<PiModel>(context: context, builder: (_) => const _ModelSearchDialog());

class _ModelSearchDialog extends StatefulWidget {
  const _ModelSearchDialog();

  @override
  State<_ModelSearchDialog> createState() => _ModelSearchDialogState();
}

class _ModelSearchDialogState extends State<_ModelSearchDialog> {
  final _query = TextEditingController();

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final q = _query.text.trim().toLowerCase();
    final children = <Widget>[];
    for (final section in agent.modelSections(all: true)) {
      final models = [for (final m in section.models) if (q.isEmpty || '${m.name} ${m.id} ${section.title}'.toLowerCase().contains(q)) m];
      if (models.isEmpty) continue;
      children.add(Padding(padding: const EdgeInsets.fromLTRB(4, 14, 4, 4), child: Text(section.title, style: context.text.labelMedium?.copyWith(color: colors.muted))));
      for (final m in models) {
        children.add(ListTile(dense: true, title: Text(m.name), onTap: () => Navigator.pop(context, m), selected: m.key == agent.model?.key));
      }
    }
    return AlertDialog(
      title: const Text('所有模型'),
      content: SizedBox(
        width: 460,
        height: 480,
        child: Column(children: [
          TextField(controller: _query, autofocus: true, onChanged: (_) => setState(() {}), decoration: const InputDecoration(prefixIcon: Icon(Icons.search, size: 18), hintText: '找模型', isDense: true)),
          Expanded(child: ListView(children: children)),
        ]),
      ),
      actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消'))],
    );
  }
}
