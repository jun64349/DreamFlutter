import 'dart:async';
import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../state/memory_ui.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'common.dart';
import 'settings_page.dart';

class ContextControls extends StatefulWidget {
  const ContextControls({super.key});
  @override
  State<ContextControls> createState() => _ContextControlsState();
}
class _ContextControlsState extends State<ContextControls> {
  late final AgentController _agent;
  late final SessionRuntime? _runtime;
  StreamSubscription<Json>? _events;
  Json? _info;
  List<Json> _checkpoints = [];
  final _threshold = TextEditingController();
  String? _error;
  String? _result;
  bool _busy = false;
  bool _loading = true;
  int _request = 0;
  String? get _slot => _runtime?.slotId;
  @override
  void initState() {
    super.initState();
    _agent = AgentScope.read(context);
    _runtime = _agent.active;
    _events = _agent.backend.events.listen((e) {
      if (e['slotId'] == _slot && (e['event'] == 'context.available' || e['event'] == 'context.compaction')) _load();
    });
    _load();
  }
  @override
  void dispose() { _request++; _events?.cancel(); _threshold.dispose(); super.dispose(); }
  Future<void> _load() async {
    final request = ++_request;
    if (_slot == null) { setState(() { _loading = false; _error = '会话还在启动中'; }); return; }
    try {
      final responses = await Future.wait([_agent.backend.call('context.info', {'slotId': _slot}), _agent.backend.call('context.checkpoints', {'slotId': _slot})]);
      if (!mounted || request != _request) return;
      final info = memoryMap(responses[0]);
      if (!info.containsKey('thresholdPercent')) throw StateError('未取得上下文信息');
      setState(() { _info = info; _checkpoints = memoryRows(responses[1]); _threshold.text = '${info['ownThreshold'] ?? info['thresholdPercent']}'; _error = null; });
    } catch (e) { if (mounted && request == _request) setState(() => _error = SessionRuntime.describeError(e)); }
    finally { if (mounted && request == _request) setState(() => _loading = false); }
  }
  Future<void> _set(Json patch) async {
    if (_busy) return;
    setState(() { _busy = true; _error = null; });
    try { await _agent.backend.call('context.setSession', {'slotId': _slot, ...patch}); await _load(); }
    catch (e) { if (mounted) setState(() => _error = SessionRuntime.describeError(e)); }
    finally { if (mounted) setState(() => _busy = false); }
  }
  Future<void> _checkpoint(String action, Json entry) async {
    String? note;
    if (action == 'report') {
      final input = await showFieldsDialog(context, title: '报告摘要有误', confirm: '提交', fields: [FieldSpec('哪里有误', minLines: 2, maxLines: 5)]);
      if (input == null) return;
      note = input.first;
    }
    if (!mounted || _busy) return;
    setState(() { _busy = true; _error = null; _result = null; });
    try {
      final result = await _agent.backend.call('context.$action', {'slotId': _slot, 'entryId': entry['entryId'], 'note': ?note}, const Duration(minutes: 3));
      if (!mounted) return;
      if (action == 'original') {
        final rows = memoryRows(result);
        await showTextDialog(context, title: '压缩前的原文', text: rows.isEmpty ? '没有可显示的原文文本。' : rows.map((r) => '${r['role']}\n${r['text']}').join('\n\n'));
      } else if (action == 'report') {
        setState(() => _result = '已提交问题，摘要尚未纠正');
      } else {
        final source = memoryMap(result)['source'];
        if (result == null) throw StateError('没有生成新摘要');
        setState(() => _result = source == 'original' ? '已按原文重写' : source == 'previous_summary' ? '已在旧摘要上修订' : '摘要已重新生成，后台未说明依据来源');
        await _runtime?.refreshHistory();
      }
      await _load();
    } catch (e) { if (mounted) setState(() => _error = SessionRuntime.describeError(e)); }
    finally { if (mounted) setState(() => _busy = false); }
  }
  @override
  Widget build(BuildContext context) {
    final info = _info;
    final background = memoryMap(info?['background']);
    final choice = background['ownChoice'];
    final current = choice == null ? 'default' : choice == true || choice == 1 ? 'on' : 'off';
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (_error != null) Row(children: [Expanded(child: Text(_error!, style: TextStyle(color: context.colors.danger))), TextButton(onPressed: _busy ? null : _load, child: const Text('重试'))]),
      if (_loading || _busy) const LinearProgressIndicator(),
      if (info != null) ...[
        Wrap(crossAxisAlignment: WrapCrossAlignment.center, children: [Text('自动压缩：${info['autoCompaction'] == true ? '开' : '关'}（全局设置）'), TextButton(onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const SettingsPage(category: '对话'))), child: const Text('打开设置'))]),
        Text('有效阈值：${info['thresholdTokens'] ?? '未知'} tokens · 配置 ${info['thresholdPercent']}%', style: context.text.bodySmall),
        const SizedBox(height: 12),
        Row(children: [Expanded(child: TextField(controller: _threshold, enabled: !_busy, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: '本会话阈值（20–95%）'), onSubmitted: (v) {
          final n = int.tryParse(v);
          if (n == null || n < 20 || n > 95) { setState(() => _error = '压缩阈值须为20–95之间的整数'); return; }
          _set({'thresholdPercent': n});
        })), TextButton(onPressed: _busy ? null : () => _set({'thresholdPercent': null}), child: const Text('跟随默认'))]),
        Text(info['ownThreshold'] == null ? '阈值跟随全局默认' : '已覆盖本会话阈值', style: context.text.bodySmall?.copyWith(color: context.colors.muted)),
        const SizedBox(height: 12),
        DropdownButtonFormField<String>(key: ValueKey(current), initialValue: current, decoration: const InputDecoration(labelText: '本会话后台压缩'), items: const [DropdownMenuItem(value: 'default', child: Text('跟随默认')), DropdownMenuItem(value: 'on', child: Text('开')), DropdownMenuItem(value: 'off', child: Text('关'))], onChanged: _busy ? null : (v) => _set({'background': v == 'default' ? null : v == 'on'})),
        Text('当前后台压缩：${background['on'] == true ? '开' : '关'}', style: context.text.bodySmall),
        const Divider(height: 32),
        Text('压缩记录', style: context.text.titleSmall),
        if (_result != null) Semantics(liveRegion: true, child: Text(_result!)),
        if (_checkpoints.isEmpty) const Padding(padding: EdgeInsets.symmetric(vertical: 10), child: Text('当前分支还没有压缩记录。')),
        for (final entry in _checkpoints.reversed) Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('${entry['at'] ?? ''} · 压缩前 ${entry['tokensBefore'] ?? '未知'} tokens'),
          if (entry['reported'] == true) Text('已报告有误', style: TextStyle(color: context.colors.warning)),
          Text(entry['summary'] as String? ?? '', maxLines: 3, overflow: TextOverflow.ellipsis),
          Wrap(children: [TextButton(onPressed: _busy ? null : () => _checkpoint('original', entry), child: const Text('查看原文')), TextButton(onPressed: _busy ? null : () => _checkpoint('report', entry), child: const Text('报告有误')), if (identical(entry, _checkpoints.last)) TextButton(onPressed: _busy || (_runtime?.isRunning ?? true) || (_runtime?.isCompacting ?? true) ? null : () => _checkpoint('regenerate', entry), child: const Text('重新生成'))]),
        ])),
      ],
    ]);
  }
}
