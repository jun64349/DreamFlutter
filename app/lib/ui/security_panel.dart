import 'dart:async';
import 'dart:io';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart' show AgentController, asJsonMap;
import 'agent_scope.dart';

@visibleForTesting
Future<String?> Function() chooseSecurityAuditDestination = () async =>
    (await getSaveLocation(suggestedName: 'security-audit.jsonl', confirmButtonText: '保存审计'))?.path;

/// User-owned exceptions and local audit in the existing security category.
class SecurityPanel extends StatefulWidget {
  const SecurityPanel({super.key});

  @override
  State<SecurityPanel> createState() => _SecurityPanelState();
}

class _SecurityPanelState extends State<SecurityPanel> {
  AgentController? _agent;
  String? _workspace;
  final _path = TextEditingController();
  List<String> _paths = [];
  List<Json> _events = [];
  bool _busy = false;
  bool _loaded = false;
  String? _error;
  String? _receipt;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final agent = AgentScope.of(context);
    if (_agent == agent && _workspace == agent.workspace) return;
    _agent = agent;
    _workspace = agent.workspace;
    unawaited(_run(_load));
  }

  @override
  void dispose() { _path.dispose(); super.dispose(); }

  Future<void> _run(Future<void> Function() action) async {
    setState(() { _busy = true; _error = null; _receipt = null; });
    try { await action(); }
    catch (error) { if (mounted) setState(() => _error = error is CoreException ? error.message : '$error'); }
    finally { if (mounted) setState(() => _busy = false); }
  }

  Future<void> _load() async {
    final cwd = _workspace;
    if (cwd == null || cwd.isEmpty) { setState(() { _loaded = true; _paths = []; }); return; }
    final paths = asJsonMap(await _agent!.backend.call('security.exceptions', {'cwd': cwd}));
    final audit = asJsonMap(await _agent!.backend.call('security.audit', {'limit': 50}));
    if (!mounted || _workspace != cwd) return;
    setState(() {
      _paths = (paths['paths'] as List? ?? []).cast<String>();
      _events = (audit['events'] as List? ?? []).map(asJsonMap).toList();
      _loaded = true;
    });
  }

  Future<void> _add() async {
    final path = _path.text.trim();
    if (path.isEmpty) { setState(() => _error = '请填写要允许的文件或目录路径'); return; }
    await _run(() async {
      await _agent!.backend.call('security.addException', {'cwd': _workspace, 'path': path});
      _path.clear();
      await _load();
      if (mounted) setState(() => _receipt = '工作区例外已保存');
    });
  }

  Future<void> _export() async {
    await _run(() async {
      final location = await chooseSecurityAuditDestination();
      if (location == null || !mounted) return;
      final result = asJsonMap(await _agent!.backend.call('security.export', const {}));
      await File(location).writeAsString(result['text'] as String? ?? '');
      if (mounted) setState(() => _receipt = '审计已导出：$location');
    });
  }

  @override
  Widget build(BuildContext context) {
    final workspaceReady = _workspace?.isNotEmpty == true;
    return Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('路径例外', style: Theme.of(context).textTheme.titleMedium),
      const SizedBox(height: 8),
      const Text('默认拒绝私钥、浏览器数据、系统凭据、应用密钥和 .env。仅由你主动添加的例外可以放行；目录例外包含其子路径。需确认的路径也可在对话中选择本次允许。'),
      const SizedBox(height: 8),
      SelectableText(workspaceReady ? '当前工作区：$_workspace' : '请选择工作区后管理路径例外'),
      const SizedBox(height: 12),
      TextField(controller: _path, enabled: !_busy && workspaceReady, decoration: const InputDecoration(labelText: '允许的文件或目录路径', helperText: '相对路径以当前工作区为基准'), onSubmitted: _busy || !workspaceReady ? null : (_) => _add()),
      const SizedBox(height: 8),
      OutlinedButton(onPressed: _busy || !workspaceReady ? null : _add, child: const Text('添加工作区例外')),
      if (_loaded && _paths.isEmpty) const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Text('此工作区没有路径例外')),
      for (final path in _paths) ListTile(contentPadding: EdgeInsets.zero, title: SelectableText(path), trailing: IconButton(tooltip: '删除路径例外', onPressed: _busy ? null : () => _run(() async {
        await _agent!.backend.call('security.removeException', {'cwd': _workspace, 'path': path});
        await _load();
      }), icon: const Icon(Icons.delete_outline))),
      const SizedBox(height: 24),
      Text('本地安全审计', style: Theme.of(context).textTheme.titleMedium),
      const SizedBox(height: 8),
      const Text('保留最近 90 天，可查询和导出。记录路径判断、审批、命令判断、遮盖事件和 MCP 启动，不记录被遮盖的内容，不上传远端。'),
      Wrap(spacing: 8, runSpacing: 8, children: [
        TextButton(onPressed: _busy ? null : () => _run(_load), child: const Text('刷新记录')),
        OutlinedButton(onPressed: _busy ? null : _export, child: const Text('导出审计…')),
      ]),
      if (_loaded && _events.isEmpty) const Text('暂无安全审计记录'),
      if (_events.isNotEmpty) ExpansionTile(tilePadding: EdgeInsets.zero, title: Text('最近 ${_events.length} 条记录'), children: [
        for (final event in _events) ListTile(contentPadding: EdgeInsets.zero, isThreeLine: true,
          title: Text('${event['kind']} · ${event['decision']}'),
          subtitle: SelectableText('${DateTime.fromMillisecondsSinceEpoch((event['time'] as num? ?? 0).toInt()).toLocal()} · ${event['policy']}\n${event['object']}\n${event['reason']}\n运行/请求：${event['runId'] ?? event['requestId'] ?? event['slotId'] ?? '设置操作'}')),
      ]),
      if (_busy) const LinearProgressIndicator(semanticsLabel: '正在处理安全设置'),
      if (_receipt != null) Padding(padding: const EdgeInsets.only(top: 8), child: SelectableText(_receipt!)),
      if (_error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
    ]));
  }
}
