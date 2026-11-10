import 'dart:async';

import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart' show AgentController, asJsonMap;
import 'agent_scope.dart';
import 'settings_controls.dart' show SettingRow, SettingMenu;

/// A separately configured official search credential; no channel key is displayed or borrowed.
class WebSearchPanel extends StatefulWidget {
  const WebSearchPanel({super.key});

  @override
  State<WebSearchPanel> createState() => _WebSearchPanelState();
}

class _WebSearchPanelState extends State<WebSearchPanel> {
  AgentController? _agent;
  StreamSubscription<Json>? _events;
  final _key = TextEditingController();
  Json? _data;
  String? _error;
  String? _receipt;
  bool _busy = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final agent = AgentScope.read(context);
    if (_agent == agent) return;
    _agent = agent;
    unawaited(_events?.cancel());
    _events = agent.backend.events.listen((event) {
      if (event['event'] == 'webSearch.changed' && event['status'] is Map) {
        if (mounted) setState(() => _data = asJsonMap(event['status']));
      }
    });
    unawaited(_run(_load));
  }

  @override
  void dispose() { unawaited(_events?.cancel()); _key.clear(); _key.dispose(); super.dispose(); }

  Future<void> _load() async {
    final data = asJsonMap(await _agent!.backend.call('webSearch.status', const {}));
    if (mounted) setState(() => _data = data);
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() { _busy = true; _error = null; _receipt = null; });
    try { await action(); }
    catch (error) { if (mounted) setState(() => _error = error is CoreException ? error.message : '$error'); }
    finally { if (mounted) setState(() => _busy = false); }
  }

  Future<void> _save() async {
    final key = _key.text.trim();
    if (key.isEmpty) { setState(() => _error = '请填写 DeepSeek 官方密钥'); return; }
    await _run(() async {
      final data = asJsonMap(await _agent!.backend.call('webSearch.saveKey', {'key': key}));
      _key.clear();
      if (mounted) setState(() { _data = data; _receipt = '官方密钥已保存，尚未进行真实连接测试'; });
    });
  }

  Future<void> _delete() async {
    final confirmed = await showDialog<bool>(context: context, builder: (context) => AlertDialog(
      title: const Text('删除联网搜索密钥？'),
      content: const Text('删除后将隐藏联网搜索工具，网页抓取恢复为本机直接抓取。其他渠道的密钥保持原样。'),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
        FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('删除密钥')),
      ],
    ));
    if (confirmed != true || !mounted) return;
    await _run(() async {
      final data = asJsonMap(await _agent!.backend.call('webSearch.deleteKey', const {}));
      _key.clear();
      if (mounted) setState(() { _data = data; _receipt = '联网搜索密钥已删除'; });
    });
  }

  Future<void> _test() async => _run(() async {
    final result = asJsonMap(await _agent!.backend.call('webSearch.test', const {}, const Duration(seconds: 100)));
    await _load();
    if (mounted) setState(() => _receipt = '连接成功，返回 ${result['count'] ?? 0} 项结果；本次费用估算 ¥${(result['estimatedCostCny'] as num? ?? 0).toStringAsFixed(3)}');
  });

  @override
  Widget build(BuildContext context) {
    final data = _data;
    final configured = data?['configured'] == true;
    final usage = asJsonMap(data?['usage']);
    final backend = data?['backend'] == 'deepseek' && configured ? 'deepseek' : 'local';
    final lastError = _error ?? data?['lastError'] as String?;
    return Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('联网搜索与抓取', style: Theme.of(context).textTheme.titleMedium),
      const SizedBox(height: 8),
      Text(data == null ? '正在读取…' : configured ? '已配置' : '未配置'),
      const SizedBox(height: 12),
      TextField(controller: _key, enabled: !_busy, obscureText: true, enableSuggestions: false, autocorrect: false,
        decoration: InputDecoration(labelText: 'DeepSeek 官方密钥', hintText: configured ? '填新的以更换' : null),
        onSubmitted: _busy ? null : (_) => _save()),
      const SizedBox(height: 8),
      Wrap(spacing: 8, runSpacing: 8, children: [
        OutlinedButton(onPressed: _busy ? null : _save, child: const Text('保存密钥')),
        TextButton(onPressed: _busy || !configured ? null : _delete, child: const Text('删除…')),
      ]),
      if ((data?['pendingToolRefresh'] as num? ?? 0) > 0) const Padding(padding: EdgeInsets.only(top: 8), child: Text('运行中的对话将在结束后刷新工具列表。')),
      const SizedBox(height: 20),
      SettingRow('网页抓取', child: SettingMenu<String>(
        key: const ValueKey('web-backend'), value: backend, enabled: !_busy && data != null,
        choices: {'local': '本机直接抓取', if (configured || backend == 'deepseek') 'deepseek': 'DeepSeek 抓取'},
        onSelected: (value) => _run(() async {
          final result = asJsonMap(await _agent!.backend.call('webSearch.setBackend', {'backend': value}));
          if (mounted) setState(() => _data = result);
        }))),
      const SizedBox(height: 20),
      if (data != null) ...[
        Text('本月用了 ${usage['calls'] ?? 0} 次 · 约 ¥${(usage['estimatedCostCny'] as num? ?? 0).toStringAsFixed(2)}'),
      ],
      const SizedBox(height: 12),
      Tooltip(message: '会真的搜一次，约 ¥0.005', child: OutlinedButton(onPressed: _busy || !configured ? null : _test, child: const Text('测试连接'))),
      if (_busy) const LinearProgressIndicator(semanticsLabel: '正在处理联网工具设置'),
      if (_receipt != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_receipt!)),
      if (lastError != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text('上次错误：$lastError', style: TextStyle(color: Theme.of(context).colorScheme.error))),
    ]));
  }
}
