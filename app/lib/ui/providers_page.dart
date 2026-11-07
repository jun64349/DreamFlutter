import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'gateway_pages.dart' show ChannelManagementPage;

/// One model of a provider, as the core reports it.
class ModelEntry {
  Json metadata = {};
  ModelEntry({
    required this.id,
    this.name = '',
    this.contextWindow = 0,
    this.maxTokens = 16384,
    this.images = false,
    this.reasoning = false,
    this.inputPrice = 0,
    this.outputPrice = 0,
    this.cacheReadPrice = 0,
    this.efforts = const [],
    this.thinkingLevels,
  });

  factory ModelEntry.fromJson(Json json) {
    final cost = (json['cost'] as Map?)?.cast<String, dynamic>() ?? const {};
    return ModelEntry(
      id: json['id'] as String? ?? '',
      name: json['name'] as String? ?? '',
      contextWindow: (json['contextWindow'] as num?)?.toInt() ?? 0,
      maxTokens: (json['maxTokens'] as num?)?.toInt() ?? 16384,
      images: (json['input'] as List? ?? const []).contains('image'),
      reasoning: json['reasoning'] == true,
      inputPrice: (cost['input'] as num?)?.toDouble() ?? 0,
      outputPrice: (cost['output'] as num?)?.toDouble() ?? 0,
      cacheReadPrice: (cost['cacheRead'] as num?)?.toDouble() ?? 0,
      efforts: [for (final e in json['efforts'] as List? ?? const []) e as String],
      thinkingLevels: (json['thinkingLevels'] as List?)?.cast<String>().toList(),
    )..metadata = Map.of(json);
  }

  String id;
  String name;
  int contextWindow;
  int maxTokens;
  bool images;
  bool reasoning;
  double inputPrice;
  double outputPrice;
  double cacheReadPrice;

  /// The model's own thinking values from the model list (kept, not edited here).
  final List<String> efforts;
  List<String>? thinkingLevels;

  Json toJson() => {
    ...metadata,
    'id': id.trim(),
    'name': name.trim().isEmpty ? id.trim() : name.trim(),
    if (contextWindow > 0) 'contextWindow': contextWindow,
    'maxTokens': maxTokens,
    'input': ['text', if (images) 'image'],
    'reasoning': reasoning,
    'cost': {'input': inputPrice, 'output': outputPrice, 'cacheRead': cacheReadPrice, 'cacheWrite': (metadata['cost'] as Map?)?['cacheWrite'] ?? 0},
    if (efforts.isNotEmpty) 'efforts': efforts,
    if (thinkingLevels != null) 'thinkingLevels': thinkingLevels,
  };
}

class ProviderEntry {
  ProviderEntry.fromJson(Json json)
    : id = json['id'] as String? ?? '',
      name = json['name'] as String? ?? '',
      baseUrl = json['baseUrl'] as String?,
      api = json['api'] as String?,
      configured = json['configured'] == true,
      authSource = json['authSource'] as String?,
      custom = json['custom'] == true,
      encryptedKey = json['encryptedKey'] == true,
      models = (json['models'] as List? ?? const []).whereType<Map>().map((m) => ModelEntry.fromJson(m.cast<String, dynamic>())).toList();

  final String id;
  final String name;
  final String? baseUrl;
  final String? api;
  final bool configured;
  final String? authSource;
  final bool custom;
  final bool encryptedKey;
  final List<ModelEntry> models;
}

const apiLabels = {
  'openai-completions': 'OpenAI 兼容（Chat Completions）',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic 兼容',
  'google-generative-ai': 'Google Gemini',
};

/// Model providers: built-in ones that need a key, custom (OpenAI/Anthropic
/// compatible) endpoints, connection tests. Edits Pi's own models.json /
/// auth.json through the core, with keys stored encrypted.
class ProvidersPage extends StatefulWidget {
  const ProvidersPage({super.key, this.legacyOnly = false});
  final bool legacyOnly;

  @override
  State<ProvidersPage> createState() => _ProvidersPageState();
}

class _ProvidersPageState extends State<ProvidersPage> {
  List<ProviderEntry>? _providers;
  String? _error;
  final _tests = <String, String>{};
  var _showAll = false;
  var _changed = false;

  AgentController get _agent => AgentScope.read(context);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    try {
      if (!widget.legacyOnly) {
        final status = asJsonMap(await _agent.backend.call('piMigration.status'));
        if (status['status'] == 'done' && mounted) {
          await Navigator.of(context).pushReplacement(MaterialPageRoute<void>(builder: (_) => const ChannelManagementPage()));
          return;
        }
      }
      final list = await _agent.backend.call('providers.list');
      setState(() {
        _providers = (list as List).whereType<Map>().map((p) => ProviderEntry.fromJson(p.cast<String, dynamic>())).toList();
        _error = null;
      });
    } catch (e) {
      setState(() => _error = SessionRuntime.describeError(e));
    }
  }

  Future<void> _run(Future<void> Function() action, {String? done}) async {
    try {
      await action();
      _changed = true;
      if (done != null && mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(done)));
      await _load();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(SessionRuntime.describeError(e))));
    }
  }

  Future<void> _test(ProviderEntry provider) async {
    setState(() => _tests[provider.id] = '正在测试…');
    try {
      final result = (await _agent.backend.call('providers.test', {'provider': provider.id}, const Duration(seconds: 45))) as Map;
      setState(
        () => _tests[provider.id] = result['ok'] == true
            ? '✓ 连接正常（${result['model']}，${result['latencyMs']} ms）'
            : '✗ ${result['error'] ?? '失败'}',
      );
    } catch (e) {
      setState(() => _tests[provider.id] = '✗ ${SessionRuntime.describeError(e)}');
    }
  }

  Future<void> _setKey(ProviderEntry provider) async {
    final key = await _askKey(context, provider.name);
    if (key == null || key.trim().isEmpty) return;
    await _run(() => _agent.backend.call('providers.setKey', {'provider': provider.id, 'apiKey': key.trim()}), done: '已保存 ${provider.name} 的 API Key（已加密）');
  }

  Future<void> _edit([ProviderEntry? existing]) async {
    final saved = await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => CustomProviderPage(existing: existing)));
    if (saved == true) {
      _changed = true;
      await _load();
    }
  }

  @override
  void dispose() {
    // New configuration applies to new sessions; reopen idle ones so the
    // current window sees it too.
    if (_changed) _agent.reloadIdleSessions();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final providers = _providers;
    return Scaffold(
      appBar: AppBar(
        title: const Text('模型服务商'),
        scrolledUnderElevation: 0,
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: AppTokens.pad),
            child: FilledButton.icon(onPressed: () => _edit(), icon: const Icon(Icons.add, size: 18), label: const Text('添加自定义服务商')),
          ),
        ],
      ),
      body: _error != null
          ? Center(child: Text(_error!, style: TextStyle(color: colors.danger)))
          : providers == null
          ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
          : ListView(
              padding: const EdgeInsets.symmetric(horizontal: AppTokens.padLg * 2, vertical: AppTokens.padLg),
              children: [
                Text('已配置', style: context.text.titleSmall),
                const SizedBox(height: AppTokens.gap),
                for (final p in providers.where((p) => p.configured || p.custom)) _ProviderCard(
                  provider: p,
                  testResult: _tests[p.id],
                  onTest: () => _test(p),
                  onEdit: p.custom ? () => _edit(p) : () => _setKey(p),
                  onRemove: p.custom
                      ? () => _run(() => _agent.backend.call('providers.removeCustom', {'id': p.id}), done: '已删除 ${p.name}')
                      : p.encryptedKey
                      ? () => _run(() => _agent.backend.call('providers.removeKey', {'provider': p.id}), done: '已移除 ${p.name} 的 API Key')
                      : null,
                ),
                const SizedBox(height: AppTokens.padLg),
                Row(
                  children: [
                    Text('内置服务商', style: context.text.titleSmall),
                    const Spacer(),
                    TextButton(onPressed: () => setState(() => _showAll = !_showAll), child: Text(_showAll ? '收起' : '展开全部')),
                  ],
                ),
                Text('填写 API Key 后即可使用。Key 用你的 Windows 账户加密保存，不会以明文写入配置文件。', style: context.text.bodySmall?.copyWith(color: colors.muted)),
                const SizedBox(height: AppTokens.gap),
                for (final p in providers.where((p) => !p.configured && !p.custom).take(_showAll ? 999 : 12))
                  ListTile(
                    dense: true,
                    title: Text(p.name),
                    subtitle: Text('${p.id} · ${p.models.length} 个模型'),
                    trailing: OutlinedButton(onPressed: () => _setKey(p), child: const Text('填写 API Key')),
                  ),
              ],
            ),
    );
  }
}

class _ProviderCard extends StatefulWidget {
  const _ProviderCard({required this.provider, required this.testResult, required this.onTest, required this.onEdit, required this.onRemove});

  final ProviderEntry provider;
  final String? testResult;
  final VoidCallback onTest;
  final VoidCallback onEdit;
  final VoidCallback? onRemove;

  @override
  State<_ProviderCard> createState() => _ProviderCardState();
}

class _ProviderCardState extends State<_ProviderCard> {
  var _expanded = false;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final p = widget.provider;
    final source = p.encryptedKey ? 'API Key 已加密保存' : (p.authSource ?? (p.configured ? '已配置' : '缺少 API Key'));
    return Card(
      margin: const EdgeInsets.only(bottom: AppTokens.gap),
      child: Padding(
        padding: const EdgeInsets.all(AppTokens.pad),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(p.configured ? Icons.check_circle : Icons.error_outline, size: 18, color: p.configured ? colors.success : colors.warning),
                const SizedBox(width: AppTokens.gap),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('${p.name}${p.custom ? '（自定义）' : ''}', style: context.text.titleSmall),
                      Text('${p.id} · ${p.baseUrl ?? '默认地址'} · $source', style: context.text.bodySmall?.copyWith(color: colors.muted)),
                    ],
                  ),
                ),
                TextButton(onPressed: p.configured ? widget.onTest : null, child: const Text('测试连接')),
                TextButton(onPressed: widget.onEdit, child: Text(p.custom ? '编辑' : '更换 Key')),
                if (widget.onRemove != null)
                  IconButton(tooltip: p.custom ? '删除服务商' : '移除 API Key', onPressed: () => _confirm(context, widget.onRemove!), icon: const Icon(Icons.delete_outline, size: 18)),
              ],
            ),
            if (widget.testResult != null)
              Padding(
                padding: const EdgeInsets.only(top: 4, left: 26),
                child: Text(
                  widget.testResult!,
                  style: context.text.bodySmall?.copyWith(color: widget.testResult!.startsWith('✓') ? colors.success : widget.testResult!.startsWith('✗') ? colors.danger : colors.muted),
                ),
              ),
            InkWell(
              onTap: () => setState(() => _expanded = !_expanded),
              child: Padding(
                padding: const EdgeInsets.only(top: 6, left: 26),
                child: Text('${p.models.length} 个模型 ${_expanded ? '▴' : '▾'}', style: context.text.bodySmall?.copyWith(color: Theme.of(context).colorScheme.primary)),
              ),
            ),
            if (_expanded)
              Padding(
                padding: const EdgeInsets.only(top: 6, left: 26),
                child: Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    for (final m in p.models)
                      Tooltip(
                        message: '上下文 ${m.contextWindow ~/ 1000}K · 最大输出 ${m.maxTokens ~/ 1000}K'
                            '${m.images ? ' · 支持图片' : ''}${m.reasoning ? ' · 支持思考' : ''}'
                            '\n价格（每百万 token）：输入 \$${m.inputPrice} / 输出 \$${m.outputPrice}',
                        child: Chip(label: Text(m.name.isEmpty ? m.id : m.name), visualDensity: VisualDensity.compact),
                      ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }

  Future<void> _confirm(BuildContext context, VoidCallback action) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(widget.provider.custom ? '删除这个服务商？' : '移除 API Key？'),
        content: Text('「${widget.provider.name}」${widget.provider.custom ? '会从 Pi 的配置里删除。' : '的 Key 会被删除。'}'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('确定')),
        ],
      ),
    );
    if (ok == true) action();
  }
}

Future<String?> _askKey(BuildContext context, String name) {
  final controller = TextEditingController();
  return showDialog<String>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text('$name 的 API Key'),
      content: SizedBox(
        width: 420,
        child: TextField(
          controller: controller,
          autofocus: true,
          obscureText: true,
          decoration: const InputDecoration(hintText: '粘贴 API Key', helperText: '用你的 Windows 账户加密后保存'),
          onSubmitted: (v) => Navigator.pop(context, v),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(onPressed: () => Navigator.pop(context, controller.text), child: const Text('保存')),
      ],
    ),
  );
}

// ---------------------------------------------------------------------------
// Custom provider form
// ---------------------------------------------------------------------------

class _Preset {
  const _Preset(this.label, this.id, this.name, this.baseUrl, this.api, {this.needsKey = true});
  final String label;
  final String id;
  final String name;
  final String baseUrl;
  final String api;
  final bool needsKey;
}

const _presets = [
  _Preset('DeepSeek', 'deepseek-api', 'DeepSeek', 'https://api.deepseek.com/v1', 'openai-completions'),
  _Preset('通义千问', 'dashscope', '通义千问', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'openai-completions'),
  _Preset('OpenRouter', 'openrouter-custom', 'OpenRouter', 'https://openrouter.ai/api/v1', 'openai-completions'),
  _Preset('Ollama（本机）', 'ollama', 'Ollama', 'http://localhost:11434/v1', 'openai-completions', needsKey: false),
  _Preset('LM Studio（本机）', 'lmstudio', 'LM Studio', 'http://localhost:1234/v1', 'openai-completions', needsKey: false),
];

class CustomProviderPage extends StatefulWidget {
  const CustomProviderPage({super.key, this.existing});

  final ProviderEntry? existing;

  @override
  State<CustomProviderPage> createState() => _CustomProviderPageState();
}

class _CustomProviderPageState extends State<CustomProviderPage> {
  late final _name = TextEditingController(text: widget.existing?.name ?? '');
  late final _id = TextEditingController(text: widget.existing?.id ?? '');
  late final _baseUrl = TextEditingController(text: widget.existing?.baseUrl ?? '');
  final _apiKey = TextEditingController();
  late String _api = widget.existing?.api ?? 'openai-completions';
  late final List<ModelEntry> _models = [...?widget.existing?.models];
  var _busy = false;
  String? _message;

  bool get _editing => widget.existing != null;

  AgentController get _agent => AgentScope.read(context);

  void _applyPreset(_Preset preset) {
    setState(() {
      _name.text = preset.name;
      if (!_editing) _id.text = preset.id;
      _baseUrl.text = preset.baseUrl;
      _api = preset.api;
      if (!preset.needsKey && _apiKey.text.isEmpty) _apiKey.text = 'local';
    });
  }

  Future<void> _fetchModels() async {
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final list = await _agent.backend.call('providers.fetchModels', {
        'baseUrl': _baseUrl.text.trim(),
        'api': _api,
        if (_apiKey.text.trim().isNotEmpty) 'apiKey': _apiKey.text.trim() else if (_editing) 'provider': widget.existing!.id,
      });
      final ids = (list as List).whereType<Map>().map((m) => m['id'] as String).toList();
      if (!mounted) return;
      final chosen = await showDialog<List<String>>(context: context, builder: (_) => PickModelsDialog(ids: ids, existing: _models.map((m) => m.id).toSet()));
      if (chosen != null) {
        setState(() {
          for (final id in chosen) {
            if (_models.every((m) => m.id != id)) _models.add(ModelEntry(id: id));
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
      await _agent.backend.call('providers.saveCustom', {
        'id': _id.text.trim(),
        'name': _name.text.trim(),
        'baseUrl': _baseUrl.text.trim(),
        'api': _api,
        if (_apiKey.text.trim().isNotEmpty) 'apiKey': _apiKey.text.trim(),
        'models': _models.where((m) => m.id.trim().isNotEmpty).map((m) => m.toJson()).toList(),
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
    return Scaffold(
      appBar: AppBar(
        title: Text(_editing ? '编辑服务商' : '添加自定义服务商'),
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
          if (!_editing) ...[
            Text('常用预设', style: context.text.labelMedium),
            const SizedBox(height: 6),
            Wrap(spacing: 6, runSpacing: 6, children: [for (final p in _presets) ActionChip(label: Text(p.label), onPressed: () => _applyPreset(p))]),
            const SizedBox(height: AppTokens.padLg),
          ],
          Row(
            children: [
              Expanded(child: TextField(controller: _name, decoration: const InputDecoration(labelText: '显示名称'))),
              const SizedBox(width: AppTokens.pad),
              Expanded(
                child: TextField(
                  controller: _id,
                  enabled: !_editing,
                  decoration: const InputDecoration(labelText: '服务商 ID', helperText: '字母、数字、横线；建好后不能改'),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppTokens.pad),
          TextField(controller: _baseUrl, decoration: const InputDecoration(labelText: '接口地址（Base URL）', hintText: 'https://api.example.com/v1')),
          const SizedBox(height: AppTokens.pad),
          DropdownButtonFormField<String>(
            initialValue: _api,
            decoration: const InputDecoration(labelText: '接口类型'),
            items: [for (final e in apiLabels.entries) DropdownMenuItem(value: e.key, child: Text(e.value))],
            onChanged: (v) => setState(() => _api = v ?? _api),
          ),
          const SizedBox(height: AppTokens.pad),
          TextField(
            controller: _apiKey,
            obscureText: true,
            decoration: InputDecoration(
              labelText: 'API Key',
              helperText: _editing ? '留空则保留原来的 Key' : '用你的 Windows 账户加密后保存；本机模型随便填即可',
            ),
          ),
          const SizedBox(height: AppTokens.padLg),
          Row(
            children: [
              Text('模型', style: context.text.titleSmall),
              const Spacer(),
              OutlinedButton.icon(onPressed: _busy ? null : _fetchModels, icon: const Icon(Icons.cloud_download_outlined, size: 16), label: const Text('从接口获取')),
              const SizedBox(width: AppTokens.gap),
              OutlinedButton.icon(onPressed: () => setState(() => _models.add(ModelEntry(id: ''))), icon: const Icon(Icons.add, size: 16), label: const Text('手动添加')),
            ],
          ),
          const SizedBox(height: 4),
          Text('价格按每百万 token 的美元填写，用于用量统计；不知道可以留 0。', style: context.text.bodySmall?.copyWith(color: colors.muted)),
          const SizedBox(height: AppTokens.gap),
          for (final (index, model) in _models.indexed)
            ModelRow(key: ObjectKey(model), model: model, onRemove: () => setState(() => _models.removeAt(index))),
          if (_message != null)
            Padding(padding: const EdgeInsets.only(top: AppTokens.pad), child: Text(_message!, style: TextStyle(color: colors.danger))),
          if (_busy) const Padding(padding: EdgeInsets.only(top: AppTokens.pad), child: LinearProgressIndicator()),
        ],
      ),
    );
  }
}

class ModelRow extends StatelessWidget {
  const ModelRow({super.key, required this.model, required this.onRemove, this.editThinkingLevels = false});

  final ModelEntry model;
  final VoidCallback onRemove;
  final bool editThinkingLevels;

  Widget _number(String label, num value, ValueChanged<String> onChanged, {double width = 96}) => SizedBox(
    width: width,
    child: TextFormField(
      initialValue: '$value',
      decoration: InputDecoration(labelText: label, isDense: true),
      keyboardType: TextInputType.number,
      onChanged: onChanged,
    ),
  );

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: AppTokens.gap),
      child: Padding(
        padding: const EdgeInsets.all(AppTokens.gap),
        child: Wrap(
          spacing: AppTokens.pad,
          runSpacing: AppTokens.gap,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            SizedBox(
              width: 220,
              child: TextFormField(initialValue: model.id, decoration: const InputDecoration(labelText: '模型 ID', isDense: true), onChanged: (v) => model.id = v),
            ),
            SizedBox(
              width: 140,
              child: TextFormField(
                initialValue: model.contextWindow > 0 ? '${model.contextWindow}' : '',
                decoration: const InputDecoration(labelText: '上下文', hintText: '未知', isDense: true),
                keyboardType: TextInputType.number,
                onChanged: (v) => model.contextWindow = int.tryParse(v) ?? 0,
              ),
            ),
            _number('最大输出', model.maxTokens, (v) => model.maxTokens = int.tryParse(v) ?? model.maxTokens),
            _number('输入 \$/M', model.inputPrice, (v) => model.inputPrice = double.tryParse(v) ?? model.inputPrice, width: 80),
            _number('输出 \$/M', model.outputPrice, (v) => model.outputPrice = double.tryParse(v) ?? model.outputPrice, width: 80),
            ModelFlag(label: '图片', value: model.images, onChanged: (v) => model.images = v),
            if (!editThinkingLevels) ModelFlag(label: '思考', value: model.reasoning, onChanged: (v) => model.reasoning = v),
            IconButton(tooltip: '移除', onPressed: onRemove, icon: const Icon(Icons.close, size: 18)),
            if (editThinkingLevels) ModelThinkingLevels(model: model),
          ],
        ),
      ),
    );
  }
}

/// Unknown relay capabilities are explicitly confirmed against the provider's documentation.
class ModelThinkingLevels extends StatefulWidget {
  const ModelThinkingLevels({super.key, required this.model});
  final ModelEntry model;
  @override
  State<ModelThinkingLevels> createState() => _ModelThinkingLevelsState();
}

class _ModelThinkingLevelsState extends State<ModelThinkingLevels> {
  static const levels = {'off': '关闭', 'minimal': '最低', 'low': '低', 'medium': '中', 'high': '高', 'xhigh': '极高', 'max': '最高'};
  @override
  Widget build(BuildContext context) {
    final model = widget.model;
    final selected = model.thinkingLevels ?? (model.reasoning ? ['off', if (model.efforts.isEmpty) ...['minimal', 'low', 'medium', 'high'] else ...model.efforts.where(levels.containsKey)] : ['off']);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text('支持的思考档位（按服务商说明勾选）', style: context.text.bodySmall),
        Wrap(spacing: 8, runSpacing: 4, children: [
          for (final entry in levels.entries)
            FilterChip(
              label: Text(entry.value),
              selected: selected.contains(entry.key),
              onSelected: (on) => setState(() {
                final next = (model.thinkingLevels ?? selected).toSet();
                if (on) { next.add(entry.key); } else { next.remove(entry.key); }
                model.thinkingLevels = levels.keys.where(next.contains).toList();
                model.reasoning = next.any((l) => l != 'off');
              }),
            ),
        ]),
        if (model.thinkingLevels?.isEmpty == true) Text('请至少选择一个档位', style: TextStyle(color: context.colors.danger)),
      ],
    );
  }
}

class ModelFlag extends StatefulWidget {
  const ModelFlag({super.key, required this.label, required this.value, required this.onChanged});

  final String label;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  State<ModelFlag> createState() => _ModelFlagState();
}

class _ModelFlagState extends State<ModelFlag> {
  late var _value = widget.value;

  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      Checkbox(
        value: _value,
        onChanged: (v) {
          setState(() => _value = v ?? false);
          widget.onChanged(_value);
        },
      ),
      Text(widget.label),
    ],
  );
}

class PickModelsDialog extends StatefulWidget {
  const PickModelsDialog({super.key, required this.ids, required this.existing});

  final List<String> ids;
  final Set<String> existing;

  @override
  State<PickModelsDialog> createState() => _PickModelsDialogState();
}

class _PickModelsDialogState extends State<PickModelsDialog> {
  late final Set<String> _chosen = {...widget.existing};
  var _filter = '';

  @override
  Widget build(BuildContext context) {
    final shown = widget.ids.where((id) => id.toLowerCase().contains(_filter.toLowerCase())).toList();
    return AlertDialog(
      title: Text('选择模型（共 ${widget.ids.length} 个）'),
      content: SizedBox(
        width: 460,
        height: 420,
        child: Column(
          children: [
            TextField(decoration: const InputDecoration(hintText: '筛选', prefixIcon: Icon(Icons.search, size: 18)), onChanged: (v) => setState(() => _filter = v)),
            Expanded(
              child: ListView(
                children: [
                  for (final id in shown)
                    CheckboxListTile(
                      dense: true,
                      value: _chosen.contains(id),
                      title: Text(id),
                      onChanged: (v) => setState(() => v == true ? _chosen.add(id) : _chosen.remove(id)),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(onPressed: () => Navigator.pop(context, _chosen.difference(widget.existing).toList()), child: const Text('添加')),
      ],
    );
  }
}
