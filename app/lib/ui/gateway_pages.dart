import 'dart:async';
import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'common.dart';
import 'model_group_pages.dart' show CommonModelsDialog;
import 'providers_page.dart';
import 'pi_compatibility_panel.dart';
import 'settings_controls.dart';
import 'settings_layout.dart';

class ChannelManagementPage extends StatelessWidget {
  const ChannelManagementPage({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(appBar: AppBar(title: const Text('渠道管理')), body: ListView(padding: const EdgeInsets.all(16), children: const [PiCompatibilityPanel(), ChannelList()]));
}

/// Channels of the model gateway (docs/v0.2-gateway.md): the list under
/// 设置 › 模型, and its editor.

String _money(double v) => v == 0 ? '0' : (v < 0.01 ? v.toStringAsFixed(4) : v.toStringAsFixed(2));

/// A failed test or request in plain words (0.8.2, user test: the raw JSON of a 404 was shown).
String describeChannelFailure(String raw) {
  final text = raw.toLowerCase();
  final code = RegExp(r'\b(4\d\d|5\d\d)\b').firstMatch(raw)?.group(1);
  if (code == '401' || code == '403' || text.contains('unauthorized') || text.contains('invalid api key') || text.contains('forbidden')) return '密钥不对，或者这个密钥没有权限';
  if (code == '404' || text.contains('not found')) return '服务器找不到这个地址：检查接口地址和接口类型';
  if (code == '429' || text.contains('rate limit') || text.contains('quota')) return '请求太多或额度用完了，稍后再试';
  if (code != null && code.startsWith('5')) return '服务商那边出错了（$code），稍后再试';
  if (text.contains('timeout') || text.contains('timed out')) return '连接超时：服务器没有回应';
  if (text.contains('enotfound') || text.contains('econnrefused') || text.contains('fetch failed') || text.contains('network')) return '连不上服务器：检查网络、代理或接口地址';
  return raw.length > 120 ? '${raw.substring(0, 120)}…' : raw;
}

/// The result of a connection test: (ok, line to show, raw detail).
typedef ChannelTestResult = ({bool ok, String text, String? detail});

ChannelTestResult channelTestResult(Json result) => result['ok'] == true
    ? (ok: true, text: '可用 · ${result['latencyMs']} 毫秒', detail: null)
    : (ok: false, text: describeChannelFailure('${result['error']}'), detail: '${result['error']}');

/// Every channel with its state (0.8.2: one row each, like the prototype's list → detail):
/// click a row to edit it; the test runs from the row.
class ChannelList extends StatefulWidget {
  const ChannelList({super.key});

  @override
  State<ChannelList> createState() => _ChannelListState();
}

class _ChannelListState extends State<ChannelList> {
  final _tests = <String, ChannelTestResult?>{};

  Future<void> _test(AgentController agent, GatewayChannel channel) async {
    setState(() => _tests[channel.id] = null);
    ChannelTestResult result;
    try {
      result = channelTestResult(asJsonMap(await agent.backend.call('gateway.testChannel', {'channel': channel.id}, const Duration(seconds: 45))));
    } catch (e) {
      final raw = SessionRuntime.describeError(e);
      result = (ok: false, text: describeChannelFailure(raw), detail: raw);
    }
    if (mounted) setState(() => _tests[channel.id] = result);
  }

  void _edit(GatewayChannel? channel) => Navigator.of(context).push(MaterialPageRoute<void>(
    builder: (_) => channel?.fromPi == true ? const ProvidersPage() : ChannelEditorPage(existing: channel),
  ));

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final channels = agent.gatewayChannels;
    final rows = <Widget>[
      for (final channel in channels.where((c) => !c.oauth))
        _ChannelRow(
          channel: channel,
          testing: _tests.containsKey(channel.id) && _tests[channel.id] == null,
          test: _tests[channel.id],
          onTest: () => _test(agent, channel),
          onEdit: () => _edit(channel),
        ),
      for (final channel in channels.where((c) => c.oauth && (c.enabled || canLoginPiOAuth(c.provider))))
        _OAuthRow(
          name: canLoginPiOAuth(channel.provider) ? 'ChatGPT' : channel.name,
          signedIn: channel.enabled,
          onCommon: channel.enabled && channel.models.length > 1 ? () => showDialog<void>(context: context, builder: (_) => CommonModelsDialog(channel: channel)) : null,
          action: canLoginPiOAuth(channel.provider) ? (channel.enabled ? '管理 ChatGPT 登录' : '登录 ChatGPT') : '查看登录与退出',
          onTap: () => showDialog<void>(context: context, builder: (_) => PiOAuthDialog(provider: channel.provider, configured: channel.enabled)),
        ),
      if (!channels.any((c) => c.oauth && canLoginPiOAuth(c.provider)))
        _OAuthRow(name: 'ChatGPT', signedIn: false, action: '登录 ChatGPT', onTap: () => showDialog<void>(context: context, builder: (_) => const PiOAuthDialog(provider: chatGptPiProviderId, configured: false))),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (channels.where((c) => !c.oauth).isEmpty) const Padding(padding: EdgeInsets.only(top: 12), child: EmptyNote('还没有渠道。添加一个，例如 DeepSeek 或智谱编程套餐。')),
        for (final (i, row) in rows.indexed) ...[
          if (i > 0) Divider(height: 1, thickness: 0.5, color: colors.border),
          row,
        ],
        Divider(height: 1, thickness: 0.5, color: colors.border),
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(onPressed: () => _edit(null), icon: const Icon(Icons.add, size: 18), label: const Text('添加渠道')),
          ),
        ),
      ],
    );
  }
}

class _ChannelRow extends StatelessWidget {
  const _ChannelRow({required this.channel, required this.testing, required this.test, required this.onTest, required this.onEdit});

  final GatewayChannel channel;
  final bool testing;
  final ChannelTestResult? test;
  final VoidCallback onTest;
  final VoidCallback onEdit;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final down = channel.unavailable;
    final state = down == null ? ('正常', colors.success) : (down.describe(), down.resting ? colors.warning : colors.danger);
    final muted = context.text.bodySmall?.copyWith(color: colors.muted);
    final test = this.test;
    return InkWell(
      onTap: onEdit,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Row(
          children: [
            Container(width: 8, height: 8, decoration: BoxDecoration(color: state.$2, shape: BoxShape.circle)),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(children: [
                    Flexible(child: Text(channel.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: context.text.bodyLarge)),
                    const SizedBox(width: 8),
                    TagChip(channel.fromPi ? '原有配置' : channelKindNames[channel.kind] ?? channel.kind, color: channel.kind == 'plan' ? colors.accent : colors.ochre),
                  ]),
                  const SizedBox(height: 2),
                  if (testing)
                    Text('测试中…', style: muted)
                  else if (test != null)
                    Tooltip(message: test.detail ?? '', child: Text(test.text, maxLines: 1, overflow: TextOverflow.ellipsis, style: muted?.copyWith(color: test.ok ? colors.success : colors.danger)))
                  else
                    Text('${state.$1} · ${channel.models.length} 个模型 · ${apiLabels[channel.api] ?? channel.api}', maxLines: 1, overflow: TextOverflow.ellipsis, style: muted),
                ],
              ),
            ),
            const SizedBox(width: 8),
            OutlinedButton(
              onPressed: testing ? null : onTest,
              style: OutlinedButton.styleFrom(visualDensity: VisualDensity.compact),
              child: const Text('测试'),
            ),
            const SizedBox(width: 4),
            Icon(Icons.chevron_right, color: colors.muted),
          ],
        ),
      ),
    );
  }
}

class _OAuthRow extends StatelessWidget {
  const _OAuthRow({required this.name, required this.signedIn, required this.action, required this.onTap, this.onCommon});
  final String name;
  final VoidCallback? onCommon;
  final bool signedIn;
  final String action;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(children: [
        Container(width: 8, height: 8, decoration: BoxDecoration(color: signedIn ? colors.success : colors.border, shape: BoxShape.circle)),
        const SizedBox(width: 14),
        Expanded(child: Text(name, style: context.text.bodyLarge)),
        Text(signedIn ? '已登录' : '未登录', style: context.text.bodySmall?.copyWith(color: colors.muted)),
        const SizedBox(width: 8),
        if (onCommon != null) TextButton(key: ValueKey('oauth-common-$name'), onPressed: onCommon, child: const Text('常用模型')),
        TextButton(onPressed: onTap, child: Text(action)),
      ]),
    );
  }
}

/// Adds or edits a DreamFlutter channel (0.8.2 rewrite, user test: "没有测试保存的按键，
/// 修改不了已选项"). Every change is a draft until 「保存」; 「测试连接」 saves and then tests.
/// The parts sit in cards like the settings page; a model opens in its own dialog.
class ChannelEditorPage extends StatefulWidget {
  const ChannelEditorPage({super.key, this.existing});

  final GatewayChannel? existing;

  @override
  State<ChannelEditorPage> createState() => _ChannelEditorPageState();
}

class _KeyDraft {
  _KeyDraft({this.id, this.label = '', this.hint = '', this.enabled = true}) : labelText = TextEditingController(text: label);

  final String? id;
  String label;
  final String hint;
  bool enabled;
  final secret = TextEditingController();
  final TextEditingController labelText;
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
  late String? _id = widget.existing?.id;
  List<GatewayPlatform> _platforms = const [];
  var _busy = false;
  var _testing = false;
  String? _message;
  ChannelTestResult? _test;

  /// What was last saved (or loaded), to tell whether there are unsaved changes.
  String? _saved;

  bool get _editing => _id != null;
  AgentController get _agent => AgentScope.read(context);
  GatewayPlatform? get _preset => _platforms.where((p) => p.id == _platform).firstOrNull;

  @override
  void initState() {
    super.initState();
    for (final c in [_name, _baseUrl, _lowBalance, _topUp]) {
      c.addListener(_changed);
    }
    for (final k in _keys) {
      k.secret.addListener(_changed);
      k.labelText.addListener(_changed);
    }
    if (widget.existing != null) _saved = _fingerprint();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      try {
        final list = jsonRows(await _agent.backend.call('gateway.platforms')).map(GatewayPlatform.fromJson).toList();
        if (mounted) setState(() => _platforms = list);
      } catch (_) {}
    });
  }

  void _changed() { if (mounted) setState(() {}); }

  @override
  void dispose() {
    for (final c in [_name, _baseUrl, _lowBalance, _topUp]) {
      c.dispose();
    }
    for (final k in _keys) {
      k.secret.dispose();
      k.labelText.dispose();
    }
    super.dispose();
  }

  Map<String, dynamic> _input() => {
    'id': ?_id,
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
            'label': k.labelText.text.trim(),
            'enabled': k.enabled,
            if (k.id == null) 'secret': k.secret.text.trim(),
          },
    ],
  };

  String _fingerprint() => _input().toString();
  bool get _dirty => _saved != _fingerprint();

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
      _test = null;
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
      _test = null;
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
        if (typed != null) 'apiKey': typed else if (_editing) 'channel': _id,
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
      setState(() => _message = '获取失败：${describeChannelFailure(SessionRuntime.describeError(e))}');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Saves the draft; returns whether it worked.
  Future<bool> _save({bool quiet = false}) async {
    if (_busy) return false;
    if (_models.any((m) => m.thinkingLevels?.isEmpty == true)) {
      setState(() => _message = '有模型一个思考档位都没选，至少选一个');
      return false;
    }
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final input = _input();
      final result = asJsonMap(await _agent.backend.call('gateway.saveChannel', input));
      final id = result['id'] as String? ?? _id;
      // The keys come back from the core's list; read it before taking them.
      await _agent.refreshGateway();
      if (!mounted) return true;
      setState(() {
        _id = id;
        // Saved secrets become saved keys: the next save must not send them again.
        _refreshKeys();
        _saved = _fingerprint();
      });
      if (!quiet) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已保存')));
      return true;
    } catch (e) {
      if (mounted) setState(() => _message = '没有保存：${SessionRuntime.describeError(e)}');
      return false;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// After a save, takes the keys as the core now has them (new secrets have ids and hints).
  void _refreshKeys() {
    final saved = _agent.gatewayChannels.where((c) => c.id == _id).firstOrNull;
    if (saved == null) return;
    for (final k in _keys) {
      k.secret.removeListener(_changed);
      k.labelText.removeListener(_changed);
    }
    _keys
      ..clear()
      ..addAll([for (final k in saved.keys) _KeyDraft(id: k.id, label: k.label, hint: k.hint, enabled: k.enabled)]);
    for (final k in _keys) {
      k.secret.addListener(_changed);
      k.labelText.addListener(_changed);
    }
  }

  Future<void> _saveAndTest() async {
    if (_dirty || !_editing) {
      if (!await _save(quiet: true)) return;
    }
    if (!mounted || _id == null) return;
    setState(() { _testing = true; _test = null; });
    ChannelTestResult result;
    try {
      result = channelTestResult(asJsonMap(await _agent.backend.call('gateway.testChannel', {'channel': _id}, const Duration(seconds: 45))));
    } catch (e) {
      final raw = SessionRuntime.describeError(e);
      result = (ok: false, text: describeChannelFailure(raw), detail: raw);
    }
    if (mounted) setState(() { _testing = false; _test = result; });
  }

  Future<void> _remove() async {
    final ok = await confirmAction(context, title: '删除渠道「${_name.text.trim()}」？', message: '它的密钥会一起删除。', confirm: '删除', danger: true);
    if (!ok || !mounted) return;
    try {
      await _agent.backend.call('gateway.removeChannel', {'id': _id});
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      if (mounted) setState(() => _message = SessionRuntime.describeError(e));
    }
  }

  Future<void> _editModel(ModelEntry? model) async {
    final draft = model == null ? ModelEntry(id: '') : ModelEntry.fromJson(model.toJson());
    final saved = await showDialog<ModelEntry>(context: context, builder: (_) => _ModelDialog(model: draft, adding: model == null));
    if (saved == null || !mounted) return;
    setState(() {
      final index = model == null ? -1 : _models.indexOf(model);
      if (index < 0) { _models.add(saved); } else { _models[index] = saved; }
    });
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

  Widget _field(TextEditingController c, String label, {String? hint, bool secret = false, TextInputType? keyboard, String? suffix}) => TextField(
    controller: c,
    obscureText: secret,
    keyboardType: keyboard,
    decoration: InputDecoration(labelText: label, hintText: hint, isDense: true, suffixText: suffix),
  );

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final muted = context.text.bodySmall?.copyWith(color: colors.muted);
    final preset = _preset;
    final apis = <String>{_api, if (preset != null) ...preset.endpoints.map((e) => e.api), 'openai-completions', 'anthropic-messages', 'openai-responses', 'google-generative-ai'}.toList();
    final test = _test;
    return PopScope(
      canPop: !_dirty,
      onPopInvokedWithResult: (popped, _) async {
        if (popped) return;
        if (await _leave() && context.mounted) Navigator.of(context).pop();
      },
      child: Scaffold(
        appBar: AppBar(
          title: Text(_editing ? '编辑渠道' : '添加渠道'),
          scrolledUnderElevation: 0,
          actions: [
            if (_editing) IconButton(tooltip: '删除渠道', onPressed: _busy ? null : _remove, icon: Icon(Icons.delete_outline, color: colors.danger)),
            const SizedBox(width: 8),
          ],
        ),
        body: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: settingsContentWidth),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
              children: [
                SettingsCard(title: '服务商', children: [
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: [
                        for (final p in _platforms.where((p) => !p.id.startsWith('pi-builtin:')))
                          ChoiceChip(label: Text(p.name), selected: p.id == _platform, onSelected: (_) => _choose(p)),
                      ],
                    ),
                  ),
                  SettingRow('更多服务商', child: SettingMenu<String>(
                    value: _platform?.startsWith('pi-builtin:') == true ? _platform! : '',
                    label: _platform?.startsWith('pi-builtin:') == true ? null : '选择…',
                    choices: {'': '选择…', for (final p in _platforms.where((p) => p.id.startsWith('pi-builtin:'))) p.id: p.name},
                    enabled: !_busy,
                    onSelected: (id) { final p = _platforms.where((p) => p.id == id).firstOrNull; if (p != null) _choosePi(p); },
                  )),
                ]),
                SettingsCard(title: '连接', children: [
                  Padding(padding: const EdgeInsets.only(top: 12, bottom: 8), child: _field(_name, '渠道名称')),
                  SettingRow('类型', child: SettingMenu<String>(value: _kind, choices: channelKindNames, onSelected: (v) => setState(() => _kind = v))),
                  SettingRow('接口类型', child: SettingMenu<String>(value: apis.contains(_api) ? _api : apis.first, choices: {for (final a in apis) a: apiLabels[a] ?? a}, onSelected: _setApi)),
                  Padding(padding: const EdgeInsets.only(top: 8, bottom: 12), child: _field(_baseUrl, '接口地址（Base URL）', hint: 'https://api.example.com/v1')),
                ]),
                SettingsCard(
                  title: '密钥',
                  trailing: TextButton.icon(onPressed: () => setState(() { final k = _KeyDraft(); k.secret.addListener(_changed); k.labelText.addListener(_changed); _keys.add(k); }), icon: const Icon(Icons.add, size: 16), label: const Text('再加一个')),
                  children: [
                    if (_keys.isEmpty) Padding(padding: const EdgeInsets.symmetric(vertical: 14), child: Text('没有密钥', style: muted)),
                    for (final (index, key) in _keys.indexed)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 10),
                        child: Row(children: [
                          Icon(Icons.key_outlined, size: 18, color: key.enabled ? colors.accent : colors.muted),
                          const SizedBox(width: 12),
                          Expanded(
                            flex: 3,
                            child: key.id == null
                                ? _field(key.secret, '密钥 ${index + 1}', secret: true)
                                : Text(key.hint.isEmpty ? '已保存（加密）' : '已保存 · 尾号 ${key.hint}', style: context.text.bodyMedium),
                          ),
                          const SizedBox(width: 10),
                          Expanded(flex: 2, child: _field(key.labelText, '备注')),
                          const SizedBox(width: 6),
                          Tooltip(message: key.enabled ? '在用' : '停用', child: Switch(value: key.enabled, onChanged: (v) => setState(() => key.enabled = v))),
                          IconButton(tooltip: '移除', onPressed: () => setState(() => _keys.removeAt(index)), icon: const Icon(Icons.close, size: 18)),
                        ]),
                      ),
                  ],
                ),
                SettingsCard(
                  title: '模型',
                  trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                    if (_editing && !_dirty && _models.length > 1)
                      TextButton.icon(
                        key: const ValueKey('channel-common-models'),
                        onPressed: () { final saved = _agent.gatewayChannels.where((c) => c.id == _id).firstOrNull; if (saved != null) showDialog<void>(context: context, builder: (_) => CommonModelsDialog(channel: saved)); },
                        icon: const Icon(Icons.star_outline, size: 16),
                        label: const Text('常用模型'),
                      ),
                    TextButton.icon(onPressed: _busy ? null : _fetchModels, icon: const Icon(Icons.cloud_download_outlined, size: 16), label: const Text('获取模型列表')),
                    TextButton.icon(onPressed: () => _editModel(null), icon: const Icon(Icons.add, size: 16), label: const Text('手动添加')),
                  ]),
                  children: [
                    if (_models.isEmpty) Padding(padding: const EdgeInsets.symmetric(vertical: 14), child: Text('还没有模型', style: muted)),
                    for (final model in _models) _ModelLine(model: model, onEdit: () => _editModel(model), onRemove: () => setState(() => _models.remove(model))),
                  ],
                ),
                if (_kind != 'plan')
                  SettingsCard(title: '余额提醒', collapsed: _lowBalance.text.isEmpty && _topUp.text.isEmpty, children: [
                    SettingRow('余额低于多少时提醒', child: SizedBox(width: 150, child: TextField(controller: _lowBalance, textAlign: TextAlign.right, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(isDense: true, hintText: '不提醒')))),
                    if (_kind == 'relay') SettingRow('充值了多少（用来算剩余）', child: SizedBox(width: 150, child: TextField(controller: _topUp, textAlign: TextAlign.right, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(isDense: true, hintText: '不填')))),
                  ]),
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
                          ? Row(children: [const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)), const SizedBox(width: 8), Text('正在测试连接…', style: muted)])
                          : test != null
                          ? Tooltip(message: test.detail ?? '', child: Row(children: [Icon(test.ok ? Icons.check_circle : Icons.error_outline, size: 18, color: test.ok ? colors.success : colors.danger), const SizedBox(width: 6), Flexible(child: Text(test.text, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: test.ok ? colors.success : colors.danger)))]))
                          : _dirty && _editing
                          ? Text('有改动没保存', style: muted)
                          : const SizedBox.shrink(),
                    ),
                    const SizedBox(width: 12),
                    OutlinedButton.icon(onPressed: _busy || _testing ? null : _saveAndTest, icon: const Icon(Icons.network_check, size: 18), label: const Text('测试连接')),
                    const SizedBox(width: 10),
                    FilledButton(
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

/// A model in the channel editor: name, what it can do, and edit / remove.
class _ModelLine extends StatelessWidget {
  const _ModelLine({required this.model, required this.onEdit, required this.onRemove});
  final ModelEntry model;
  final VoidCallback onEdit;
  final VoidCallback onRemove;

  static String _tokens(int n) => n >= 1000000 ? '${(n / 1000000).toStringAsFixed(n % 1000000 == 0 ? 0 : 1)}M' : n >= 1000 ? '${(n / 1000).round()}K' : '$n';

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final tags = <String>[
      if (model.contextWindow > 0) '上下文 ${_tokens(model.contextWindow)}',
      if (model.images) '看图',
      if (model.reasoning || (model.thinkingLevels?.any((l) => l != 'off') ?? false)) '思考',
      if (model.inputPrice > 0 || model.outputPrice > 0) '\$${model.inputPrice} / \$${model.outputPrice}',
    ];
    return InkWell(
      onTap: onEdit,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Row(children: [
          Icon(Icons.memory, size: 18, color: colors.muted),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(model.id.isEmpty ? '（没填模型 ID）' : model.name.trim().isEmpty || model.name == model.id ? model.id : '${model.name} · ${model.id}', maxLines: 1, overflow: TextOverflow.ellipsis),
              if (tags.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Wrap(spacing: 6, runSpacing: 4, children: [for (final t in tags) TagChip(t, color: colors.ink2)]),
                ),
            ]),
          ),
          IconButton(tooltip: '编辑', onPressed: onEdit, icon: const Icon(Icons.edit_outlined, size: 18)),
          IconButton(tooltip: '移除', onPressed: onRemove, icon: const Icon(Icons.close, size: 18)),
        ]),
      ),
    );
  }
}

/// One model's details, edited in a dialog (0.8.2: the ten fields on one line were unreadable).
class _ModelDialog extends StatefulWidget {
  const _ModelDialog({required this.model, required this.adding});
  final ModelEntry model;
  final bool adding;
  @override
  State<_ModelDialog> createState() => _ModelDialogState();
}

class _ModelDialogState extends State<_ModelDialog> {
  late final m = widget.model;
  late final _id = TextEditingController(text: m.id);
  late final _name = TextEditingController(text: m.name == m.id ? '' : m.name);
  late final _context = TextEditingController(text: m.contextWindow > 0 ? '${m.contextWindow}' : '');
  late final _max = TextEditingController(text: '${m.maxTokens}');
  late final _input = TextEditingController(text: m.inputPrice == 0 ? '' : '${m.inputPrice}');
  late final _output = TextEditingController(text: m.outputPrice == 0 ? '' : '${m.outputPrice}');
  late final _cache = TextEditingController(text: m.cacheReadPrice == 0 ? '' : '${m.cacheReadPrice}');
  String? _error;

  @override
  void dispose() {
    for (final c in [_id, _name, _context, _max, _input, _output, _cache]) {
      c.dispose();
    }
    super.dispose();
  }

  Widget _f(TextEditingController c, String label, {bool number = false, String? hint, String? suffix}) => TextField(
    controller: c,
    keyboardType: number ? const TextInputType.numberWithOptions(decimal: true) : null,
    decoration: InputDecoration(labelText: label, hintText: hint, suffixText: suffix, isDense: true),
  );

  void _done() {
    if (_id.text.trim().isEmpty) { setState(() => _error = '请填写模型 ID'); return; }
    if (m.thinkingLevels?.isEmpty == true) { setState(() => _error = '思考档位至少选一个'); return; }
    m
      ..id = _id.text.trim()
      ..name = _name.text.trim()
      ..contextWindow = int.tryParse(_context.text.trim()) ?? 0
      ..maxTokens = int.tryParse(_max.text.trim()) ?? m.maxTokens
      ..inputPrice = double.tryParse(_input.text.trim()) ?? 0
      ..outputPrice = double.tryParse(_output.text.trim()) ?? 0
      ..cacheReadPrice = double.tryParse(_cache.text.trim()) ?? 0;
    Navigator.pop(context, m);
  }

  @override
  Widget build(BuildContext context) {
    Widget pair(Widget a, Widget b) => Padding(padding: const EdgeInsets.only(bottom: 12), child: Row(children: [Expanded(child: a), const SizedBox(width: 12), Expanded(child: b)]));
    return AlertDialog(
      title: Text(widget.adding ? '添加模型' : '编辑模型'),
      content: SizedBox(
        width: 520,
        child: SingleChildScrollView(
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
            pair(_f(_id, '模型 ID'), _f(_name, '显示名', hint: '可不填')),
            pair(_f(_context, '上下文长度', number: true, hint: '未知'), _f(_max, '最大输出', number: true)),
            Padding(padding: const EdgeInsets.only(bottom: 12), child: Row(children: [
              Expanded(child: _f(_input, '输入价', number: true, hint: '未知', suffix: '\$/百万')),
              const SizedBox(width: 12),
              Expanded(child: _f(_output, '输出价', number: true, hint: '未知', suffix: '\$/百万')),
              const SizedBox(width: 12),
              Expanded(child: _f(_cache, '缓存价', number: true, hint: '未知', suffix: '\$/百万')),
            ])),
            SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('能看图'), value: m.images, onChanged: (v) => setState(() => m.images = v)),
            const SizedBox(height: 4),
            ModelThinkingLevels(model: m),
            if (_error != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(_error!, style: TextStyle(color: context.colors.danger))),
          ]),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(onPressed: _done, child: const Text('确定')),
      ],
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
