import 'dart:async';
import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';
import '../state/agent_controller.dart' show AgentController, asJsonMap;
import '../state/session_runtime.dart' show SessionRuntime;
import 'agent_scope.dart';

class PackageSourcesPanel extends StatefulWidget {
  const PackageSourcesPanel({super.key});
  @override
  State<PackageSourcesPanel> createState() => _PackageSourcesPanelState();
}

class _PackageSourcesPanelState extends State<PackageSourcesPanel> {
  AgentController? _agent;
  StreamSubscription<Json>? _events;
  Json? _status;
  String? _error;
  bool _saving = false;
  int _revision = 0;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final agent = AgentScope.read(context);
    if (agent == _agent) return;
    _agent = agent;
    unawaited(_events?.cancel());
    _events = agent.backend.events.listen((event) { if (event['event'] == 'settings.changed') unawaited(_load()); });
    unawaited(_load());
  }
  @override
  void dispose() { unawaited(_events?.cancel()); super.dispose(); }

  Future<void> _load() async {
    try {
      final data = asJsonMap(await _agent!.backend.call('packageSources.status', {'cwd': _agent!.workspace}));
      if (mounted) setState(() { _status = data; _error = null; });
    } catch (e) { if (mounted) setState(() => _error = SessionRuntime.describeError(e)); }
  }
  Future<void> _save(String key, String value) async {
    setState(() { _saving = true; _error = null; });
    try { await _agent!.updateCoreSettings({key: value}); await _load(); }
    catch (e) { if (mounted) setState(() => _error = SessionRuntime.describeError(e)); }
    finally { if (mounted) setState(() { _saving = false; _revision++; }); }
  }
  String _layer(dynamic value) {
    final choice = asJsonMap(value);
    if (choice['reason'] == 'project-uncertain') return '配置无法确认，未覆盖';
    return switch (choice['layer']) { 'application' => '应用设置', 'project' => '项目配置', _ => '跟随现有' };
  }
  String _sources(Json snapshot) => 'uv：${_layer(snapshot['uv'])} · pip：${_layer(snapshot['pip'])} · npm：${_layer(snapshot['npm'])}';

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final host = asJsonMap(_status?['nextHost']);
    final sandbox = asJsonMap(asJsonMap(_status?['recent'])['sandbox']);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('工具软件源', style: Theme.of(context).textTheme.titleMedium),
      const SizedBox(height: 12),
      DropdownButtonFormField<String>(
        key: ValueKey('python-${agent.coreSettings['pythonPackageSource']}-$_revision'),
        initialValue: agent.coreSettings['pythonPackageSource'] as String? ?? 'inherit', isExpanded: true,
        decoration: const InputDecoration(labelText: 'Python 软件源'),
        items: [for (final entry in const {'inherit': '跟随现有配置（默认）', 'pypi': '官方 PyPI', 'tuna': '清华 TUNA', 'ustc': '中科大 USTC'}.entries) DropdownMenuItem(value: entry.key, child: Text(entry.value))],
        onChanged: _saving ? null : (value) { if (value != null) _save('pythonPackageSource', value); },
      ),
      const SizedBox(height: 12),
      DropdownButtonFormField<String>(
        key: ValueKey('npm-${agent.coreSettings['npmPackageSource']}-$_revision'),
        initialValue: agent.coreSettings['npmPackageSource'] as String? ?? 'inherit', isExpanded: true,
        decoration: const InputDecoration(labelText: 'npm 软件源'),
        items: [for (final entry in const {'inherit': '跟随现有配置（默认）', 'npm': '官方 npm', 'npmmirror': 'npmmirror'}.entries) DropdownMenuItem(value: entry.key, child: Text(entry.value))],
        onChanged: _saving ? null : (value) { if (value != null) _save('npmPackageSource', value); },
      ),
      const SizedBox(height: 12),
      const Text('只影响 DreamFlutter 启动的工具；项目自己指定的源优先；新命令开始生效。'),
      const SizedBox(height: 8),
      if (_status != null) Text('下一条工作台命令：${_sources(host)}'),
      Text(sandbox.isEmpty ? '沙箱来源将在执行命令后显示；离线规则始终优先。' : '最近沙箱命令：${_sources(sandbox)}'),
      const Text('uv 的锁定安装在换源后可能提示更新锁；npm 可能改用镜像下载。应用不重写锁文件，工具仍按锁定版本和完整性校验。Git 只沿用代理，不改 remote。'),
      TextButton(onPressed: _saving ? null : _load, child: const Text('刷新来源')),
      if (_error != null) Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
    ]);
  }
}
