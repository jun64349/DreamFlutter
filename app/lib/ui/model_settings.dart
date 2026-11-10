import 'package:flutter/material.dart';
import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';

/// Per-model limits, in the existing model settings category.
class ModelWindowSetting extends StatefulWidget {
  const ModelWindowSetting({super.key});
  @override
  State<ModelWindowSetting> createState() => _ModelWindowSettingState();
}

class _ModelWindowSettingState extends State<ModelWindowSetting> {
  final _window = TextEditingController();
  String? _selected;
  String? _error;
  bool _saving = false;
  String? _restoreLabel;

  Future<void> _loadSource() async {
    final key = _selected;
    if (key == null) return;
    final slash = key.indexOf('/');
    try {
      final raw = await AgentScope.read(context).backend.call('gateway.modelWindow', {'provider': key.substring(0, slash), 'model': key.substring(slash + 1)});
      final info = raw is Map ? raw : const {};
      final source = switch (info['source']) { 'channel' => '渠道设置', _ => '目录默认' };
      final value = info['value'];
      if (mounted && _selected == key) setState(() => _restoreLabel = '恢复为$source（${value is num && value > 0 ? '$value 单位' : '未知'}）');
    } catch (e) {
      if (mounted && _selected == key) setState(() => _error = SessionRuntime.describeError(e));
    }
  }

  Map<String, dynamic> _overrides(AgentController agent) => Map<String, dynamic>.from(agent.coreSettings['modelContextWindows'] as Map? ?? {});

  @override
  void dispose() { _window.dispose(); super.dispose(); }

  Future<void> _save({bool reset = false}) async {
    if (_selected == null) return;
    final value = int.tryParse(_window.text.trim());
    if (!reset && (value == null || value <= 0)) {
      setState(() => _error = '请输入大于 0 的整数');
      return;
    }
    final agent = AgentScope.read(context);
    final overrides = _overrides(agent);
    if (reset) { overrides.remove(_selected); } else { overrides[_selected!] = value; }
    setState(() { _saving = true; _error = null; });
    try {
      await agent.updateCoreSettings({'modelContextWindows': overrides});
      await agent.refreshGateway(models: true);
      if (reset) _window.clear();
    } catch (e) {
      if (mounted) setState(() => _error = SessionRuntime.describeError(e));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final models = agent.models;
    final selected = models.where((m) => m.key == _selected).firstOrNull;
    return Padding(
      padding: const EdgeInsets.all(AppTokens.padLg),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('按模型覆盖上下文窗口', style: context.text.titleSmall),
        const SizedBox(height: AppTokens.gap),
        DropdownButtonFormField<String>(
          key: ValueKey(_selected),
          initialValue: selected?.key,
          isExpanded: true,
          decoration: const InputDecoration(labelText: '模型'),
          hint: Text(models.isEmpty ? '还没有可用模型' : '选择模型'),
          items: [for (final model in models) DropdownMenuItem(value: model.key, child: Text('${agent.providerLabel(model.provider)} · ${model.name}', overflow: TextOverflow.ellipsis))],
          onChanged: _saving ? null : (key) {
            setState(() {
              _selected = key;
              _restoreLabel = null;
              _window.text = _overrides(agent)[key]?.toString() ?? '';
              _error = null;
            });
            _loadSource();
          },
        ),
        if (selected != null) ...[
          const SizedBox(height: AppTokens.gap),
          Text('有效窗口：${selected.contextWindow > 0 ? '${selected.contextWindow} 单位' : '未知'}', style: context.text.bodySmall),
          const SizedBox(height: AppTokens.gap),
          Focus(onFocusChange:(focused){if(!focused&&!_saving&&_window.text.isNotEmpty)_save();},child:TextField(
            controller: _window,
            enabled: !_saving,
            keyboardType: TextInputType.number,
            decoration: InputDecoration(labelText: '手动覆盖（单位）', hintText: '留空时使用渠道设置，没有渠道值时使用目录值', errorText: _error),
            onSubmitted: (_) => _saving ? null : _save(),
          )),
          const SizedBox(height: AppTokens.gap),
          Wrap(spacing: AppTokens.gap, children: [
            TextButton(onPressed: _saving || _restoreLabel == null || !_overrides(agent).containsKey(_selected) ? null : () => _save(reset: true), child: Text(_restoreLabel ?? '正在读取恢复窗口…')),
          ]),
        ],
      ]),
    );
  }
}
