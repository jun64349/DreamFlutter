// T-11: production Flutter controller/widgets -> WebSocket -> Core -> DeepSeek.
// flutter test integration_test/memory_v05_live_test.dart -d windows --no-pub
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/chat_view.dart';
import 'package:dreamflutter/ui/context_controls.dart';
import 'package:dreamflutter/ui/extension_dialogs.dart';
import 'package:dreamflutter/ui/memory_chat_controls.dart';
import 'package:dreamflutter/ui/memory_details.dart';
import 'package:dreamflutter/ui/memory_log.dart';
import 'package:dreamflutter/ui/memory_page.dart';
import 'package:dreamflutter/ui/settings_page.dart';
import 'package:dreamflutter/ui/side_chat_view.dart';
import 'package:dreamflutter/ui/session_dialogs.dart';
import 'package:dreamflutter/ui/keys.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../test/v05_harness.dart' show settleV05;

class _Backend implements AgentBackend {
  _Backend(this.client);
  final CoreClient client;
  @override Future<Json> connect() async => (await client.call('core.hello') as Map).cast<String,dynamic>();
  @override bool get isConnected => !client.isClosed;
  @override Future<void> get disconnected => client.closed;
  @override Stream<Json> get events => client.events;
  @override LaunchedSession launch(SessionTarget target) => launchInCore(client,target);
  @override Future<Object?> call(String method,[Json params=const {},Duration timeout=const Duration(seconds:60)]) => client.call(method,params,timeout);
  @override Future<void> dispose() => client.close();
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  runT11Live();
}

void runT11Live() {
  HeldKeys.askWindows=false;
  testWidgets('T11 real model joint acceptance', (tester) async {
    final previous=HttpOverrides.current;HttpOverrides.global=null;
    addTearDown(()=>HttpOverrides.global=previous);
    await tester.binding.setSurfaceSize(const Size(1200,1000));
    final errors=<String>[];
    final launched=(await tester.runAsync(() async {
      const data=String.fromEnvironment('T11_DATA');
      final process=await Process.start('node',['--disable-warning=ExperimentalWarning','test/support/t11_live_core.ts',if(data.isNotEmpty)data]);
      process.stderr.transform(utf8.decoder).listen(errors.add);
      final ready=Completer<Json>();
      process.stdout.transform(utf8.decoder).transform(const LineSplitter()).listen((line){if(line.startsWith('{')&&!ready.isCompleted) ready.complete((jsonDecode(line) as Map).cast<String,dynamic>());});
      process.exitCode.then((c){if(!ready.isCompleted)ready.completeError(StateError('Core exited $c ${errors.join()}'));});
      return (process:process,info:await ready.future.timeout(const Duration(seconds:90)));
    }))!;
    final info=launched.info;
    final client=(await tester.runAsync(()=>CoreClient.connect(port:info['port'] as int,token:info['token'] as String)))!;
    final backend=_Backend(client);
    final events=<Json>[];
    final sub=client.events.listen(events.add);
    SharedPreferences.setMockInitialValues({'workspace':info['workspace'],'modelKey':info['model'],'thinkingLevel':'low','onboarded':true});
    final prefs=(await tester.runAsync(Preferences.load))!;
    final agent=AgentController(preferences:prefs,sessionStore:SessionStore(sessionsDir:info['sessions'] as String),backend:backend);
    final capture=GlobalKey();
    final shots=Directory('../Claude Codex Bridge/T-11-evidence/live-shots')..createSync(recursive:true);
    final checks=<Json>[];
    Future<Object?> rpc(String method,[Json p=const {}]) async => (await tester.runAsync(() async => [await client.call(method,p,const Duration(minutes:3))]))!.single;
    Future<Json> inspect() async => (await rpc('test.inspect') as Map).cast<String,dynamic>();
    Future<void> mount(Widget child,{Brightness brightness=Brightness.light}) async {
      await tester.pumpWidget(const SizedBox());
      await tester.pumpWidget(AgentScope(controller:agent,child:MaterialApp(theme:buildTheme(brightness),home:Scaffold(body:RepaintBoundary(key:capture,child:Material(color:buildTheme(brightness).scaffoldBackgroundColor,child:child))))));
      await settleV05(tester);
    }
    Future<void> shot(String name) async {
      await settleV05(tester);
      await tester.runAsync(() async {final b=capture.currentContext!.findRenderObject()! as RenderRepaintBoundary;final image=await b.toImage(pixelRatio:1);final data=await image.toByteData(format:ui.ImageByteFormat.png);File('${shots.path}/$name.png').writeAsBytesSync(data!.buffer.asUint8List());image.dispose();});
    }
    Future<void> waitFor(bool Function() condition,{int seconds=120}) async {
      final until=DateTime.now().add(Duration(seconds:seconds));
      while(!condition()){if(DateTime.now().isAfter(until))throw StateError('T11 wait timeout');await tester.runAsync(()=>Future<void>.delayed(const Duration(milliseconds:100)));await tester.pump();}
      await settleV05(tester);
    }
    String answer()=>agent.transcript.items.whereType<AssistantItem>().lastOrNull?.parts.whereType<TextPart>().map((p)=>p.text).join()??'';
    Future<String> turn(String text,String label) async {
      await rpc('test.label',{'label':label});
      final n=events.where((e)=>e['event']=='run.finished').length;
      await tester.runAsync(()=>agent.send(text));
      await waitFor(()=>events.where((e)=>e['event']=='run.finished').length>n&&!agent.isRunning);
      await tester.runAsync(agent.active!.refreshHistory);
      await settleV05(tester);
      final result=answer();
      await rpc('test.evidence',{'id':'turn:$label','question':text,'answer':result,'sessionId':agent.activeSessionId});
      return result;
    }
    Future<void> step(String id,Future<Object?> Function() body) async {
      const group=String.fromEnvironment('T11_GROUP',defaultValue:'main');
      if((group=='background')!=id.startsWith('B'))return;
      const only=String.fromEnvironment('T11_ONLY');
      if(only.isNotEmpty&&!only.split(',').any(id.startsWith))return;
      // ignore: avoid_print
      print('T11 START $id');
      Json result;
      try{final detail=await body();result={'id':id,'pass':true,'detail':detail};}
      catch(e,st){result={'id':id,'pass':false,'error':'$e','stack':'$st'};}
      checks.add(result);await rpc('test.evidence',result);
      // ignore: avoid_print
      print('T11 RESULT ${jsonEncode(result)}');
    }
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(() async {
        File('../Claude Codex Bridge/T-11-evidence/${info['stamp']}-checks.json').writeAsStringSync(jsonEncode(checks));
        await sub.cancel();try{await client.call('test.shutdown');}catch(_){}
        agent.dispose();await launched.process.stdin.close();
        await launched.process.exitCode.timeout(const Duration(seconds:25),onTimeout:(){launched.process.kill();return -1;});
        File('../Claude Codex Bridge/T-11-evidence/${info['stamp']}-stderr.log').writeAsStringSync(errors.join());
      });
    });
    await mount(const ChatView());await tester.runAsync(agent.init);await settleV05(tester);expect(agent.isReady,isTrue,reason:errors.join());
    await rpc('settings.update',{'memoryAutoExtract':false,'autoTitle':false,'autoCompaction':false,'backgroundCompaction':'off','memoryPaused':false});
    String? parentPath,secondPath,itemId,sidePath;
    await step('M01-save-new-session-snapshot',() async {
      await turn('请实际记住：本工作区用户的测试项目代号是青鹭742。调用记忆工具保存，简短回答。','save');
      final items=await rpc('memory.items',{'cwd':info['workspace']}) as List;
      final item=items.cast<Map>().firstWhere((m)=>'${m['content']}'.contains('青鹭742'));itemId=item['id'] as String;
      expect(item['scope'],'workspace');parentPath=agent.currentSessionPath;
      await tester.runAsync(agent.newSession);
      expect(await turn('本工作区的测试项目代号是什么？仅回答代号。','read-new'),contains('青鹭742'));secondPath=agent.currentSessionPath;
      final n=(await rpc('memory.snapshots',{'sessionId':agent.activeSessionId}) as List).length;
      await turn('仍是同一个项目代号问题，只回复收到，不用工具。','same-task');
      expect((await rpc('memory.snapshots',{'sessionId':agent.activeSessionId}) as List).length,n);
      return {'itemId':itemId,'snapshots':n,'parent':parentPath,'second':secondPath};
    });
    await step('M02-correction-other-session',() async {
      await tester.runAsync(()=>agent.openSession(parentPath!));
      await turn('纠正刚才的记忆：本工作区项目代号不是青鹭742，而是白鹭853。请更新原条目，旧代号不再有效。','correct');
      await tester.runAsync(()=>agent.openSession(secondPath!));
      final text=await turn('当前项目代号是什么？只回答最新值。','read-corrected');expect(text,contains('白鹭853'));
      final snap=await rpc('memory.snapshotInfo',{'sessionId':agent.activeSessionId}) as Map;expect('${snap['content']}',contains('白鹭853'));if('${snap['content']}'.contains('青鹭742'))expect('${snap['content']}',matches('作废|失效|不再有效|旧值不再'));
      return {'answer':text,'snapshot':snap};
    });
    await step('M03-global-confirmation-UI',() async {
      await turn('把本工作区项目代号白鹭853记忆提升到全局，让其他工作区也能读到。请使用记忆工具提出变更。','promote');
      final pending=await rpc('memory.pending') as List;expect(pending.any((p)=>p['why']=='promote_global'),isTrue);
      final before=await rpc('memory.items') as List;expect(before.any((m)=>m['scope']=='global'&&'${m['content']}'.contains('白鹭853')),isFalse);
      agent.openMemory(tab:'pending');await mount(const MemoryPage());expect(find.textContaining('所有工作区都能看到'),findsWidgets);await shot('promotion-before');
      await tester.tap(find.text('同意').first);await settleV05(tester);
      final after=await rpc('memory.items') as List;expect(after.any((m)=>m['scope']=='global'&&'${m['content']}'.contains('白鹭853')),isTrue);
      return {'pendingBefore':pending,'itemsAfter':after};
    });
    await step('M04-unsaved-real-response-UI-save',() async {
      await tester.runAsync(agent.newSession);await mount(const ChatView());
      await turn('这是合成验收，禁止调用任何工具。请原样回复这一句话：我已经记住了，用户喜欢紫色封面。只输出这句话。','unsaved');
      final claim=await rpc('memory.unsaved',{'sessionId':agent.activeSessionId}) as Map;expect(claim['replyEntryId'],isA<String>());
      await mount(UnsavedMemoryNote(replies:agent.transcript.items.whereType<AssistantItem>().toList()));expect(find.textContaining('其实没有保存'),findsOneWidget);await shot('unsaved-before');
      await tester.tap(find.text('保存'));await settleV05(tester);await tester.tap(find.widgetWithText(FilledButton,'保存'));await settleV05(tester);
      expect(await rpc('memory.unsaved',{'sessionId':agent.activeSessionId}),isNull);return {'claim':claim,'cleared':true};
    });
    await step('M06-task-boundary-continue-UI',() async {
      await rpc('settings.update',{'memoryAutoExtract':true,'memoryWriteFrequency':'low','memoryPaused':false});
      await tester.runAsync(agent.newSession);await mount(const ChatView());await turn('为TypeScript软件项目列出单元测试和集成测试的安排，简短三项，不调用工具。','task-original');
      final before=await rpc('memory.tasks',{'sessionId':agent.activeSessionId}) as List;
      await turn('四位朋友准备星期六在河边野餐。客人甲素食，客人乙花生过敏，请搭配可冷食的主菜、小点心、水果和饮料，注意便携且不要容易腐坏。Reply in one short sentence. No tools.','task-switch');
      final after=await rpc('memory.tasks',{'sessionId':agent.activeSessionId}) as List;expect(after.length,greaterThan(before.length));
      await tester.runAsync(agent.refreshMemorySession);await tester.runAsync(agent.active!.refreshEntryIds);await settleV05(tester);
      final user=agent.transcript.items.whereType<UserItem>().last;
      await rpc('test.evidence',{'id':'boundary-anchor','tasks':after,'boundary':agent.memoryUi.boundaries[agent.activeSessionId],'entryId':user.entryId});
      await mount(MemoryBoundaryNote(item:user));expect(find.text('改为继续上一个'),findsOneWidget);await tester.tap(find.text('改为继续上一个'));await settleV05(tester);
      final corrected=await rpc('memory.tasks',{'sessionId':agent.activeSessionId});await rpc('settings.update',{'memoryAutoExtract':false});return {'before':before,'after':after,'corrected':corrected};
    });
    await step('M05-storage-failure-no-false-claim',() async {
      await rpc('settings.update',{'memoryAutoExtract':false});await tester.runAsync(agent.newSession);await rpc('test.failSave',{'on':true});
      try {
        final text=await turn('请用memory_save实际记住：用户在本工作区项目的验收专用颜色是墨绿619。仅保存到workspace作用域，explicit=true，不提升全局。不得用文件或命令代替保存。请按工具实际结果告知是否成功，简短回答。','storage-failure');
        expect((await rpc('test.storageFaultObserved') as Map)['observed'],isTrue);
        expect((await rpc('memory.items') as List).any((m)=>'${m['content']}'.contains('墨绿619')),isFalse);expect(text,matches('失败|没有|未能|无法|没能|不能|未保存'));
        return {'answer':text,'saved':false,'fault':'SQLite BEFORE INSERT trigger'};
      } finally {await rpc('test.failSave',{'on':false});}
    });
    await step('U08-settings-detail-frequency-real-queue',() async {
      await mount(const SettingsPage(category:'记忆'));
      for(final choice in ['简要','标准','详细']){await tester.tap(find.text(choice).first);await settleV05(tester);}
      await tester.tap(find.text('换任务或关闭对话时'));await settleV05(tester);
      await rpc('settings.update',{'memoryAutoExtract':true,'memoryPaused':true});
      await turn('用户明确决定：这次合成验收的周报用中文。请只答收到，不调用工具。','low-frequency');
      final low=await inspect();expect((low['deferred'] as List).any((r)=>r['session_id']==agent.activeSessionId),isTrue);
      await mount(const SessionMemoryActions());await tester.tap(find.text('下一条作为新任务'));await settleV05(tester);
      await turn('现在开始验收任务乙，只答收到，不调用工具。','flush-low');
      final flushed=await inspect();expect((flushed['jobs'] as List).any((j)=>j['kind']=='extract'),isTrue);
      await mount(const SettingsPage(category:'记忆'));await tester.tap(find.text('每次回复后'));await settleV05(tester);
      await turn('继续任务乙：用户明确决定报告附上失败原因。只答收到，不调用工具。','standard-frequency');
      final standard=await inspect();
      final settings=await rpc('settings.get') as Map;expect(settings['memoryDetail'],'detailed');expect(settings['memoryWriteFrequency'],'standard');
      await rpc('settings.update',{'memoryAutoExtract':false,'memoryPaused':false});
      return {'low':low['deferred'],'flushedJobs':flushed['jobs'],'standardJobs':standard['jobs'],'settings':{'detail':settings['memoryDetail'],'frequency':settings['memoryWriteFrequency']}};
    });
    await step('S01-side-save-reopen-isolation',() async {
      await tester.runAsync(()=>agent.openSession(parentPath!));await mount(const ChatView());
      final parentBytes=File(parentPath!).readAsBytesSync();
      await tester.runAsync(()=>agent.openSideChat('本工作区项目代号'));
      final side=agent.sideChat!;expect(side.runtime.sessionPath,isNull);
      await mount(SideChatView(side:side));await tester.enterText(find.byType(TextField),'请记住侧边专属暗号紫燕466。本轮禁止调用任何工具或写文件，只根据父历史说出项目代号曾从什么改成什么。');await rpc('test.label',{'label':'side-first'});
      await tester.tap(find.byTooltip('在侧边对话里发送'));await waitFor(()=>side.runtime.sessionPath!=null&&!side.runtime.isRunning);
      sidePath=side.runtime.sessionPath;expect(File(sidePath!).existsSync(),isTrue);expect(File(parentPath!).readAsBytesSync(),parentBytes);
      final sid=side.runtime.state?.sessionId;expect(await rpc('memory.tasks',{'sessionId':sid}),isEmpty);
      expect((await rpc('memory.items') as List).any((m)=>'${m['content']}'.contains('紫燕466')),isFalse);
      final sideAnswer=side.items.whereType<AssistantItem>().last.parts.whereType<TextPart>().map((p)=>p.text).join();expect(sideAnswer,contains('青鹭742'));expect(sideAnswer,contains('白鹭853'));
      agent.closeSideChat();await settleV05(tester);await mount(const SessionMemoryActions());await tester.tap(find.textContaining('相关对话 ('));await settleV05(tester);await shot('related-side');
      final children=await rpc('sessions.children',{'parentSession':parentPath}) as List;
      await mount(const ChatView());await tester.runAsync(()=>agent.openSavedSideChat((children.first as Map).cast<String,dynamic>()));
      final reopened=agent.sideChat!;await mount(SideChatView(side:reopened));await tester.enterText(find.byType(TextField),'继续刚才的问题，只回复收到。');await rpc('test.label',{'label':'side-continue'});await tester.tap(find.byTooltip('在侧边对话里发送'));await waitFor(()=>!reopened.runtime.isRunning&&reopened.items.whereType<AssistantItem>().length>=2);await shot('side-reopened');
      agent.closeSideChat();await settleV05(tester);return {'path':sidePath,'children':children,'answer':sideAnswer};
    });
    await step('F01-side-first-tool-approval',() async {
      await tester.runAsync(agent.newSession);await mount(const ChatView());
      await turn('本工作区项目代号曾是青鹭742。只回复收到，不调用工具。','f01-parent-old');
      await turn('纠正：项目代号改为白鹭853，青鹭742已作废。只回复收到，不调用工具。','f01-parent-new');
      final parent=agent.currentSessionPath!;final bytes=File(parent).readAsBytesSync();
      await tester.runAsync(()=>agent.openSideChat('本工作区项目代号'));
      final side=agent.sideChat!;expect(side.runtime.sessionPath,isNull);
      final slot=side.runtime.slotId;await mount(SideChatView(side:side));
      await tester.enterText(find.byType(TextField),'请记住侧边专属暗号紫燕466。另请根据父历史说出项目代号曾从什么改成什么。请先实际调用tool_search查询memory_save是否可用；如果侧边不提供记忆工具，直接说明不能保存，不要改用文件或其他工具。');
      await rpc('test.label',{'label':'f01-side-first'});await tester.tap(find.byTooltip('在侧边对话里发送'));
      await waitFor(()=>side.runtime.pendingDialogs.isNotEmpty||(!side.runtime.isRunning&&(side.lastAnswer?.isNotEmpty??false)));
      expect(side.runtime.pendingDialogs,isNotEmpty,reason:'A reply without a real approval does not verify F-01');
      final approved=<String>[];
      final until=DateTime.now().add(const Duration(seconds:120));
      while(side.runtime.isRunning||side.runtime.pendingDialogs.isNotEmpty){
        if(DateTime.now().isAfter(until))throw StateError('Side approval completion timeout');
        if(side.runtime.pendingDialogs.isNotEmpty){
          expect(agent.pendingDialog,isNull);expect(side.runtime.slotId,slot);
          final request=side.runtime.pendingDialogs.first;approved.add(request.id);
          final card=find.byType(SideExtensionDialog);expect(card,findsOneWidget);
          final allow=find.descendant(of:card,matching:find.widgetWithText(FilledButton,'允许'));
          await tester.ensureVisible(allow);await shot('f01-retest-approval');await tester.tap(allow);await settleV05(tester);
        }
        await tester.runAsync(()=>Future<void>.delayed(const Duration(milliseconds:100)));await tester.pump();
      }
      final confirmations=await rpc('confirm.list') as List;
      final own=confirmations.where((c)=>c['slotId']==slot).toList();
      expect(own,isNotEmpty);expect(own.every((c)=>c['status']=='answered'),isTrue);
      expect(jsonEncode(own),contains('tool_search'));expect(approved.toSet().length,approved.length);
      expect(side.lastAnswer,contains('青鹭742'));expect(side.lastAnswer,contains('白鹭853'));
      expect(File(side.runtime.sessionPath!).existsSync(),isTrue);expect(File(parent).readAsBytesSync(),bytes);
      expect(await rpc('memory.tasks',{'sessionId':side.runtime.state!.sessionId}),isEmpty);
      expect((await rpc('memory.items') as List).any((m)=>'${m['content']}'.contains('紫燕466')),isFalse);
      await shot('f01-retest-finished');final result={'slotId':slot,'confirmations':own,'approved':approved,'answer':side.lastAnswer,'path':side.runtime.sessionPath};
      agent.closeSideChat();await settleV05(tester);return result;
    });
    await step('C01-normal-and-regenerate-real-summary',() async {
      await tester.runAsync(agent.newSession);await mount(const ChatView());
      final old=await rpc('memory.save',{'content':'用户测试项目旧部署端口是7319','scope':'workspace','cwd':info['workspace']}) as Map;
      await turn('约束：禁止Docker，只能本机；测试尚未运行，不能声称通过；最终交付Markdown。旧端口7319已经否定，当前端口8453。仅答收到，不用工具。','compression-constraints');
      await rpc('memory.setStatus',{'id':old['item']['id'],'status':'refuted'});
      final filler=List.generate(170,(i)=>'Dataset row $i: neutral placeholder about rivers and meadows, no preference or instruction.').join('\n');
      await turn('只答收到，不用工具。\n$filler','compression-material');
      await rpc('test.label',{'label':'normal-compact'});
      final result=await tester.runAsync(()=>agent.compact());expect(result,isNotNull);
      final points=await rpc('context.checkpoints',{'slotId':agent.active!.slotId}) as List;expect(points,isNotEmpty);
      final beforeRegenerate=await inspect();final file=File(agent.currentSessionPath!);final prefix=file.readAsStringSync();
      await mount(const SingleChildScrollView(child:ContextControls()));await shot('normal-checkpoint');
      await tester.ensureVisible(find.text('重新生成'));await rpc('test.label',{'label':'regenerate'});await tester.tap(find.text('重新生成'));
      await waitFor(()=>find.text('已按原文重写').evaluate().isNotEmpty||find.text('已在旧摘要上修订').evaluate().isNotEmpty||find.textContaining('Already compacted').evaluate().isNotEmpty||find.textContaining('Nothing to compact').evaluate().isNotEmpty);
      final immediateError=find.textContaining('Already compacted').evaluate().isNotEmpty||find.textContaining('Nothing to compact').evaluate().isNotEmpty;
      await rpc('test.evidence',{'id':'immediate-regenerate','error':immediateError,'normal':points,'visibleText':tester.widgetList<Text>(find.byType(Text)).map((t)=>t.data).whereType<String>().toList()});
      if(immediateError){
        await shot('regenerate-error');await turn('继续当前任务，仍然遵守所有已确认约束，只回复收到。','before-regenerate-retry');
        await mount(const SingleChildScrollView(child:ContextControls()));await tester.ensureVisible(find.text('重新生成'));await rpc('test.label',{'label':'regenerate-after-message'});await tester.tap(find.text('重新生成'));await waitFor(()=>find.text('已按原文重写').evaluate().isNotEmpty||find.text('已在旧摘要上修订').evaluate().isNotEmpty);
      }
      final regenerated=await rpc('context.checkpoints',{'slotId':agent.active!.slotId});
      final afterRegenerate=await inspect();
      final calls=(afterRegenerate['calls'] as List).where((c)=>c['label']=='regenerate').toList();expect(calls.length,1);
      final cost=(calls.single['usage']['cost']['total'] as num).toDouble();
      double total(Json state,String key,String field)=>(state[key] as List).fold<double>(0,(s,r)=>s+((r[field]??0) as num).toDouble());
      final runDelta=total(afterRegenerate,'runs','cost')-total(beforeRegenerate,'runs','cost');
      final gatewayDelta=total(afterRegenerate,'gateway','cost')-total(beforeRegenerate,'gateway','cost');
      expect(runDelta,closeTo(cost,1e-9));expect(gatewayDelta,closeTo(cost,1e-9));
      expect(file.readAsStringSync().startsWith(prefix),isTrue);
      final text=await turn('仅回答当前端口、是否允许Docker、测试是否已通过。不要调用工具。','after-regenerate');expect(text,contains('8453'));expect(text,isNot(contains('端口7319')));
      final evidence={'normal':points,'regenerated':regenerated,'answer':text,'immediateFailed':immediateError,'regenerateCalls':calls.length,'cost':cost,'runDelta':runDelta,'gatewayDelta':gatewayDelta,'originalFilePrefixPreserved':true,'metrics':(await inspect())['compactions']};await rpc('test.evidence',{'id':'regenerate-recovery','detail':evidence});
      expect(immediateError,isFalse,reason:'Immediate latest-checkpoint regeneration must work without an extra message');return evidence;
    });
    for(final discard in [false,true]) {
      await step(discard?'B02-background-discard-billed':'B01-background-85-used',() async {
        final gatewayStart=((await inspect())['gateway'] as List).length;
        await tester.runAsync(agent.newSession);await mount(const ChatView());
        final old=await rpc('memory.save',{'content':'用户测试服务旧端口7319','scope':'workspace','cwd':info['workspace']}) as Map;
        await turn('约束：禁止Docker；只能本机；测试尚未运行，不得声称通过；交付Markdown。旧端口7319已否定，现在8453。只答收到，不用工具。','bg-constraints-$discard');
        await rpc('memory.setStatus',{'id':old['item']['id'],'status':'refuted'});
        await rpc('settings.update',{'autoCompaction':true,'memoryAutoExtract':false});
        final slot=agent.active!.slotId;final sid=agent.activeSessionId;
        await rpc('context.setSession',{'slotId':slot,'thresholdPercent':50,'background':true});
        String filler(int n)=>List.generate(n,(i)=>'Dataset row $i: neutral placeholder content about rivers and meadows, containing no user preference or instruction.').join('\n');
        Future<List> rows() async => ((await inspect())['compactions'] as List).where((r)=>r['session_id']==sid).toList();
        Future<Json> infoNow() async => (await rpc('context.info',{'slotId':slot}) as Map).cast<String,dynamic>();
        final observations=<Json>[];
        for(var i=0;i<18;i++) {
          final state=await infoNow();observations.add(state);
          if((await rows()).any((r)=>r['outcome']=='made'))break;
          final tokens=(state['usage']?['tokens'] as num?)??0;
          final threshold=state['thresholdTokens'] as num;
          if(tokens>=threshold*.85&&tokens<threshold){
            for(var j=0;j<300;j++){if((await rows()).any((r)=>['made','failed','dropped'].contains(r['outcome'])))break;await tester.runAsync(()=>Future<void>.delayed(const Duration(milliseconds:100)));await tester.pump();}
            break;
          }
          final n=((threshold*.90-tokens)/30).floor().clamp(12,190);
          await turn('只回复收到，不用工具，不总结。\n${filler(n)}','bg-fill-$discard-$i');
        }
        final made=await rows();expect(made.any((r)=>r['outcome']=='made'),isTrue,reason:jsonEncode(made));
        if(discard)await tester.runAsync(()=>agent.setPlanMode(true));
        for(var i=0;i<6;i++) {
          if((await rows()).any((r)=>['used','done'].contains(r['outcome'])))break;
          final state=await infoNow();final gap=(state['thresholdTokens'] as num)+1500-((state['usage']?['tokens'] as num?)??0);
          await turn('只回复收到，不用工具，不总结。\n${filler((gap/30).ceil().clamp(20,180))}','bg-cross-$discard-$i');
        }
        final result=await rows();expect(result.any((r)=>r['outcome']==(discard?'dropped':'used')),isTrue,reason:jsonEncode(result));
        final points=await rpc('context.checkpoints',{'slotId':slot}) as List;expect(points,isNotEmpty);
        final summary='${points.last['summary']}';
        final retained={'Docker':summary.contains('Docker'),'local':RegExp('本机|local').hasMatch(summary),'untested':RegExp('未.*(运行|测试)|测试.*未|not.*(run|test)').hasMatch(summary),'Markdown':summary.contains('Markdown'),'8453':summary.contains('8453')};
        expect(retained.values.every((v)=>v),isTrue,reason:summary);
        if(summary.contains('7319'))expect(summary,matches('失效|否定|推翻|废弃|invalid|refut|旧端口'));
        await mount(const SingleChildScrollView(child:ContextControls()));await shot('background-$discard');
        final data=await inspect();final ownRuns=(data['runs'] as List).where((r)=>r['session_id']==sid).toList();final ownGateway=(data['gateway'] as List).skip(gatewayStart).toList();
        final runCost=ownRuns.fold<double>(0,(s,r)=>s+(r['cost'] as num).toDouble());final gatewayCost=ownGateway.fold<double>(0,(s,r)=>s+(r['cost'] as num).toDouble());
        await tester.runAsync(agent.active!.refreshHistory);final sessionCost=agent.stats.cost;
        await rpc('test.evidence',{'id':'background-before-assert','sid':sid,'observations':observations,'records':result,'summary':summary,'constraints':retained,'runCost':runCost,'sessionCost':sessionCost,'gatewayCost':gatewayCost});
        expect(runCost,closeTo(sessionCost,1e-8));expect(runCost,closeTo(gatewayCost,1e-8));
        if(discard)await tester.runAsync(()=>agent.setPlanMode(false));
        return {'observations':observations,'records':result,'summary':summary,'constraints':retained,'runs':ownRuns,'gateway':ownGateway,'runCost':runCost,'sessionCost':sessionCost,'gatewayCost':gatewayCost};
      });
    }
    await step('B03-side-compression-own-cost',() async {
      final gatewayStart=((await inspect())['gateway'] as List).length;
      await rpc('settings.update',{'autoCompaction':false});await tester.runAsync(()=>agent.openSideChat('端口与约束'));
      final side=agent.sideChat!;await mount(SideChatView(side:side));
      for(var i=0;i<2;i++) {
        final text='请只答收到，禁止任何工具。\n${List.generate(180,(j)=>'Dataset row $j: neutral placeholder content about rivers and meadows, containing no user preference or instruction.').join('\n')}';
        final n=side.items.whereType<AssistantItem>().length;await rpc('test.label',{'label':'side-compression-$i'});await tester.runAsync(()=>side.ask(text));await waitFor(()=>!side.runtime.isRunning&&side.items.whereType<AssistantItem>().length>n);
      }
      await rpc('test.label',{'label':'side-own-compact'});final result=await tester.runAsync(side.runtime.compact);expect(result,isNotNull);
      final sid=side.runtime.state!.sessionId;final data=await inspect();final calls=(data['gateway'] as List).skip(gatewayStart).toList();final cost=calls.fold<double>(0,(s,r)=>s+(r['cost'] as num).toDouble());
      expect(side.runtime.stats.cost,closeTo(cost,1e-8));final ownRuns=(data['runs'] as List).where((r)=>r['session_id']==sid).toList();expect(ownRuns.fold<double>(0,(s,r)=>s+(r['cost'] as num).toDouble()),closeTo(cost,1e-8));
      expect(await rpc('memory.tasks',{'sessionId':sid}),isEmpty);agent.closeSideChat();return {'ownCost':cost,'sessionCost':side.runtime.stats.cost,'calls':calls,'runs':ownRuns};
    });
    // Final cost reconciliation occurs before any cascade removes usage rows.
    await step('S07-three-ledgers-before-delete',() async {
      final data=await inspect();final runs=(data['runs'] as List).fold<double>(0,(s,r)=>s+(r['cost'] as num).toDouble());final gateway=(data['gateway'] as List).fold<double>(0,(s,r)=>s+(r['cost'] as num).toDouble());
      // Memory classifier/material requests have their own memory job ledger.
      await rpc('test.evidence',{'id':'ledger-window','data':data});return {'runs':runs,'gateway':gateway,'difference':gateway-runs,'spentUsd':data['spentUsd']};
    });
    await step('U02-log-undo-and-purge-UI',() async {
      final saved=await rpc('memory.save',{'content':'T11日志撤销专用条目','scope':'workspace','cwd':info['workspace']}) as Map;
      await mount(const SingleChildScrollView(child:MemoryLog()));
      final row=find.ancestor(of:find.textContaining('T11日志撤销专用条目').first,matching:find.byType(MouseRegion)).first;
      final mouse=await tester.createGesture(kind:ui.PointerDeviceKind.mouse);await mouse.addPointer();await mouse.moveTo(tester.getCenter(row));await settleV05(tester);
      await tester.tap(find.descendant(of:row,matching:find.text('撤销')).first);await settleV05(tester);await mouse.removePointer();
      final undone=await rpc('memory.item',{'id':saved['item']['id']}) as Map;expect(undone['item']['status'],isNot('active'));
      await mount(Builder(builder:(context)=>TextButton(onPressed:()=>showMemoryDetails(context,itemId!),child:const Text('详情'))));await tester.tap(find.text('详情'));await settleV05(tester);await tester.tap(find.text('更多 ▾'));await settleV05(tester);await tester.tap(find.text('彻底删除').last);await settleV05(tester);expect(find.textContaining('不可恢复'),findsWidgets);await shot('purge-warning');await tester.tap(find.widgetWithText(FilledButton,'彻底删除'));await settleV05(tester);
      return {'undone':undone,'purged':itemId};
    });
    await step('S09-cascade-UI',() async {
      await tester.runAsync(()=>agent.openSession(parentPath!));await tester.runAsync(()=>agent.forkAfterReply(null));
      final forkPath=agent.currentSessionPath;expect(forkPath,isNot(parentPath));await turn('分叉自己的请求，仅答收到。','fork-own');
      await mount(Builder(builder:(context)=>TextButton(onPressed:() async {if(await confirmSessionDelete(context,parentPath!,'合成父会话'))await agent.deleteSession(parentPath!);},child:const Text('删除父会话'))));await tester.tap(find.text('删除父会话'));await settleV05(tester);expect(find.textContaining('同时删除 1 条侧边对话'),findsOneWidget);await shot('cascade-preview');await tester.tap(find.widgetWithText(FilledButton,'删除'));await waitFor(()=>!File(parentPath!).existsSync());
      expect(File(sidePath!).existsSync(),isFalse);expect(File(forkPath!).existsSync(),isTrue);
      final list=await rpc('sessions.list',{'cwd':info['workspace']}) as List;return {'forkPath':forkPath,'rows':list};
    });
    await step('S08-private-side-no-file',() async {
      await tester.runAsync(agent.newTemporarySession);await turn('临时父会话的口令是星桥518，只回复收到。','private-parent');await tester.runAsync(()=>agent.openSideChat('口令'));
      final side=agent.sideChat!;await mount(SideChatView(side:side));expect(find.text('不保存'),findsOneWidget);await tester.enterText(find.byType(TextField),'父对话口令是什么？');await rpc('test.label',{'label':'private-side'});await tester.tap(find.byTooltip('在侧边对话里发送'));await waitFor(()=>side.items.whereType<AssistantItem>().isNotEmpty&&!side.runtime.isRunning);expect(side.runtime.sessionPath,isNull);await shot('private-side');agent.closeSideChat();return {'sessionPath':null};
    });
    if (const String.fromEnvironment('T11_DATA').isNotEmpty) {
    await step('R01-real-backend-restart-side-continue',() async {
      final rows=await rpc('sessions.list',{'cwd':info['workspace']}) as List;
      Json? child;
      for(final p in rows){final children=await rpc('sessions.children',{'parentSession':p['path']}) as List;for(final c in children){if(c['sessionType']=='side')child=(c as Map).cast<String,dynamic>();}}
      expect(child,isNotNull,reason:'Use T11_DATA pointing to the completed isolated background run');
      await tester.runAsync(()=>agent.openSession(child!['parentSession'] as String));await tester.runAsync(()=>agent.openSavedSideChat(child!));
      final side=agent.sideChat!;final before=side.items.whereType<AssistantItem>().length;await mount(SideChatView(side:side));
      await tester.enterText(find.byType(TextField),'根据此前历史，只回答当前有效端口，不要调用任何工具。');await rpc('test.label',{'label':'restart-side'});await tester.tap(find.byTooltip('在侧边对话里发送'));await waitFor(()=>!side.runtime.isRunning&&side.items.whereType<AssistantItem>().length>before);
      final text=side.lastAnswer;expect(text,contains('8453'));expect(side.runtime.sessionPath,child!['path']);expect(await rpc('memory.tasks',{'sessionId':side.runtime.state!.sessionId}),isEmpty);await shot('restart-side');agent.closeSideChat();
      return {'data':info['dir'],'child':child,'answer':text,'previousReplies':before};
    });
    }
    await step('M12-real-memory-agent-materials',() async {
      const contents=['用户写论文偏好短句','用户论文避免堆砌形容词','用户希望回复末尾列下一步','用户代码注释采用英文','用户每周五下午给导师发周报','用户周报分为完成与计划','用户修改代码先编写测试','用户测试报告需要保留失败原因','用户提交前要人工确认'];
      for(final content in contents){await rpc('memory.save',{'content':content,'scope':'global'});}
      await rpc('settings.update',{'memoryAutoExtract':true,'memoryPaused':false});await mount(const MemoryPage());
      await rpc('test.queueMaterials');await rpc('test.label',{'label':'memory-materials'});await rpc('memory.runJobs');
      final data=await rpc('test.materials') as Map;final jobs=await rpc('memory.jobs') as List;
      expect(jobs.any((j)=>j['kind']=='snapshot'&&j['status']=='done'),isTrue);expect(data['materials'],isNotEmpty);
      await rpc('settings.update',{'memoryAutoExtract':false});return {'input':contents,'jobs':jobs,'materials':data};
    });
    await rpc('test.evidence',{'id':'final-summary','checks':checks,'data':await inspect()});
    expect(checks.where((c)=>c['pass']!=true).map((c)=>c['id']).toList(),isEmpty,reason:'See T-11-evidence for each failure');
  },timeout:const Timeout(Duration(minutes:25)));
}
