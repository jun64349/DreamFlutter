import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:pi_rpc/pi_rpc.dart';
import 'fake_backend.dart';
import 'support/clean_env.dart';

/// Conversation records are fixtures; every git.* call uses the real Core RPC.
class T90Backend extends FakeBackend {
  T90Backend(this.client, this.zone);
  final CoreClient client;
  final Zone zone;
  int pendingGit = 0;
  @override
  Future<Object?> call(String method, [Json params = const {}, Duration timeout = const Duration(seconds:60)]) async {
    if (method.startsWith('git.')) {
      calls.add((method:method,params:params)); pendingGit++;
      try { return await zone.run(()=>client.call(method,params,timeout)); } finally { pendingGit--; }
    }
    return super.call(method,params,timeout);
  }
}
class T90Core {
  T90Core(this.process,this.client,this.info,this.zone);
  final Process process;
  final CoreClient client;
  final Json info;
  final Zone zone;
  Future<Object?> call(String method, [Json params=const {}]) => zone.run(()=>client.call(method,params));
  String get workspace => info['workspace'] as String;
  Future<void> close() async {
    try { await client.call('test.shutdown'); } catch (_) {}
    await process.stdin.close();
    await process.exitCode.timeout(const Duration(seconds:15),onTimeout:(){process.kill();return -1;});
    if (!client.isClosed) await client.close().timeout(const Duration(seconds:2),onTimeout:(){});
  }
}
Future<T90Core> startT90Core() async {
  final process=await Process.start('node',['--disable-warning=ExperimentalWarning','test/support/t90_core.ts'],environment:testCoreEnvironment(),includeParentEnvironment:false);
  final errors=<String>[]; process.stderr.transform(utf8.decoder).listen(errors.add);
  final ready=Completer<Json>();
  process.stdout.transform(utf8.decoder).transform(const LineSplitter()).listen((line){if(line.startsWith('{')&&!ready.isCompleted)ready.complete((jsonDecode(line) as Map).cast<String,dynamic>());});
  process.exitCode.then((code){if(!ready.isCompleted)ready.completeError(StateError('Core exited $code: ${errors.join()}'));});
  final info=await ready.future.timeout(const Duration(seconds:60));
  return T90Core(process,await CoreClient.connect(port:info['port'] as int,token:info['token'] as String),info,Zone.current);
}
List<Json> t90History(String cwd) => [
  {'role':'user','content':'整理实验记录，补充结论和摘要。','timestamp':1,'entryId':'q'},
  {'role':'assistant','content':[{'type':'toolCall','id':'edit','name':'edit','arguments':{'path':'$cwd/report.md','oldText':'结论待补充。','newText':'已补充三组实验的对比与下一步验证。'}},{'type':'toolCall','id':'write','name':'write','arguments':{'path':'$cwd/summary.md','content':'三组结果总体一致。'}}],'timestamp':2,'stopReason':'toolUse'},
  {'role':'toolResult','toolCallId':'edit','toolName':'edit','content':[{'type':'text','text':'已修改'}],'timestamp':3,'isError':false},
  {'role':'toolResult','toolCallId':'write','toolName':'write','content':[{'type':'text','text':'已写入'}],'timestamp':4,'isError':false},
  {'role':'assistant','content':[{'type':'text','text':'已经整理好了。\n\n小结保留了实验结论和下一步验证，另存了一份摘要。'}],'timestamp':5,'stopReason':'stop'},
];
