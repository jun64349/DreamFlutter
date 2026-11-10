import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'agent_controller.dart';
import 'memory_ui.dart';

class GardenEntry {
  GardenEntry(this.data);
  final Json data;
  bool get service => data['kind'] == 'mcp';
  bool get template => data['kind'] == 'template';
  String get name => data['name'] as String? ?? '';
  String get description => data['description'] as String? ?? '';
  String get key => '${data['kind']}:${service ? data['source'] ?? data['proposalId'] ?? '' : data['filePath'] ?? data['proposalId'] ?? ''}:$name';
  bool get pending => data['trust'] == 'untrusted' || data['proposalId'] != null || data['identityConflict'] != null;
  bool get enabled => !pending && data['enabled'] != false;
  String get status => pending ? '等你确认' : enabled ? '可用' : '已停用';
  bool get editable => !pending && (!service || data['scope'] != 'project');
  bool get removable => editable && data['readOnly'] != true && data['scope'] != 'builtin';
}

class Garden extends ChangeNotifier {
  Garden(this.agent) {
    _workspace = agent.workspace; agent.addListener(_workspaceChanged);
    agent.gardenDeletions.addListener(_deletionsChanged);
    _events = agent.backend.events.listen((e) { if (['skills.changed','templates.changed','proposals.changed','mcp.changed','library.changed'].contains(e['event'])) unawaited(load()); });
  }
  final AgentController agent;
  List<GardenEntry> entries = [];
  final busy = <String>{};
  final results = <String, Json>{};
  String? error;
  bool loading = true, servicesSeen = false, _disposed = false;
  int _request = 0;
  String? _workspace;
  StreamSubscription<Json>? _events;
  void _notify() { if (!_disposed) notifyListeners(); }
  void _workspaceChanged() { if (_workspace != agent.workspace) { _workspace = agent.workspace; unawaited(load()); } }
  void _deletionsChanged() { unawaited(load()); }
  Future<void> load() async {
    final request = ++_request;
    try {
      final response = await Future.wait([agent.backend.call('skills.list', {'cwd': agent.workspace}), agent.backend.call('mcp.list', {'cwd': agent.workspace}), agent.backend.call('proposals.list', {'status': 'pending'}), SharedPreferences.getInstance()]);
      if (_disposed || request != _request) return;
      final rows = <Json>[
        for (final s in memoryRows(response[0])) {'kind': 'skill', ...s},
        for (final s in memoryRows(memoryMap(response[1])['servers'])) {...s, 'kind': 'mcp'},
      ];
      for (final proposal in memoryRows(response[2])) {
        if (proposal['kind'] != null && !['skill','mcp'].contains(proposal['kind'])) continue;
        final payload = memoryMap(proposal['payload']);
        if (proposal['cwd'] != null && !SessionStore.samePath(proposal['cwd'] as String, agent.workspace)) continue;
        final kind = proposal['kind'] == 'mcp' ? 'mcp' : 'skill';
        final name = payload['name'] ?? proposal['title'];
        final existing = rows.where((s) => s['kind'] == kind && s['name'] == name && s['trust'] == 'untrusted').firstOrNull;
        if (existing != null) { existing['proposalId'] = proposal['id']; }
        else { rows.add({...payload, 'kind': kind, 'name': name, 'proposalId': proposal['id'], 'trust': 'untrusted', 'enabled': false}); }
      }
      final prefs = response[3] as SharedPreferences;
      servicesSeen = prefs.getBool('gardenServicesSeen') == true || rows.any((r) => r['kind'] == 'mcp');
      if (servicesSeen) await prefs.setBool('gardenServicesSeen', true);
      if (_disposed || request != _request) return;
      entries = rows.map(GardenEntry.new).where((entry) => !agent.gardenDeletions.hiddenKeys.contains(entry.key)).toList(); loading = false; error = agent.gardenDeletions.error; _notify();
    } catch (e) { if (_disposed || request != _request) return; loading = false; error = SessionRuntime.describeError(e); _notify(); }
  }
  Future<void> _perform(String key, Future<void> Function() action) async {
    if (!busy.add(key)) return;
    _notify();
    try { await action(); } finally { busy.remove(key); _notify(); }
  }
  Json serviceIdentity(GardenEntry entry) => {'name': entry.name, 'source': entry.data['source'], 'cwd': agent.workspace};
  Future<void> toggle(GardenEntry entry, bool value) => _perform(entry.key, () async {
    if (!entry.editable) throw StateError('这项还不能更改，请先到等你处理查看');
    await agent.backend.call(entry.service ? 'mcp.setEnabled' : 'skills.setEnabled', entry.service ? {...serviceIdentity(entry), 'enabled': value} : {'filePath': entry.data['filePath'], 'enabled': value});
    await load();
  });
  Future<void> allowButterfly(GardenEntry entry, bool value) => _perform(entry.key, () async { await agent.backend.call('mcp.setButterflyAllowed', {...serviceIdentity(entry), 'allowed': value}); await load(); });
  Future<void> test(GardenEntry entry) => _perform(entry.key, () async {
    final result = memoryMap(await agent.backend.call(entry.service ? 'mcp.test' : 'skills.test', entry.service ? serviceIdentity(entry) : {'filePath': entry.data['filePath']}, const Duration(seconds: 150)));
    results[entry.key] = result;
    // A successful connection discovers tools; reload their saved permissions.
    await load();
  });
  Future<void> importFolder(String folder) async { await agent.backend.call('skills.import', {'folder': folder}); await load(); }
  // The controller owns the grace period so changing pages cannot cancel it.
  Future<String> remove(GardenEntry entry) async {
    if (!entry.removable) throw StateError('这项不能删除');
    final token = await agent.gardenDeletions.stage(entry.key, entry.service ? 'mcp.remove' : entry.template ? 'templates.remove' : 'skills.remove', entry.service ? serviceIdentity(entry) : entry.template ? {'name': entry.name} : {'filePath': entry.data['filePath']});
    entries.removeWhere((row) => row.key == entry.key); _notify(); return token;
  }
  Future<void> undoRemove(String token) async { await agent.gardenDeletions.undo(token); await load(); }
  Future<void> importUrl(String url) async { await agent.backend.call('skills.importUrl', {'url': url, 'cwd': agent.workspace}); await load(); }
  Future<void> toggleTool(GardenEntry entry, String tool, bool enabled) => _perform(entry.key, () async { await agent.backend.call('mcp.setToolEnabled', {...serviceIdentity(entry), 'tool': tool, 'enabled': enabled}); await load(); });
  Future<void> askForSkill([String request = '帮我做一个技能：']) async { await agent.main.newSession(); agent.main.showSection(AppSection.chat); agent.main.insertIntoComposer(request); }
  @override
  void dispose() { _disposed = true; _events?.cancel(); agent.removeListener(_workspaceChanged); agent.gardenDeletions.removeListener(_deletionsChanged); super.dispose(); }
}
