import 'dart:async';
import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'common.dart';
import 'providers_page.dart';
import 'pi_compatibility_panel.dart';

class ChannelManagementPage extends StatelessWidget {
  const ChannelManagementPage({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(appBar: AppBar(title: const Text('渠道管理')), body: ListView(padding: const EdgeInsets.all(16), children: const [PiCompatibilityPanel(), ChannelList()]));
}

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
    final ok = await confirmAction(
      context,
      title: '删除渠道「${channel.name}」？',
      message: '它的密钥会一起删除。',
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
        for (final channel in channels.where((c) => !c.oauth))
          _ChannelCard(
            channel: channel,
            test: _tests[channel.id],
            onTest: () => _test(agent, channel),
            onEdit: channel.fromPi
                ? () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const ProvidersPage()))
                : () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ChannelEditorPage(existing: channel))),
            onRemove: channel.fromPi ? null : () => _remove(agent, channel),
          ),
        for (final channel in channels.where((c) => c.oauth && (c.enabled || canLoginPiOAuth(c.provider)))) Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(canLoginPiOAuth(channel.provider) ? 'ChatGPT' : channel.name, style: Theme.of(context).textTheme.titleSmall),
          Text(channel.enabled ? '已登录' : '未登录'),
          if (!canLoginPiOAuth(channel.provider)) const Text('保留现有登录，不再提供重新登录。'),
          TextButton(onPressed: () => showDialog<void>(context: context, builder: (_) => PiOAuthDialog(provider: channel.provider, configured: channel.enabled)), child: Text(canLoginPiOAuth(channel.provider) ? (channel.enabled ? '管理 ChatGPT 登录' : '登录 ChatGPT') : '查看登录与退出')),
        ])),
        if (!channels.any((c) => c.oauth && canLoginPiOAuth(c.provider))) Align(alignment: Alignment.centerLeft, child: TextButton(onPressed: () => showDialog<void>(context: context, builder: (_) => const PiOAuthDialog(provider: chatGptPiProviderId, configured: false)), child: const Text('登录 ChatGPT'))),
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
    return ExpansionTile(
      tilePadding:EdgeInsets.zero,
      title:Text(channel.name),
      leading:Icon(Icons.circle,size:8,color:state.$2),
      subtitle:Text(state.$1),
      children:[Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(spacing:8,runSpacing:8,crossAxisAlignment:WrapCrossAlignment.center,
            children: [
              TagChip(channelKindNames[channel.kind] ?? channel.kind, color: channel.kind == 'plan' ? colors.accent : colors.ochre),
              TextButton(onPressed: onTest, child: const Text('测试')),
              TextButton(onPressed: onEdit, child: Text(channel.fromPi ? '原有配置' : '编辑')),
              if (onRemove != null) IconButton(tooltip: '删除', onPressed: onRemove, icon: const Icon(Icons.delete_outline, size: 18)),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            [
              state.$1,
              '${channel.models.length} 个模型',
              apiLabels[channel.api] ?? channel.api,
            ].join(' · '),
            style: context.text.bodySmall?.copyWith(color: colors.muted),
          ),
          if (test != null) ...[
            const SizedBox(height: 4),
            Text(test!, style: context.text.bodySmall?.copyWith(color: test!.startsWith('失败') ? colors.danger : colors.ink2)),
          ],
        ],
      )],
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
  String? _saved;

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

  Future<void> _choosePi(GatewayPlatform platform) async {
    final chosen = await showDialog<List<String>>(context: context, builder: (_) => PickModelsDialog(ids: platform.models, existing: const {}));
    if (chosen == null || chosen.isEmpty || !mounted) return;
    _choose(platform);
    setState(() { _models.clear(); _models.addAll(platform.modelDetails.where((m) => chosen.contains(m['id'])).map(ModelEntry.fromJson)); });
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

  Widget _autoField(Widget child)=>Focus(onFocusChange:(focused){if(!focused&&_editing)unawaited(_save(close:false));},child:child);

  Future<void> _save({bool close=true}) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final input = <String,dynamic>{
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
      };
      final fingerprint=input.toString();
      if(!close&&fingerprint==_saved)return;
      await _agent.backend.call('gateway.saveChannel', input);
      _saved=fingerprint;
      if (mounted&&close) Navigator.pop(context, true);
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
    final apis = <String>{_api, if (preset != null) ...preset.endpoints.map((e) => e.api), 'openai-completions', 'anthropic-messages', 'openai-responses', 'google-generative-ai'}.toList();
    return Scaffold(
      appBar: AppBar(
        title: Text(_editing ? '编辑渠道' : '添加渠道'),
        scrolledUnderElevation: 0,
        actions: [if(!_editing)
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
              for (final p in _platforms.where((p) => !p.id.startsWith('pi-builtin:')))
                ChoiceChip(label: Text(p.name), selected: p.id == _platform, onSelected: (_) => _choose(p)),
            ],
          ),
          const SizedBox(height: 8),
          DropdownButtonFormField<String>(isExpanded: true, decoration: const InputDecoration(labelText: '更多服务商'),
            items: [for (final p in _platforms.where((p) => p.id.startsWith('pi-builtin:'))) DropdownMenuItem(value: p.id, child: Text(p.name, overflow: TextOverflow.ellipsis))],
            onChanged: _busy ? null : (id) { final preset = _platforms.where((p) => p.id == id).firstOrNull; if (preset != null) _choosePi(preset); }),
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
              Expanded(child: _autoField(TextField(controller: _name, decoration: const InputDecoration(labelText: '渠道名称')))),
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
                child: _autoField(TextField(controller: _baseUrl, decoration: const InputDecoration(labelText: '接口地址（Base URL）', hintText: 'https://api.example.com/v1'))),
              ),
            ],
          ),
          const SizedBox(height: AppTokens.padLg),
          Row(
            children: [
              Text('密钥', style: context.text.titleSmall),
              const Spacer(),
              OutlinedButton.icon(onPressed: () => setState(() => _keys.add(_KeyDraft())), icon: const Icon(Icons.add, size: 16), label: const Text('再加一个')),
            ],
          ),
          const SizedBox(height: 4),
          Text('密钥在本机加密保存。', style: context.text.bodySmall?.copyWith(color: colors.muted)),
          const SizedBox(height: AppTokens.gap),
          for (final (index, key) in _keys.indexed)
            Padding(
              padding: const EdgeInsets.only(bottom: AppTokens.gap),
              child: Row(
                children: [
                  Expanded(
                    child: key.id == null
                        ? _autoField(TextField(controller: key.secret, obscureText: true, decoration: InputDecoration(labelText: '密钥 ${index + 1}', isDense: true)))
                        : InputDecorator(
                            decoration: InputDecoration(labelText: '密钥 ${index + 1}', isDense: true),
                            child: Text(key.hint.isEmpty ? '已保存（加密）' : '已保存 · 尾号 ${key.hint}'),
                          ),
                  ),
                  const SizedBox(width: AppTokens.gap),
                  SizedBox(
                    width: 160,
                    child: _autoField(TextFormField(initialValue: key.label, decoration: const InputDecoration(labelText: '备注', isDense: true), onChanged: (v) => key.label = v)),
                  ),
                  Switch(value: key.enabled, onChanged: _busy?null:(v) {setState(() => key.enabled = v);if(_editing)unawaited(_save(close:false));}),
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
          Text('价格按每百万单位的美元填写；未知价格留空。', style: context.text.bodySmall?.copyWith(color: colors.muted)),
          const SizedBox(height: AppTokens.gap),
          for (final (index, model) in _models.indexed) _autoField(ModelRow(
            key: ObjectKey(model), model: model,
            editThinkingLevels: model.thinkingLevels != null || !(_preset?.modelDetails.any((m) => m['id'] == model.id && m['contextWindow'] != null) ?? false),
            onRemove: () => setState(() => _models.removeAt(index)),
          )),
          const SizedBox(height: AppTokens.pad),
          if (_kind != 'plan')
            Row(
              children: [
                SizedBox(
                  width: 220,
                  child: _autoField(TextField(
                    controller: _lowBalance,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    decoration: const InputDecoration(labelText: '余额低于多少时提醒', hintText: '不提醒'),
                  )),
                ),
                const SizedBox(width: AppTokens.pad),
                if (_kind == 'relay')
                  SizedBox(
                    width: 220,
                    child: _autoField(TextField(
                      controller: _topUp,
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      decoration: const InputDecoration(labelText: '充值了多少（用来算剩余）', hintText: '不填'),
                    )),
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

/// A channel's balance or allowance in one line, for the dashboard and lists.
String describeQuota(ChannelStatus status) {
  final quota = status.quota;
  if (quota == null) {
    if (status.remaining != null && status.kind != 'plan') return '剩余约 ${_money(status.remaining!)}（按花费估算）';
    return status.kind == 'plan' ? '本机近 5 小时 ${status.requests5h} 次请求（供应商套餐用量未知）' : '';
  }
  return switch (quota.type) {
    'balance' => quota.balances.isEmpty ? '账户余额 ${quota.amount == null ? '未知' : _money(quota.amount!)} ${quota.currency}' : quota.balances.map((b) => '账户余额 ${b['amount'] is num && (b['amount'] as num).isFinite ? _money((b['amount'] as num).toDouble()) : '未知'} ${b['currency']}').join(' · '),
    'plan' => '供应商套餐用量：${quota.windows.map((w) => '${w.label} ${w.usedPercent == null ? '未知' : '已用 ${w.usedPercent!.round()}%'}').join(' · ')}',
    _ => '查询失败：${quota.message}',
  };
}
