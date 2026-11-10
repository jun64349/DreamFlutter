import 'dart:io';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'fake_backend.dart';

class T88Fixture {
  T88Fixture(this.root,this.backend,this.agent);
  final Directory root;final FakeBackend backend;final AgentController agent;
  final now=<Json>[],later=<Json>[],receipts=<String,Json>{};
  static Future<T88Fixture> create()async{
    final root=await Directory.systemTemp.createTemp('df_t88_');
    SharedPreferences.setMockInitialValues({'workspace':root.path,'onboarded':true});
    final backend=FakeBackend()..sessionsDir=root.path;
    final agent=AgentController(preferences:await Preferences.load(),sessionStore:SessionStore(sessionsDir:root.path),backend:backend);
    final f=T88Fixture(root,backend,agent)..seed();await agent.init();return f;
  }
  void seed(){
    now.add({'id':'approval:a','kind':'approval','group':'now','title':'运行项目的检查','reason':'确认改动没有影响已有功能。','origin':{'role':'workbench','sessionName':'整理项目资料'},'target':{'page':'chat'},'actions':['allow','reject'],'data':{}});
    later.add({'id':'proposal:p','kind':'proposal','group':'later','title':'采用「整理文献」技能','reason':'以后整理同类资料时可以直接使用。','origin':{'role':'butterfly','sessionName':'本周的研究记录'},'target':{'page':'library'},'actions':['allow','reject'],'data':{}});
    Json list()=>{'now':now.where((i)=>!receipts.values.any((r)=>r['itemId']==i['id']&&r['status']=='pending')).toList(),'later':later.where((i)=>!receipts.values.any((r)=>r['itemId']==i['id']&&r['status']=='pending')).toList(),'counts':{'total':now.length+later.length-receipts.values.where((r)=>r['status']=='pending').length},'pending':receipts.values.where((r)=>r['status']=='pending').toList()};
    backend.handlers.addAll({
      'attention.list':(_)=>list(),
      'attention.resolve':(p){final isLater=later.any((i)=>i['id']==p['id']);final r=<String,dynamic>{'id':'r${receipts.length}','itemId':p['id'],'status':isLater?'pending':'applied','undoable':isLater,'undoUntil':isLater?DateTime.now().millisecondsSinceEpoch+5000:null};receipts[r['id']]=r;if(!isLater)now.removeWhere((i)=>i['id']==p['id']);return {...r};},
      'attention.undo':(p){final r=receipts[p['id']]!;r['status']='cancelled';r['undoable']=false;return {...r};},
      'attention.receipt':(p)=>receipts[p['id']],
      'gateway.channels':(_)=>[{'id':'c1','name':'DeepSeek','provider':'df-c1','platform':'deepseek','kind':'payg','api':'openai-completions','baseUrl':'https://api.example.invalid','models':[{'id':'flash','name':'DeepSeek-V4.1-Flash'}],'keys':[],'enabled':true}],
      'gateway.groups':(_)=><Json>[],
      'gateway.platforms':(_)=>[{'id':'deepseek','name':'DeepSeek','kind':'payg','endpoints':[{'api':'openai-completions','baseUrl':'https://api.example.invalid'}],'models':['flash'],'modelDetails':[{'id':'flash','name':'DeepSeek-V4.1-Flash'}]}],
      'gateway.saveChannel':(_)=>'c1',
      'setup.testChannel':(_)=>{'ok':true},
      'setup.recommendModels':(_)=>{'conversation':'df-c1/flash','small':'df-c1/flash','large':'df-c1/flash','vision':null},
      'setup.status':(_)=>{'completed':false,'dataRoot':root.path,'userName':'','defaultWorkspace':null},
      'setup.complete':(p)=>{'completed':true,'dataRoot':root.path},
      'ledger.entries':(_)=>[{'requested_at':DateTime.now().millisecondsSinceEpoch,'purpose':'conversation','provider':'df-c1','model':'flash','amount':.12,'currency':'USD','amount_source':'price_estimate'},{'requested_at':DateTime.now().millisecondsSinceEpoch-60000,'purpose':'memory','provider':'df-c1','model':'flash','amount':null,'currency':null,'amount_source':'missing'}],
      'ledger.summary':(p)=>{'timeZone':'Asia/Taipei','rows':[{'period':'2026-11','key':'conversation','requests':8,'amounts':{'USD':.12},'amountSources':{'price_estimate':8},'input':8000,'output':900,'tokenKnown':8,'successRate':1,'knownStatuses':8},{'period':'2026-11','key':'memory','requests':2,'amounts':{},'amountSources':{'missing':2}}]},
      'storage.memory':(_)=>{'logicalBytes':8000,'versions':4,'databaseBytes':18000,'path':'${root.path}/core.db','space':{'minimumBytes':1073741824,'freeBytes':100000000000}},
      'storage.locations':(_)=>{'rows':[{'id':'database','label':'后台数据库','path':'${root.path}/application-data/database','bytes':18000,'movable':true},{'id':'sessions','label':'对话','path':'${root.path}/user-content/sessions','bytes':12000,'movable':true}],'artifacts':[]},
      'backup.overview':(_)=>{'estimateText':'80 KB'},
      'updates.status':(_)=>{'state':'idle'},
      'sandbox.status':(_)=>{'state':'unavailable','reason':'还没有准备沙箱'},
      'workspace.toolRules':(_)=><Json>[],
    });
  }
  Future<void> dispose()async{agent.dispose();for(var n=0;root.existsSync();n++){try{await root.delete(recursive:true);}on FileSystemException{if(n==9)rethrow;await Future<void>.delayed(const Duration(milliseconds:50));}}}
}
