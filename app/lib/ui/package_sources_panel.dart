import 'dart:async';
import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';
import '../state/agent_controller.dart' show AgentController;
import '../state/session_runtime.dart' show SessionRuntime;
import 'agent_scope.dart';
import 'settings_controls.dart' show SettingRow, SettingMenu;

class PackageSourcesPanel extends StatefulWidget {
  const PackageSourcesPanel({super.key});
  @override
  State<PackageSourcesPanel> createState() => _PackageSourcesPanelState();
}

class _PackageSourcesPanelState extends State<PackageSourcesPanel> {
  AgentController? _agent;
  StreamSubscription<Json>? _events;
  String? _error;
  bool _saving = false;
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
      await _agent!.backend.call('packageSources.status', {'cwd': _agent!.workspace});
      if (mounted) setState(() => _error = null);
    } catch (e) { if (mounted) setState(() => _error = SessionRuntime.describeError(e)); }
  }
  Future<void> _save(String key, String value) async {
    setState(() { _saving = true; _error = null; });
    try { await _agent!.updateCoreSettings({key: value}); await _load(); }
    catch (e) { if (mounted) setState(() => _error = SessionRuntime.describeError(e)); }
    finally { if (mounted) setState(() => _saving = false); }
  }
  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    // 0.8.1 S.7: two plain setting rows; what the sources do is in the hover help, not paragraphs.
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Padding(padding: const EdgeInsets.only(top: 16, bottom: 4), child: Text('工具软件源', style: Theme.of(context).textTheme.labelSmall?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant, letterSpacing: 1.4))),
      SettingRow('Python', child: SettingMenu<String>(key: const ValueKey('python-source'), value: agent.coreSettings['pythonPackageSource'] as String? ?? 'inherit', enabled: !_saving, choices: const {'inherit': '跟随现有配置', 'pypi': '官方 PyPI', 'tuna': '清华 TUNA', 'ustc': '中科大 USTC'}, onSelected: (v) => _save('pythonPackageSource', v))),
      SettingRow('npm', child: SettingMenu<String>(key: const ValueKey('npm-source'), value: agent.coreSettings['npmPackageSource'] as String? ?? 'inherit', enabled: !_saving, choices: const {'inherit': '跟随现有配置', 'npm': '官方 npm', 'npmmirror': 'npmmirror'}, onSelected: (v) => _save('npmPackageSource', v))),
      if (_error != null) Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
    ]);
  }
}
