import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'common.dart';
import 'providers_page.dart';

/// Channels and model groups of the model gateway (docs/v0.2-gateway.md):
/// the lists shown under 设置 › 模型与网关, and their editors.

String _money(double v) => v == 0 ? '0' : (v < 0.01 ? v.toStringAsFixed(4) : v.toStringAsFixed(2));

/// Every channel with its state; add, edit, test, remove.
class ChannelList extends StatefulWidget {
  const ChannelList({super.key});

  @override
  State<ChannelList> createState() => _ChannelListState();
}

class _ChannelListState extends State<ChannelList> {
  final _tests = <String, String>{};

  Future<void> _test(AgentController agent, GatewayChannel channel) async {
    setState(() => _tests[channel.id] = '测试中…');
    try {
      final result = asJsonMap(await agent.backend.call('gateway.testChannel', {'channel': channel.id}, const Duration(seconds: 45)));
      setState(() => _tests[channel.id] = result['ok'] == true ? '可用 · ${result['latencyMs']} 毫秒' : '失败：${result['error']}');
    } catch (e) {
      setState(() => _tests[channel.id] = '失败：${SessionRuntime.describeError(e)}');
    }
  }

  Future<void> _remove(AgentController agent, GatewayChannel channel) async {
    final used = agent.modelGroups.where((g) => g.entries.any((e) => e.channel == channel.id)).map((g) => '「${g.name}」').toList();
    final ok = await confirmAction(
      context,
      title: '删除渠道「${channel.name}」？',
      message: '它的 Key 会一起删除。${used.isEmpty ? '' : '用到它的模型组${used.join('、')}会跳过它。'}',
      confirm: '删除',
      danger: true,
    );
    if (!ok) return;
    try {
      await agent.backend.call('gateway.removeChannel', {'id': channel.id});
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(SessionRuntime.describeError(e))));
    }
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final channels = agent.gatewayChannels;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (channels.isEmpty) const EmptyNote('还没有渠道。添加一个，例如 DeepSeek 或智谱编程套餐。'),
        for (final channel in channels)
          _ChannelCard(
            channel: channel,
            test: _tests[channel.id],
            onTest: () => _test(agent, channel),
            onEdit: channel.fromPi
                ? () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const ProvidersPage()))
                : () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ChannelEditorPage(existing: channel))),
            onRemove: channel.fromPi ? null : () => _remove(agent, channel),
          ),
        const SizedBox(height: AppTokens.gap),
        Align(
          alignment: Alignment.centerLeft,
          child: FilledButton.tonalIcon(
            onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const ChannelEditorPage())),
            icon: const Icon(Icons.add, size: 18),
            label: const Text('添加渠道'),
          ),
        ),
      ],
    );
  }
}

class _ChannelCard extends StatelessWidget {
  const _ChannelCard({required this.channel, required this.test, required this.onTest, required this.onEdit, this.onRemove});

  final GatewayChannel channel;
  final String? test;
  final VoidCallback onTest;
  final VoidCallback onEdit;
  final VoidCallback? onRemove;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final down = channel.unavailable;
    final state = down == null ? ('正常', colors.success) : (down.describe(), down.resting ? colors.warning : colors.danger);
    final keys = channel.keys.where((k) => k.enabled).length;
    return OutlinedCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(width: 8, height: 8, decoration: BoxDecoration(color: state.$2, shape: BoxShape.circle)),
              const SizedBox(width: AppTokens.gap),
              Flexible(child: Text(channel.name, style: context.text.titleSmall, overflow: TextOverflow.ellipsis)),
              const SizedBox(width: AppTokens.gap),
              TagChip(channelKindNames[channel.kind] ?? channel.kind, color: channel.kind == 'plan' ? colors.accent : colors.ochre),
              if (channel.fromPi) ...[const SizedBox(width: 6), const TagChip('来自 Pi 配置')],
              const Spacer(),
              TextButton(onPressed: onTest, child: const Text('测试')),
              TextButton(onPressed: onEdit, child: Text(channel.fromPi ? 'Pi 配置' : '编辑')),
              if (onRemove != null) IconButton(tooltip: '删除', onPressed: onRemove, icon: const Icon(Icons.delete_outline, size: 18)),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            [
              state.$1,
              '${channel.models.length} 个模型',
              if (!channel.fromPi) '$keys 个 Key',
              apiLabels[channel.api] ?? channel.api,
            ].join(' · '),
            style: context.text.bodySmall?.copyWith(color: colors.muted),
          ),
          if (test != null) ...[
            const SizedBox(height: 4),
            Text(test!, style: context.text.bodySmall?.copyWith(color: test!.startsWith('失败') ? colors.danger : colors.ink2)),
          ],
        ],
      ),
    );
  }
}

/// Adds or edits a DreamFlutter channel: platform preset, address, keys, models.
class ChannelEditorPage extends StatefulWidget {
  const ChannelEditorPage({super.key, this.existing});

  final GatewayChannel? existing;

  @override
  State<ChannelEditorPage> createState() => _ChannelEditorPageState();
}

class _KeyDraft {
  _KeyDraft({this.id, this.label = '', this.hint = '', this.enabled = true});

  final String? id;
  String label;
  final String hint;
  bool enabled;
  final secret = TextEditingController();
}

class _ChannelEditorPageState extends State<ChannelEditorPage> {
  late final _name = TextEditingController(text: widget.existing?.name ?? '');
  late final _baseUrl = TextEditingController(text: widget.existing?.baseUrl ?? '');
  late final _lowBalance = TextEditingController(text: widget.existing?.lowBalance?.toString() ?? '');
  late final _topUp = TextEditingController(text: widget.existing?.topUp?.toString() ?? '');
  late String? _platform = widget.existing?.platform;
  late String _kind = widget.existing?.kind ?? 'relay';
  late String _api = widget.existing?.api ?? 'openai-completions';
  late final List<ModelEntry> _models = [for (final m in widget.existing?.models ?? const <Json>[]) ModelEntry.fromJson(m)];
  late final List<_KeyDraft> _keys = widget.existing == null
      ? [_KeyDraft()]
      : [for (final k in widget.existing!.keys) _KeyDraft(id: k.id, label: k.label, hint: k.hint, enabled: k.enabled)];
  List<GatewayPlatform> _platforms = const [];
  var _busy = false;
  String? _message;

  bool get _editing => widget.existing != null;
  AgentController get _agent => AgentScope.read(context);
  GatewayPlatform? get _preset => _platforms.where((p) => p.id == _platform).firstOrNull;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      try {
        final list = jsonRows(await _agent.backend.call('gateway.platforms')).map(GatewayPlatform.fromJson).toList();
        if (mounted) setState(() => _platforms = list);
      } catch (_) {}
    });
  }

  @override
  void dispose() {
    for (final c in [_name, _baseUrl, _lowBalance, _topUp]) {
      c.dispose();
    }
    for (final k in _keys) {
      k.secret.dispose();
    }
    super.dispose();
  }

  void _choose(GatewayPlatform platform) {
    setState(() {
      _platform = platform.id;
      _kind = platform.kind;
      if (_name.text.trim().isEmpty || _platforms.any((p) => p.name == _name.text.trim())) _name.text = platform.name;
      if (platform.endpoints.isNotEmpty) {
        _api = platform.endpoints.first.api;
        _baseUrl.text = platform.endpoints.first.baseUrl;
      } else {
        _api = platform.id == 'anthropic-relay' ? 'anthropic-messages' : 'openai-completions';
      }
      if (_models.isEmpty) _models.addAll([for (final m in platform.modelDetails) ModelEntry.fromJson(m)]);
    });
  }

  void _setApi(String api) {
    setState(() {
      _api = api;
      final endpoint = _preset?.endpoints.where((e) => e.api == api).firstOrNull;
      if (endpoint != null) _baseUrl.text = endpoint.baseUrl;
    });
  }

  Future<void> _fetchModels() async {
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final typed = _keys.map((k) => k.secret.text.trim()).where((s) => s.isNotEmpty).firstOrNull;
      final list = await _agent.backend.call('gateway.fetchModels', {
        'baseUrl': _baseUrl.text.trim(),
        'api': _api,
        'platform': ?_platform,
        if (typed != null) 'apiKey': typed else if (_editing) 'channel': widget.existing!.id,
      });
      // Lists that describe their models (limits, prices, thinking levels) fill those in.
      final listed = {for (final m in jsonRows(list)) m['id'] as String: m};
      if (!mounted) return;
      final chosen = await showDialog<List<String>>(context: context, builder: (_) => PickModelsDialog(ids: listed.keys.toList(), existing: _models.map((m) => m.id).toSet()));
      if (chosen != null) {
        setState(() {
          for (final id in chosen) {
            if (_models.every((m) => m.id != id)) _models.add(ModelEntry.fromJson(listed[id]!));
          }
        });
      }
    } catch (e) {
      setState(() => _message = '获取失败：${SessionRuntime.describeError(e)}');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      await _agent.backend.call('gateway.saveChannel', {
        if (_editing) 'id': widget.existing!.id,
        'name': _name.text.trim(),
        'platform': _platform,
        'kind': _kind,
        'api': _api,
        'baseUrl': _baseUrl.text.trim(),
        'models': _models.where((m) => m.id.trim().isNotEmpty).map((m) => m.toJson()).toList(),
        'lowBalance': double.tryParse(_lowBalance.text.trim()),
        'topUp': double.tryParse(_topUp.text.trim()),
        'keys': [
          for (final k in _keys)
            if (k.id != null || k.secret.text.trim().isNotEmpty)
              {
                'id': ?k.id,
                'label': k.label,
                'enabled': k.enabled,
                if (k.id == null) 'secret': k.secret.text.trim(),
              },
        ],
      });
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      setState(() => _message = SessionRuntime.describeError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final preset = _preset;
    final apis = preset != null && preset.endpoints.isNotEmpty ? [for (final e in preset.endpoints) e.api] : ['openai-completions', 'anthropic-messages'];
    return Scaffold(
      appBar: AppBar(
        title: Text(_editing ? '编辑渠道' : '添加渠道'),
        scrolledUnderElevation: 0,
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: AppTokens.pad),
            child: FilledButton(onPressed: _busy ? null : _save, child: const Text('保存')),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.symmetric(horizontal: AppTokens.padLg * 2, vertical: AppTokens.padLg),
        children: [
          Text('平台', style: context.text.labelMedium),
          const SizedBox(height: 6),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (final p in _platforms)
                ChoiceChip(label: Text(p.name), selected: p.id == _platform, onSelected: (_) => _choose(p)),
            ],
          ),
          if (preset != null) ...[
            const SizedBox(height: 6),
            Text(
              '${channelKindNames[preset.kind]}${preset.canQuery ? ' · 会自动查询${preset.kind == 'plan' ? '套餐额度' : '余额'}' : ''}',
              style: context.text.bodySmall?.copyWith(color: colors.muted),
            ),
          ],
          const SizedBox(height: AppTokens.padLg),
          Row(
            children: [
              Expanded(child: TextField(controller: _name, decoration: const InputDecoration(labelText: '渠道名称'))),
              const SizedBox(width: AppTokens.pad),
              SizedBox(
                width: 200,
                child: DropdownButtonFormField<String>(
                  initialValue: _kind,
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: '类型'),
                  items: [for (final e in channelKindNames.entries) DropdownMenuItem(value: e.key, child: Text(e.value, overflow: TextOverflow.ellipsis))],
                  onChanged: (v) => setState(() => _kind = v ?? _kind),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppTokens.pad),
          Row(
            children: [
              SizedBox(
                width: 260,
                child: DropdownButtonFormField<String>(
                  key: ValueKey('api-$_platform'),
                  initialValue: apis.contains(_api) ? _api : apis.first,
                  // Long labels at large text sizes would overflow the fixed width.
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: '接口类型'),
                  items: [for (final api in apis) DropdownMenuItem(value: api, child: Text(apiLabels[api] ?? api, overflow: TextOverflow.ellipsis))],
                  onChanged: (v) => _setApi(v ?? _api),
                ),
              ),
              const SizedBox(width: AppTokens.pad),
              Expanded(
                child: TextField(controller: _baseUrl, decoration: const InputDecoration(labelText: '接口地址（Base URL）', hintText: 'https://api.example.com/v1')),
              ),
            ],
          ),
          const SizedBox(height: AppTokens.padLg),
          Row(
            children: [
              Text('API Key', style: context.text.titleSmall),
              const Spacer(),
              OutlinedButton.icon(onPressed: () => setState(() => _keys.add(_KeyDraft())), icon: const Icon(Icons.add, size: 16), label: const Text('再加一个')),
            ],
          ),
          const SizedBox(height: 4),
          Text('有多个 Key 时轮流使用；某个 Key 出错只停用它。Key 用你的 Windows 账户加密保存。', style: context.text.bodySmall?.copyWith(color: colors.muted)),
          const SizedBox(height: AppTokens.gap),
          for (final (index, key) in _keys.indexed)
            Padding(
              padding: const EdgeInsets.only(bottom: AppTokens.gap),
              child: Row(
                children: [
                  Expanded(
                    child: key.id == null
                        ? TextField(controller: key.secret, obscureText: true, decoration: InputDecoration(labelText: 'Key ${index + 1}', isDense: true))
                        : InputDecorator(
                            decoration: InputDecoration(labelText: 'Key ${index + 1}', isDense: true),
                            child: Text(key.hint.isEmpty ? '已保存（加密）' : '已保存 · 尾号 ${key.hint}'),
                          ),
                  ),
                  const SizedBox(width: AppTokens.gap),
                  SizedBox(
                    width: 160,
                    child: TextFormField(initialValue: key.label, decoration: const InputDecoration(labelText: '备注', isDense: true), onChanged: (v) => key.label = v),
                  ),
                  Switch(value: key.enabled, onChanged: (v) => setState(() => key.enabled = v)),
                  IconButton(tooltip: '移除', onPressed: () => setState(() => _keys.removeAt(index)), icon: const Icon(Icons.close, size: 18)),
                ],
              ),
            ),
          const SizedBox(height: AppTokens.pad),
          Row(
            children: [
              Text('模型', style: context.text.titleSmall),
              const Spacer(),
              OutlinedButton.icon(onPressed: _busy ? null : _fetchModels, icon: const Icon(Icons.cloud_download_outlined, size: 16), label: const Text('获取模型列表')),
              const SizedBox(width: AppTokens.gap),
              OutlinedButton.icon(onPressed: () => setState(() => _models.add(ModelEntry(id: ''))), icon: const Icon(Icons.add, size: 16), label: const Text('手动添加')),
            ],
          ),
          const SizedBox(height: 4),
          Text('价格按每百万 token 的美元填写，用于花费统计；不知道可以留 0。', style: context.text.bodySmall?.copyWith(color: colors.muted)),
          const SizedBox(height: AppTokens.gap),
          for (final (index, model) in _models.indexed) ModelRow(key: ObjectKey(model), model: model, onRemove: () => setState(() => _models.removeAt(index))),
          const SizedBox(height: AppTokens.pad),
          if (_kind != 'plan')
            Row(
              children: [
                SizedBox(
                  width: 220,
                  child: TextField(
                    controller: _lowBalance,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    decoration: const InputDecoration(labelText: '余额低于多少时提醒', hintText: '不提醒'),
                  ),
                ),
                const SizedBox(width: AppTokens.pad),
                if (_kind == 'relay')
                  SizedBox(
                    width: 220,
                    child: TextField(
                      controller: _topUp,
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      decoration: const InputDecoration(labelText: '充值了多少（用来算剩余）', hintText: '不填'),
                    ),
                  ),
              ],
            ),
          if (_message != null) Padding(padding: const EdgeInsets.only(top: AppTokens.pad), child: Text(_message!, style: TextStyle(color: colors.danger))),
          if (_busy) const Padding(padding: EdgeInsets.only(top: AppTokens.pad), child: LinearProgressIndicator()),
        ],
      ),
    );
  }
}

/// The model groups, each as its order of channels.
class GroupList extends StatelessWidget {
  const GroupList({super.key});

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    String entryName(GroupEntry e) {
      final channel = agent.gatewayChannels.where((c) => c.id == e.channel).firstOrNull;
      return '${channel?.name ?? '（已删除的渠道）'} · ${e.model}';
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (agent.modelGroups.isEmpty) const EmptyNote('还没有模型组。模型组把几个渠道的模型排好顺序：前面的用不了时自动换下一个。'),
        for (final group in agent.modelGroups)
          OutlinedCard(
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(group.name, style: context.text.titleSmall),
                      const SizedBox(height: 4),
                      Text(
                        group.entries.isEmpty ? '还没有模型' : _tiers(group).map((tier) => tier.map(entryName).join(' / ')).join('  →  '),
                        style: context.text.bodySmall?.copyWith(color: colors.muted),
                      ),
                      if (!group.allowPaidOverflow)
                        Text('套餐用完后不转到付费渠道', style: context.text.bodySmall?.copyWith(color: colors.ochre)),
                    ],
                  ),
                ),
                TextButton(
                  onPressed: () => showDialog<void>(context: context, builder: (_) => GroupEditorDialog(existing: group)),
                  child: const Text('编辑'),
                ),
                IconButton(
                  tooltip: '删除',
                  icon: const Icon(Icons.delete_outline, size: 18),
                  onPressed: () async {
                    final ok = await confirmAction(context, title: '删除模型组「${group.name}」？', message: '选了这个模型组的会话会提示模型不可用，需要换一个模型。', confirm: '删除', danger: true);
                    if (ok) await agent.backend.call('gateway.removeGroup', {'id': group.id});
                  },
                ),
              ],
            ),
          ),
        const SizedBox(height: AppTokens.gap),
        Align(
          alignment: Alignment.centerLeft,
          child: FilledButton.tonalIcon(
            onPressed: agent.gatewayChannels.isEmpty ? null : () => showDialog<void>(context: context, builder: (_) => const GroupEditorDialog()),
            icon: const Icon(Icons.add, size: 18),
            label: const Text('新建模型组'),
          ),
        ),
      ],
    );
  }

  static List<List<GroupEntry>> _tiers(ModelGroup group) {
    final sorted = [...group.entries]..sort((a, b) => a.priority.compareTo(b.priority));
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
}

/// Name, ordered entries, the optional split within a tier, and the paid-overflow switch.
class GroupEditorDialog extends StatefulWidget {
  const GroupEditorDialog({super.key, this.existing});

  final ModelGroup? existing;

  @override
  State<GroupEditorDialog> createState() => _GroupEditorDialogState();
}

class _Row {
  _Row(this.channel, this.model, {this.withPrevious = false, this.weight = 1});

  final String channel;
  final String model;

  /// Same tier as the entry above: requests are split between them by weight.
  bool withPrevious;
  double weight;
}

class _GroupEditorDialogState extends State<GroupEditorDialog> {
  late final _name = TextEditingController(text: widget.existing?.name ?? '');
  late bool _allowPaid = widget.existing?.allowPaidOverflow ?? true;
  late final List<_Row> _rows = () {
    final sorted = [...?widget.existing?.entries]..sort((a, b) => a.priority.compareTo(b.priority));
    return [
      for (final (i, e) in sorted.indexed)
        _Row(e.channel, e.model, withPrevious: i > 0 && sorted[i - 1].priority == e.priority, weight: e.weight > 0 ? e.weight : 1),
    ];
  }();
  late bool _advanced = _rows.any((r) => r.withPrevious);
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  List<GroupEntry> _entries() {
    final out = <GroupEntry>[];
    var tier = -1;
    for (final (i, row) in _rows.indexed) {
      final joined = _advanced && i > 0 && row.withPrevious;
      if (!joined) tier++;
      out.add(GroupEntry(channel: row.channel, model: row.model, priority: tier));
    }
    // Weights only matter in tiers with more than one entry.
    for (final e in out) {
      final tierSize = out.where((o) => o.priority == e.priority).length;
      final row = _rows[out.indexOf(e)];
      e.weight = tierSize > 1 ? row.weight : 0;
    }
    return out;
  }

  Future<void> _save() async {
    final agent = AgentScope.read(context);
    try {
      await agent.backend.call('gateway.saveGroup', {
        if (widget.existing != null) 'id': widget.existing!.id,
        'name': _name.text.trim(),
        'entries': [for (final e in _entries()) e.toJson()],
        'allowPaidOverflow': _allowPaid,
      });
      if (mounted) Navigator.pop(context);
    } catch (e) {
      setState(() => _error = SessionRuntime.describeError(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final channels = agent.gatewayChannels;
    String channelName(String id) => channels.where((c) => c.id == id).firstOrNull?.name ?? '（已删除的渠道）';
    final hasPlan = _rows.any((r) => channels.where((c) => c.id == r.channel).firstOrNull?.kind == 'plan');
    final options = [
      for (final c in channels)
        for (final m in c.modelIds)
          if (!_rows.any((r) => r.channel == c.id && r.model == m)) (channel: c, model: m),
    ];
    return AlertDialog(
      title: Text(widget.existing == null ? '新建模型组' : '编辑模型组'),
      content: SizedBox(
        width: 560,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(controller: _name, autofocus: widget.existing == null, decoration: const InputDecoration(labelText: '名称', hintText: '例如：主力、快速便宜、看图')),
              const SizedBox(height: AppTokens.padLg),
              Text('按顺序使用：前面的出错、限流或额度用完时，自动换下一个。一个对话会一直用同一个渠道，只在它出错时才换（保住缓存）。', style: context.text.bodySmall?.copyWith(color: colors.muted)),
              const SizedBox(height: AppTokens.gap),
              for (final (i, row) in _rows.indexed)
                ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.only(left: _advanced && row.withPrevious && i > 0 ? 28 : 0),
                  leading: Text(_advanced && row.withPrevious && i > 0 ? '＋' : '${_entries()[i].priority + 1}', style: context.text.titleSmall),
                  title: Text('${channelName(row.channel)} · ${row.model}'),
                  subtitle: _advanced && i > 0
                      ? Row(
                          children: [
                            Checkbox(value: row.withPrevious, visualDensity: VisualDensity.compact, onChanged: (v) => setState(() => row.withPrevious = v ?? false)),
                            const Text('和上一个分流'),
                            if (row.withPrevious || (i + 1 < _rows.length && _rows[i + 1].withPrevious)) ...[
                              const SizedBox(width: AppTokens.pad),
                              SizedBox(
                                width: 72,
                                child: TextFormField(
                                  initialValue: _fmt(row.weight),
                                  decoration: const InputDecoration(labelText: '比例', isDense: true),
                                  keyboardType: TextInputType.number,
                                  onChanged: (v) => row.weight = double.tryParse(v) ?? row.weight,
                                ),
                              ),
                            ],
                          ],
                        )
                      : null,
                  trailing: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      IconButton(
                        tooltip: '上移',
                        onPressed: i == 0 ? null : () => setState(() => _rows.insert(i - 1, _rows.removeAt(i))),
                        icon: const Icon(Icons.arrow_upward, size: 16),
                      ),
                      IconButton(tooltip: '移除', onPressed: () => setState(() => _rows.removeAt(i)), icon: const Icon(Icons.close, size: 16)),
                    ],
                  ),
                ),
              Row(
                children: [
                  PopupMenuButton<({GatewayChannel channel, String model})>(
                    enabled: options.isNotEmpty,
                    tooltip: '添加模型',
                    onSelected: (o) => setState(() => _rows.add(_Row(o.channel.id, o.model))),
                    itemBuilder: (_) => [for (final o in options) PopupMenuItem(value: o, child: Text('${o.channel.name} · ${o.model}'))],
                    child: const Padding(padding: EdgeInsets.all(8), child: Text('＋ 添加模型')),
                  ),
                  const Spacer(),
                  TextButton(onPressed: () => setState(() => _advanced = !_advanced), child: Text(_advanced ? '收起高级' : '高级：按比例分流')),
                ],
              ),
              if (hasPlan)
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  value: _allowPaid,
                  onChanged: (v) => setState(() => _allowPaid = v),
                  title: const Text('套餐用完后允许转到付费渠道'),
                  subtitle: const Text('关闭后，编程套餐的额度用完就停下来，告诉你什么时候恢复。'),
                ),
              if (_error != null) Text(_error!, style: TextStyle(color: colors.danger)),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(onPressed: _rows.isEmpty ? null : _save, child: const Text('保存')),
      ],
    );
  }

  static String _fmt(double v) => v == v.roundToDouble() ? v.toInt().toString() : v.toString();
}

/// A channel's balance or allowance in one line, for the dashboard and lists.
String describeQuota(ChannelStatus status) {
  final quota = status.quota;
  if (quota == null) {
    if (status.remaining != null) return '剩余约 ${_money(status.remaining!)}（按花费估算）';
    return status.kind == 'plan' ? '近 5 小时 ${status.requests5h} 次请求（平台没有额度查询接口）' : '';
  }
  return switch (quota.type) {
    'balance' => '余额 ${_money(quota.amount ?? 0)} ${quota.currency}',
    'plan' => quota.windows.map((w) => '${w.label}已用 ${w.usedPercent.round()}%').join(' · '),
    _ => '查询失败：${quota.message}',
  };
}
