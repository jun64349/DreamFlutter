import 'package:flutter/material.dart';
import '../state/agent_controller.dart';
import '../theme.dart';

Future<void> saveCoreSetting(BuildContext context, AgentController agent, String key, Object? value) async {
  try {
    await agent.updateCoreSettings({key: value});
    if (agent.coreSettings[key] != value) throw StateError('后台未接受此设置，请检查值或等待接口就绪');
  } catch (e) {
    if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('设置未保存：${SessionRuntime.describeError(e)}')));
  }
}

class CoreNumberSetting extends StatefulWidget {
  const CoreNumberSetting({super.key, required this.agent, required this.setting, required this.title, required this.value, this.hint, this.min = 0, this.max, this.integer = false});
  final AgentController agent;
  final String setting;
  final String title;
  final num value;
  final String? hint;
  final num min;
  final num? max;
  final bool integer;
  @override
  State<CoreNumberSetting> createState() => _CoreNumberSettingState();
}
class _CoreNumberSettingState extends State<CoreNumberSetting> {
  late final _controller = TextEditingController(text: '${widget.value}');
  String? _error;
  bool _busy = false;
  @override
  void dispose() { _controller.dispose(); super.dispose(); }
  @override
  void didUpdateWidget(CoreNumberSetting old) { super.didUpdateWidget(old); if (old.value != widget.value && !_busy) _controller.text = '${widget.value}'; }
  Future<void> _save(String _) async {
    final value = num.tryParse(_controller.text.trim());
    if (value == null || !value.isFinite || value < widget.min || (widget.max != null && value > widget.max!) || (widget.integer && value != value.round())) {
      setState(() => _error = '请输入${widget.min}以上${widget.max == null ? '' : '、${widget.max}以内'}的${widget.integer ? '整数' : '数值'}');
      return;
    }
    setState(() { _busy = true; _error = null; });
    try {
      await widget.agent.updateCoreSettings({widget.setting: widget.integer ? value.toInt() : value});
      if (widget.agent.coreSettings[widget.setting] != value) throw StateError('后台未接受该值');
    } catch (e) { if (mounted) setState(() => _error = '未保存：${SessionRuntime.describeError(e)}'); }
    finally { if (mounted) setState(() => _busy = false); }
  }
  @override
  Widget build(BuildContext context) => Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: TextField(controller: _controller, enabled: !_busy, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: InputDecoration(labelText: widget.title, helperText: widget.hint == null ? '按 Enter 保存' : '${widget.hint}；按 Enter 保存', errorText: _error), onSubmitted: _save));
}

class CoreChoiceSetting extends StatelessWidget {
  const CoreChoiceSetting({super.key, required this.agent, required this.setting, required this.title, required this.choices, required this.fallback, this.hint});
  final AgentController agent;
  final String setting;
  final String title;
  final Map<String, String> choices;
  final String fallback;
  final String? hint;
  @override
  Widget build(BuildContext context) => Padding(padding: const EdgeInsets.symmetric(vertical: 10), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
    Text(title, style: context.text.bodyLarge),
    if (hint != null) Text(hint!, style: context.text.bodySmall?.copyWith(color: context.colors.muted)),
    const SizedBox(height: 8),
    SegmentedButton<String>(segments: [for (final e in choices.entries) ButtonSegment(value: e.key, label: Text(e.value))], selected: {choices.containsKey(agent.coreSettings[setting]) ? agent.coreSettings[setting] as String : fallback}, onSelectionChanged: (s) => saveCoreSetting(context, agent, setting, s.first)),
  ]));
}
