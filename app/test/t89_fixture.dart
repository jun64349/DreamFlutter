import 'dart:io';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'fake_backend.dart';

class T89Fixture {
  T89Fixture(this.root, this.backend, this.agent);
  final Directory root;
  final FakeBackend backend;
  final AgentController agent;
  final skills = <Json>[], servers = <Json>[], proposals = <Json>[];
  static Future<T89Fixture> create() async {
    final root = await Directory.systemTemp.createTemp('df_t89_');
    SharedPreferences.setMockInitialValues({'workspace': root.path, 'onboarded': true});
    final backend = FakeBackend()..butterflyHome = root.path;
    final agent = AgentController(preferences: await Preferences.load(), sessionStore: SessionStore(sessionsDir: root.path), backend: backend);
    final fixture = T89Fixture(root, backend, agent)..seed(); await agent.init(); return fixture;
  }
  void seed() {
    final now = DateTime.now().millisecondsSinceEpoch;
    skills.addAll([
      {'kind':'skill', 'name':'文献整理', 'description':'归纳论文要点与引用', 'filePath':'${root.path}/skills/papers/SKILL.md', 'sourceKind':'community', 'sourceUrl':'https://example.invalid/papers', 'scope':'user', 'trust':'trusted', 'enabled':true, 'usageCount':12, 'lastUsedAt':now-3600000},
      {'kind':'template', 'name':'实验周报', 'description':'把实验记录整理成每周进展', 'filePath':'${root.path}/prompts/weekly.md', 'body':'把 {{记录}} 整理成周报', 'params':[{'name':'记录'}], 'sourceKind':'user', 'scope':'user', 'trust':'trusted', 'enabled':false, 'usageCount':3},
      {'kind':'skill', 'name':'表格处理', 'description':'清理表格并核对计算结果', 'filePath':'${root.path}/skills/tables/SKILL.md', 'sourceKind':'builtin', 'scope':'builtin', 'readOnly':true, 'trust':'trusted', 'enabled':true, 'usageCount':6},
    ]);
    servers.add({'name':'实验室资料库', 'description':'查询实验室共有资料', 'source':'${root.path}/agent/mcp.json', 'sourceKind':'user', 'scope':'user', 'trust':'trusted', 'enabled':true, 'butterflyAllowed':false, 'usageCount':7, 'lastUsedAt':now-86400000, 'tools':[{'name':'搜索资料', 'enabled':true}, {'name':'读取资料', 'enabled':false}]});
    proposals.add({'id':'p1','kind':'skill','title':'检查引用','payload':{'name':'检查引用','description':'核对引用编号和参考文献','sourceKind':'agent'}});
    backend.handlers.addAll({
      'skills.list': (_) => skills.map((r) => {...r}).toList(),
      'mcp.list': (_) => {'servers': servers.map((r) => {...r}).toList()},
      'proposals.list': (_) => proposals,
      'skills.setEnabled': (p) { skills.firstWhere((s) => s['filePath'] == p['filePath'])['enabled'] = p['enabled']; return {'ok':true}; },
      'mcp.setEnabled': (p) { servers.firstWhere((s) => s['name'] == p['name'] && s['source'] == p['source'])['enabled'] = p['enabled']; return {'ok':true}; },
      'mcp.setButterflyAllowed': (p) { servers.firstWhere((s) => s['name'] == p['name'] && s['source'] == p['source'])['butterflyAllowed'] = p['allowed']; return {'ok':true}; },
      'skills.test': (_) => {'ok':true, 'scriptTrial':{'reason':'已检查格式和文件引用，没有运行脚本'}},
      'mcp.test': (_) => {'ok':true, 'tools':['搜索资料','读取资料'], 'errors':[]},
      'skills.remove': (p) { skills.removeWhere((s) => s['filePath']==p['filePath']); return {'ok':true}; },
      'templates.remove': (p) { skills.removeWhere((s) => s['kind']=='template' && s['name']==p['name']); return {'ok':true}; },
      'mcp.remove': (p) { servers.removeWhere((s) => s['name']==p['name'] && s['source']==p['source']); return {'ok':true}; },
      'skills.importUrl': (p) { proposals.add({'id':'url', 'kind':'skill','title':'导入的技能','payload':{'name':'导入的技能','description':'整理资料','sourceKind':'community','sourceUrl':p['url']}}); return {'proposalId':'url'}; },
      'mcp.setToolEnabled': (p) { final server=servers.firstWhere((s) => s['source']==p['source'] && s['name']==p['name']); final tools=server['tools'] as List; (tools.firstWhere((t) => t['name']==p['tool']) as Map)['enabled']=p['enabled']; return {'ok':true}; },
    });
  }
  Future<void> dispose() async {
    agent.dispose();
    for(var attempt=0; root.existsSync(); attempt++) {
      try { await root.delete(recursive:true); }
      on FileSystemException { if(attempt==9) rethrow; await Future<void>.delayed(const Duration(milliseconds:50)); }
    }
  }
}
