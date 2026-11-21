import 'dart:async';

import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart' show AgentController, asJsonMap;
import '../theme.dart';
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
  bool _editKey = false;

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
      if (mounted) setState(() { _data = data; _editKey = false; _receipt = '联网搜索密钥已删除'; });
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
    final deepseekCalls = (usage['deepseekCalls'] as num?)?.toInt() ?? 0;
    final totalCalls = (usage['calls'] as num?)?.toInt();
    final lastError = _error ?? data?['lastError'] as String?;
    final errorTitle = _error != null ? '设置未完成' : switch (data?['lastErrorTool']) {
      'web_fetch' => '上次读取网页失败',
      'web_search' => '上次搜索失败',
      _ => '上次联网操作',
    };
    final errorText = lastError == 'fetch failed' ? '连接失败，请检查网络后重试。' : lastError;
    final muted = context.text.bodySmall?.copyWith(color: context.colors.muted);
    return Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      SettingRow('读取网页', desc: '打开已有网址时使用', child: SettingMenu<String>(
        key: const ValueKey('web-backend'), value: backend, enabled: !_busy && configured,
        choices: {'local': '本机直接抓取', if (configured) 'deepseek': 'DeepSeek 抓取'},
        onSelected: (value) => _run(() async {
          final result = asJsonMap(await _agent!.backend.call('webSearch.setBackend', {'backend': value}));
          if (mounted) setState(() => _data = result);
        }))),
      const Divider(height: 1),
      SettingRow('关键词搜索', desc: data == null ? '正在读取…' : configured ? '使用 DeepSeek 官方搜索服务' : '配置 DeepSeek 搜索密钥后可用',
        child: TextButton(onPressed: data == null || _busy ? null : () => setState(() {
          _editKey = !_editKey;
          if (!_editKey) _key.clear();
        }), child: Text(_editKey ? '收起' : configured ? '管理密钥' : '配置搜索'))),
      if (_editKey) ...[
        TextField(controller: _key, enabled: !_busy, obscureText: true, enableSuggestions: false, autocorrect: false,
          decoration: InputDecoration(labelText: 'DeepSeek 官方密钥', hintText: configured ? '填新的以更换' : null),
          onSubmitted: _busy ? null : (_) => _save()),
        Wrap(spacing: 8, children: [
          TextButton(onPressed: _busy ? null : _save, child: const Text('保存密钥')),
          if (configured) ...[
            Tooltip(message: '会真的搜一次，约 ¥0.005', child: TextButton(onPressed: _busy ? null : _test, child: const Text('测试搜索'))),
            TextButton(onPressed: _busy ? null : _delete, child: const Text('删除…')),
          ],
        ]),
      ],
      if ((data?['pendingToolRefresh'] as num? ?? 0) > 0) const Text('运行中的对话将在结束后刷新工具列表。'),
      if (totalCalls != null && totalCalls > 0) Padding(padding: const EdgeInsets.symmetric(vertical: 8),
        child: Text('本月本机读取 ${totalCalls - deepseekCalls} 次 · DeepSeek 服务 $deepseekCalls 次'
          '${deepseekCalls > 0 ? ' · 估算 ¥${(usage['estimatedCostCny'] as num? ?? 0).toStringAsFixed(3)}' : ''}', style: muted)),
      if (_busy) const LinearProgressIndicator(semanticsLabel: '正在处理联网工具设置'),
      if (_receipt != null) Semantics(liveRegion: true, child: Text(_receipt!)),
      if (errorText != null) Semantics(liveRegion: true, child: Text('$errorTitle：$errorText', style: context.text.bodySmall?.copyWith(color: context.colors.danger))),
    ]));
  }
}
