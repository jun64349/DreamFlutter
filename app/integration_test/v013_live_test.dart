// 0.13 real-task verification (docs/releases/v0.13-真实任务验证计划.md).
// Production window + production Core + the user's OpenCode Go channel (copied
// into an isolated data dir with its keys still encrypted) + a temporary WSL
// sandbox. Every model request passes the budget gate in core/scripts/v013-live-core.ts.
// Refuses to run without an explicit source and approved cap:
//   cd app; flutter test integration_test/v013_live_test.dart -d windows --dart-define=V013_SOURCE=E:\DreamFlutter测试版\data --dart-define=V013_MAX_USD=0.50
// Results: app/build/v013_live/report.json and screenshots next to it. Judged by
// files, exit codes, Core records and the budget receipts, not by the model's own words.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/ui/conversation_cards.dart';
import 'package:dreamflutter/ui/keys.dart';
import 'package:dreamflutter/ui/sidebar.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../test/support/clean_env.dart';

const source = String.fromEnvironment('V013_SOURCE');
const maxUsd = String.fromEnvironment('V013_MAX_USD');
const only = String.fromEnvironment('V013_ONLY');

class LiveBackend implements AgentBackend {
  LiveBackend(this.client,this.zone);
  final CoreClient client;
  final Zone zone;
  @override Future<Json> connect() async => asJsonMap(await call('core.hello'));
  @override bool get isConnected => !client.isClosed;
  @override Future<void> get disconnected => client.closed;
  @override Stream<Json> get events => client.events;
  @override Future<Object?> call(String method,[Json params=const {},Duration timeout=const Duration(seconds:90)])=>zone.run(()=>client.call(method,params,timeout));
  @override LaunchedSession launch(SessionTarget target)=>zone.run(()=>launchInCore(client,target));
  @override Future<void> dispose()=>client.close();
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('V013 真实任务验证',(tester) async {
    if(source.isEmpty||(double.tryParse(maxUsd)??0)<=0)fail('需要 --dart-define=V013_SOURCE 和 V013_MAX_USD（用户批准的上限）');
    HeldKeys.askWindows=false;
    final out=Directory(p.join(Directory.current.path,'build','v013_live'))..createSync(recursive:true);
    final coreDir=p.normalize(p.join(Directory.current.path,'..','core'));
    final errors=<String>[];final cleanupLine=Completer<String>();
    final process=(await tester.runAsync(()=>Process.start('node',['--disable-warning=ExperimentalWarning','scripts/v013-live-core.ts','--source',source,'--max-usd',maxUsd],workingDirectory:coreDir,environment:testCoreEnvironment(),includeParentEnvironment:false)))!;
    final ready=Completer<Json>();
    process.stderr.transform(utf8.decoder).transform(const LineSplitter()).listen((line){errors.add(line);if(line.startsWith('V013_CLEANUP')&&!cleanupLine.isCompleted)cleanupLine.complete(line);});
    process.stdout.transform(utf8.decoder).transform(const LineSplitter()).listen((line){if(line.startsWith('{')&&!ready.isCompleted)ready.complete(asJsonMap(jsonDecode(line)));});
    unawaited(process.exitCode.then((code){if(!ready.isCompleted)ready.completeError(StateError('V013 Core exited $code: ${errors.join('\n')}'));}));
    final info=(await tester.runAsync(()=>ready.future.timeout(const Duration(minutes:5))))!;
    final client=(await tester.runAsync(()=>CoreClient.connect(port:info['port'] as int,token:info['token'] as String)))!;
    final backend=LiveBackend(client,Zone.current);
    final workspace=info['workspace'] as String, other=info['other'] as String;
    SharedPreferences.setMockInitialValues({'workspace':workspace,'recentWorkspaces':[workspace,other],'onboarded':true,'migratedToCore':true,'themeMode':'light'});
    final agent=(await tester.runAsync(() async=>AgentController(preferences:await Preferences.load(),backend:backend,sessionStore:SessionStore(sessionsDir:info['sessions'] as String))))!;
    final capture=GlobalKey();
    await tester.binding.setSurfaceSize(const Size(1400,950));
    await tester.pumpWidget(RepaintBoundary(key:capture,child:DreamFlutterApp(controller:agent)));
    await tester.runAsync(agent.init);

    // runAsync swallows errors: carry them out and rethrow so a refused call fails its step.
    Future<Object?> rpc(String method,[Json params=const {}]) async {
      Object? error;
      final result=await tester.runAsync<Object?>(() async {try{return await backend.call(method,params,const Duration(seconds:120));}catch(e){error=e;return null;}});
      if(error!=null)throw StateError('$method 失败：$error');
      return result;
    }
    Future<void> tick([int ms=80]) async {await tester.runAsync(()=>Future<void>.delayed(Duration(milliseconds:ms)));await tester.pump(const Duration(milliseconds:100));tester.takeException();}
    Future<void> settle() async {for(var i=0;i<5;i++){await tick();}}
    Future<void> wait(String what,bool Function() probe,{int seconds=240}) async {
      final deadline=DateTime.now().add(Duration(seconds:seconds));
      while(!probe()){if(DateTime.now().isAfter(deadline))throw TestFailure('等待超时：$what（${agent.statusDetail}；running=${agent.isRunning}）');await tick(250);}
      await settle();
    }
    Future<void> waitAsync(String what,Future<bool> Function() probe,{int seconds=240}) async {
      final deadline=DateTime.now().add(Duration(seconds:seconds));
      while(!await probe()){if(DateTime.now().isAfter(deadline))throw TestFailure('等待超时：$what');await tick(1500);}
    }
    bool present(Finder f){try{return f.evaluate().isNotEmpty;}on StateError{return false;}}
    Future<void> tap(Finder f,{int seconds=30}) async {if(!present(f))await wait('出现 $f',()=>present(f),seconds:seconds);await tester.ensureVisible(f.first);await tester.pump();await tester.tap(f.first);await settle();}
    Future<void> shot(String name) async {await settle();await tester.runAsync(() async {final b=capture.currentContext!.findRenderObject()! as RenderRepaintBoundary;final img=await b.toImage(pixelRatio:1);final bytes=await img.toByteData(format:ui.ImageByteFormat.png);File(p.join(out.path,'$name.png')).writeAsBytesSync(bytes!.buffer.asUint8List());img.dispose();});}
    final composer=find.byKey(const ValueKey('composer-input'));
    String reply(AgentController a)=>a.transcript.items.whereType<AssistantItem>().lastOrNull?.parts.whereType<TextPart>().map((x)=>x.text).join()??'';
    Future<void> send(String text,{AgentController? owner,bool finish=true,int seconds=300}) async {
      final o=owner??agent;final before=o.transcript.items.whereType<AssistantItem>().length;
      await tap(composer);await tester.enterText(composer,text);await tester.pump();await tester.tap(find.byTooltip('发送'));await tick();
      if(finish)await wait('回复完成',()=>!o.isRunning&&o.transcript.items.whereType<AssistantItem>().length>before&&reply(o).trim().isNotEmpty,seconds:seconds);
    }
    Finder nav(String text)=>['工作台','蝶君','等你处理','新对话'].contains(text)?find.descendant(of:find.byType(Sidebar),matching:find.text(text)).first:find.byTooltip(text).first;
    Future<Json> sandboxRead(String path) async=>asJsonMap(await rpc('test.sandboxRead',{'path':path}));
    Future<Json> inspect() async=>asJsonMap(await rpc('test.inspect'));
    List<String> tools(AgentController a)=>[for(final run in a.transcript.tools.values)run.name];
    String plain(String s)=>s.replaceAll(',','').replaceAll('，','');

    final results=<Json>[];
    Future<void> step(String id,String title,Future<Json> Function() body) async {
      if(only.isNotEmpty&&!only.split(',').contains(id))return;
      final started=DateTime.now();final before=asJsonMap((await inspect())['budget']);
      final row=<String,Object?>{'id':id,'title':title};
      try{final evidence=await body();row['passed']=evidence.remove('passed')!=false;row['evidence']=evidence;await shot('${id}_done');}
      catch(e){row['passed']=false;row['error']='$e'.split('\n').take(6).join('\n');try{await shot('${id}_failed');}catch(_){}}
      final after=asJsonMap((await inspect())['budget']);
      row['seconds']=DateTime.now().difference(started).inSeconds;
      row['requests']=(after['requests'] as int)-(before['requests'] as int);
      row['usd']=((after['usedUsd'] as num)-(before['usedUsd'] as num)).toDouble();
      results.add(row);
      File(p.join(out.path,'progress.json')).writeAsStringSync(const JsonEncoder.withIndent('  ').convert(results));
      if(after['fatal']!=null)throw TestFailure('预算闸门已停止：${after['fatal']}');
    }

    String? badChannel;
    final goodChannel=(info['provider'] as String).substring(3);
    try {
      await wait('窗口就绪',()=>agent.isReady,seconds:60);

      // S1 渠道和模型：已复制渠道测试连接；新增一个坏密钥渠道（假值，非真实凭据）看失败说明。
      await step('S1','渠道和模型：测试连接与新增渠道',() async {
        agent.showSection(AppSection.settings);await settle();
        await tap(find.byKey(const ValueKey('settings-nav-模型')));
        final row=find.text('OpenCode Go');await wait('渠道列表',()=>present(row));
        final mouse=await tester.createGesture(kind:PointerDeviceKind.mouse);await mouse.addPointer(location:Offset.zero);await mouse.moveTo(tester.getCenter(row.first));await settle();
        await tap(find.text('测试'));
        await wait('连接测试结果',()=>present(find.textContaining('可用 ·'))||present(find.textContaining('密钥不对'))||present(find.textContaining('连不上')),seconds:60);
        final okText=present(find.textContaining('可用 ·'));
        await mouse.removePointer();
        await shot('S1_test');
        await tap(find.text('添加渠道'));
        await tap(find.widgetWithText(ChoiceChip,'OpenCode Go'));
        final name=find.byWidgetPredicate((w)=>w is TextField&&w.decoration?.labelText=='渠道名称');
        await tester.enterText(name,'V013 坏密钥');
        if(!present(find.byWidgetPredicate((w)=>w is TextField&&(w.decoration?.labelText??'').startsWith('密钥 '))))await tap(find.text('再加一个'));
        await tester.enterText(find.byWidgetPredicate((w)=>w is TextField&&(w.decoration?.labelText??'').startsWith('密钥 ')).first,'df-v013-not-a-real-key');
        await tap(find.text('获取模型列表'));
        await wait('获取模型列表',()=>present(find.textContaining('deepseek',findRichText:true))||present(find.textContaining('DeepSeek')),seconds:60);
        await tap(find.widgetWithText(OutlinedButton,'测试连接'));
        await wait('坏密钥测试结果',()=>present(find.textContaining('密钥不对')),seconds:60);
        await shot('S1_bad_key');
        final channels=(await rpc('gateway.channels') as List).cast<Map>();
        badChannel=channels.where((c)=>c['name']=='V013 坏密钥').firstOrNull?['id'] as String?;
        return {'passed':okText&&badChannel!=null,'copiedChannelTest':okText,'badChannelSaved':badChannel,'badKeyMessage':'密钥不对'};
      });

      // S2 工作台：读样本、写脚本、运行、出报告；按文件与重新运行的退出码判定。
      await step('S2','工作台：读取样本、运行脚本、生成报告',() async {
        agent.showSection(AppSection.chat);await settle();await tap(nav('新对话'));
        final modelLabel=tester.widgetList<Text>(find.descendant(of:find.byKey(const ValueKey('composer-model')),matching:find.byType(Text))).map((t)=>t.data??'').join(' ');
        await send('请读取 samples/north.csv 和 samples/south.csv，写一个 Node.js 脚本 scripts/summary.mjs：计算每个区域三个月的订单总数和收入总额（收入保留两位小数），以及两个区域的合计，并打印出来。用 node 运行它，再把结果写成 report.md（包含一个 Markdown 表格）。最后告诉我两区域合计收入是多少。',seconds:420);
        final script=File(p.join(workspace,'scripts','summary.mjs')), report=File(p.join(workspace,'report.md'));
        ProcessResult? rerun;
        if(script.existsSync())rerun=await tester.runAsync(()=>Process.run('node',[script.path],workingDirectory:workspace));
        final reportText=report.existsSync()?plain(report.readAsStringSync()):'';
        final rerunText=plain('${rerun?.stdout??''}');
        final expected=['49036.50','44131.00','93167.50','383','349','732'];
        final used=tools(agent);
        return {'passed':script.existsSync()&&rerun?.exitCode==0&&expected.every(reportText.contains)&&['49036.5','44131','93167.5'].every(rerunText.contains)&&plain(reply(agent)).contains('93167.5'),
          'model':modelLabel,'tools':used,'scriptExit':rerun?.exitCode,'reportHas':{for(final e in expected)e:reportText.contains(e)},'rerunStdout':rerunText.trim().split('\n').take(8).join(' | '),'reply':reply(agent).trim().split('\n').take(4).join(' ')};
      });

      // S3 审批：拒绝无副作用；允许写入与允许命令后执行；处理过的审批卡收起。
      await step('S3','审批：拒绝与允许（写入、命令）',() async {
        await agent.setApprovalMode(ApprovalMode.changes);await settle();
        final target=File(p.join(workspace,'approval-check.txt'));
        await send('请在工作区新建 approval-check.txt，内容写：第一次。',finish:false);
        await wait('审批卡（写入，拒绝）',()=>present(find.byType(ConversationApprovalCard)),seconds:240);
        final beforeReject=target.existsSync();
        await shot('S3_approval');
        await tap(find.widgetWithText(OutlinedButton,'拒绝'));
        await wait('拒绝后结束',()=>!agent.isRunning,seconds:240);
        final afterReject=target.existsSync();final foldedReject=!present(find.byType(ConversationApprovalCard));
        await send('我改主意了，请新建 approval-check.txt，内容写：允许后写入。',finish:false);
        await wait('审批卡（写入，允许）',()=>present(find.byType(ConversationApprovalCard))||(!agent.isRunning&&reply(agent).isNotEmpty),seconds:240);
        if(present(find.byType(ConversationApprovalCard)))await tap(find.widgetWithText(FilledButton,'允许'));
        await wait('允许后结束',()=>!agent.isRunning&&!present(find.byType(ConversationApprovalCard)),seconds:240);
        final written=target.existsSync()?target.readAsStringSync():null;
        final cmdFile=File(p.join(workspace,'cmd-check.txt'));
        await send('请用终端命令运行：node -e "require(\'fs\').writeFileSync(\'cmd-check.txt\',\'cmd-ok\')"，不要用写文件工具。',finish:false);
        var cmdApproval=false;
        await wait('命令审批或结束',()=>present(find.byType(ConversationApprovalCard))||!agent.isRunning&&reply(agent).isNotEmpty,seconds:240);
        if(present(find.byType(ConversationApprovalCard))){cmdApproval=true;await tap(find.widgetWithText(FilledButton,'允许'));}
        await wait('命令结束',()=>!agent.isRunning&&!present(find.byType(ConversationApprovalCard)),seconds:240);
        final folded=!present(find.byType(ConversationApprovalCard));
        await agent.setApprovalMode(ApprovalMode.off);
        return {'passed':!beforeReject&&!afterReject&&foldedReject&&(written?.contains('允许后写入')??false)&&cmdApproval&&cmdFile.existsSync()&&folded,
          'fileBeforeDecision':beforeReject,'fileAfterReject':afterReject,'rejectFolded':foldedReject,'writtenAfterAllow':written,'commandAskedApproval':cmdApproval,'commandOutput':cmdFile.existsSync()?cmdFile.readAsStringSync():null,'allFolded':folded};
      });

      // S4 蝶君与沙箱：打招呼不通知；任务在隔离沙箱交付并通知；缺信息才问，回答后继续。
      AgentController? worker;
      await step('S4','蝶君与沙箱：对话、交付、提问与恢复',() async {
        await tap(nav('蝶君'));await wait('蝶君就绪',()=>agent.butterfly?.isReady==true,seconds:180);worker=agent.butterfly!;
        final notices0=((await inspect())['notices'] as List).length;
        await send('你好',owner:worker);
        final greet=reply(worker!);
        await tick(3000);final notices1=((await inspect())['notices'] as List).length;
        await send('请读取沙箱里的 /workspace/inbox/visits.csv，算出五天的访客总数和日均访客（保留一位小数），把结果写到 /workspace/outbox/visits-summary.md，做完告诉我。',owner:worker,seconds:480);
        await waitAsync('交付文件',() async=>(await sandboxRead('/workspace/outbox/visits-summary.md'))['exists']==true,seconds:300);
        final summary=plain('${(await sandboxRead('/workspace/outbox/visits-summary.md'))['content']}');
        await waitAsync('结果通知',() async=>((await inspect())['notices'] as List).length>notices1,seconds:180).catchError((_){});
        final afterDelivery=await inspect();
        final tasks=(await rpc('butterfly.tasks') as List).cast<Map>();
        await shot('S4_delivery');
        // Missing information: 蝶君 should ask instead of guessing.
        await send('帮我把上次说的那份给客户的材料改一下再发出去。',owner:worker,finish:false);
        Json? question;
        await waitAsync('蝶君提问或回复',() async {
          final now=(asJsonMap(await rpc('attention.list'))['now'] as List).map(asJsonMap).where((r)=>r['kind']=='question');
          question=now.firstOrNull;
          return question!=null||(!worker!.isRunning&&reply(worker!).isNotEmpty);
        },seconds:300);
        await shot('S4_question');
        final asked=question!=null;
        final askedInReply=!asked&&RegExp(r'哪|什么|？|\?').hasMatch(reply(worker!));
        if(asked){
          await rpc('attention.resolve',{'id':question!['id'],'action':'answer','response':{'value':'材料就是 /workspace/outbox/visits-summary.md，改成 Markdown 表格就行，不用发出去。'}});
        } else {
          await send('材料就是 /workspace/outbox/visits-summary.md，改成 Markdown 表格就行，不用发出去。',owner:worker,finish:false);
        }
        await waitAsync('改成表格',() async=>'${(await sandboxRead('/workspace/outbox/visits-summary.md'))['content']}'.contains('|'),seconds:420);
        await wait('蝶君结束',()=>!worker!.isRunning,seconds:300);
        final finalSummary=plain('${(await sandboxRead('/workspace/outbox/visits-summary.md'))['content']}');
        final hostCopy=File(p.join(workspace,'visits-summary.md')).existsSync();
        return {'passed':greet.isNotEmpty&&notices1==notices0&&summary.contains('1665')&&summary.contains('333')&&(asked||askedInReply)&&finalSummary.contains('|')&&!hostCopy,
          'greeting':greet.split('\n').first,'greetingNotified':notices1!=notices0,'summary':summary.trim().split('\n').take(6).join(' | '),
          'notices':afterDelivery['notices'],'receipts':afterDelivery['receipts'],'tasks':[for(final t in tasks)'${t['status']}'],
          'askedViaAttention':asked,'askedInReplyOnly':askedInReply,'question':question?['title'],'tableAfterAnswer':finalSummary.contains('|'),'leakedToHostWorkspace':hostCopy};
      });

      // S5 记忆：保存约定，新会话读取；另一个工作区看不到。
      await step('S5','记忆：保存、跨会话读取、工作区范围',() async {
        await tap(nav('工作台'));await tap(nav('新对话'));
        await send('请记住：这个项目的报告数字一律保留两位小数，标题用中文。这是这个项目的长期约定。');
        final saved=jsonEncode(await rpc('memory.list',{'cwd':workspace}));
        final savedHere=saved.contains('两位小数');
        await tap(nav('新对话'));
        await send('这个项目写报告有什么约定？只回答约定本身。');
        final recalled=reply(agent);
        final elsewhere=jsonEncode(await rpc('memory.list',{'cwd':other}));
        final leaked=elsewhere.contains('两位小数');
        return {'passed':savedHere&&recalled.contains('两位')&&!leaked,'saved':savedHere,'recalled':recalled.trim().split('\n').take(3).join(' '),'visibleInOtherWorkspace':leaked,'tools':tools(agent)};
      });

      // S6 日程：到点提醒与蝶君任务；系统通知不受工作台通知关闭影响。
      await step('S6','日程：短期提醒与短期任务',() async {
        final settings=asJsonMap(await rpc('settings.get'));
        // The time box takes absolute times only (「今天 14:00」); 「N分钟后」 is not understood.
        final at=DateTime.now().add(const Duration(minutes:2));
        final when='今天 ${at.hour.toString().padLeft(2,'0')}:${at.minute.toString().padLeft(2,'0')}';
        final relative=await rpc('schedules.parseTime',{'text':'1分钟后'}).then((_)=>'understood',onError:(e)=>'$e'.split('：').last);
        final remind=asJsonMap(asJsonMap(await rpc('schedules.parseTime',{'text':when}))['trigger']);
        final r=asJsonMap(await rpc('schedules.save',{'name':'V013 提醒','kind':'reminder','trigger':remind}));
        final run=remind;
        final t=asJsonMap(await rpc('schedules.save',{'name':'V013 任务','kind':'task','trigger':run,'prompt':'在沙箱里新建 /workspace/outbox/v013-schedule.txt，内容只写一行：日程任务完成。'}));
        final n0=((await inspect())['notices'] as List).length;
        await tap(find.byTooltip(RegExp('日程|时令')).first).catchError((_){});await shot('S6_schedule_page');
        var arrived=true;
        await waitAsync('日程任务产物',() async=>(await sandboxRead('/workspace/outbox/v013-schedule.txt'))['exists']==true,seconds:300).catchError((_){arrived=false;});
        await tick(5000);
        // Wherever the run actually wrote: the sandbox tree and 蝶君's host folder.
        final sandboxTree='${asJsonMap(await rpc('test.sandboxList',{'path':'/workspace'}))['out']}';
        final home=Directory(info['sandboxHome'] as String);
        final hostHits=home.existsSync()?[for(final f in home.listSync(recursive:true).whereType<File>())if(p.basename(f.path).contains('v013'))f.path]:<String>[];
        final butterflyTasks=await rpc('butterfly.tasks');
        final file='${(await sandboxRead('/workspace/outbox/v013-schedule.txt'))['content']}';
        final insp=await inspect();final notices=(insp['notices'] as List).cast<Map>();
        final reminded=notices.skip(n0).any((n)=>'${n['title']}${n['body']}'.contains('V013 提醒'));
        final history=await rpc('schedules.history',{'id':t['id']??asJsonMap(t['schedule'])['id']}).catchError((e)=>'$e');
        final list=await rpc('schedules.list');
        await shot('S6_after');
        return {'passed':arrived&&file.contains('日程任务完成')&&reminded,'sandboxTree':sandboxTree,'hostHits':hostHits,'butterflyTasks':butterflyTasks,'time':when,'relativeTime':relative,'workbenchNotifications':settings['workbenchNotifications'],'reminderNotified':reminded,'taskFile':file.trim(),
          'newNotices':notices.skip(n0).toList(),'history':history,'list':list,'saved':[r['id']??r,t['id']??t]};
      });

      // S7 技能：从链接导入、信任前不可用、确认后调用一次。
      await step('S7','技能：导入、信任、调用',() async {
        final url=asJsonMap(await rpc('test.skillUrl'))['url'] as String;
        agent.showSection(AppSection.chat);await settle();
        await tap(nav('技能'));
        await tap(find.text('新建'));await tap(find.text('从链接导入'));
        await tester.enterText(find.byWidgetPredicate((w)=>w is TextField&&w.decoration?.labelText=='链接'),url);await tap(find.widgetWithText(FilledButton,'导入'));
        await wait('导入完成',()=>find.byType(AlertDialog).evaluate().isEmpty,seconds:60);
        var skill=(await rpc('skills.list',{'cwd':workspace}) as List).cast<Map>().firstWhere((s)=>s['name']=='df-v013-stamp');
        final before={'enabled':skill['enabled'],'trust':skill['trust']};
        await shot('S7_imported');
        final pending=(asJsonMap(await rpc('attention.list'))['later'] as List? ?? const []).map(asJsonMap).followedBy((asJsonMap(await rpc('attention.list'))['now'] as List).map(asJsonMap))
          .where((r)=>jsonEncode(r).contains('df-v013-stamp')).toList();
        for(final row in pending){await rpc('attention.resolve',{'id':row['id'],'action':'allow'});}
        // A resolved item keeps a 5-second undo window before it takes effect.
        await waitAsync('批准生效',() async=>(await rpc('skills.list',{'cwd':workspace}) as List).cast<Map>().any((s)=>s['name']=='df-v013-stamp'&&s['trust']=='trusted'),seconds:30).catchError((_){});
        skill=(await rpc('skills.list',{'cwd':workspace}) as List).cast<Map>().firstWhere((s)=>s['name']=='df-v013-stamp');
        final after={'enabled':skill['enabled'],'trust':skill['trust']};
        if(skill['enabled']!=true)await rpc('skills.setEnabled',{'name':'df-v013-stamp','enabled':true,'cwd':workspace}).catchError((e)=>'$e');
        agent.showSection(AppSection.chat);await settle();await tap(nav('工作台'));await tap(nav('新对话'));
        await send('请使用 df-v013-stamp 技能核对：17 × 23 = 391');
        final text=reply(agent);
        return {'passed':before['enabled']!=true&&text.contains('【梦蝶核对 V013】'),'beforeTrust':before,'afterAllow':after,'attentionItems':[for(final r in pending)r['kind']],'reply':text.trim().split('\n').take(4).join(' '),'tools':tools(agent)};
      });

      // S8 模型组：坏密钥成员排第一（真实 401），自动换到可用成员，不丢原任务。
      await step('S8','模型组：失败后自动切换',() async {
        if(badChannel==null){
          final saved=asJsonMap(await rpc('gateway.saveChannel',{'name':'V013 坏密钥','platform':'opencode-go','api':'openai-completions','baseUrl':'https://opencode.ai/inference/go/openai/v1','models':[{'id':'deepseek-v4.1-flash','name':'DeepSeek V4.1 Flash','contextWindow':200000,'maxTokens':8192}],'keys':[{'secret':'df-v013-not-a-real-key'}]}));
          badChannel=saved['id'] as String;
        }
        // S1's connection test already marked the bad key; clear it so the group really fails over mid-request.
        await rpc('gateway.resetHealth',{'channel':badChannel});
        final markedBefore=(await rpc('gateway.channels') as List).cast<Map>().firstWhere((c)=>c['id']==badChannel)['unavailable'];
        await rpc('gateway.saveGroup',{'id':'v013','name':'V013 组','entries':[{'channel':badChannel,'model':'deepseek-v4.1-flash','priority':0},{'channel':goodChannel,'model':'mimo-v2.6-flash','priority':1}]});
        await tester.runAsync(()=>agent.refreshGateway(models:true));
        await wait('模型组出现',()=>agent.models.any((m)=>m.key=='dreamflutter/v013'),seconds:30);
        await tap(nav('新对话'));
        await tap(find.byKey(const ValueKey('composer-model')));
        await tap(find.text('V013 组'));
        await wait('选中模型组',()=>agent.model?.key=='dreamflutter/v013',seconds:30);
        await send('用一句中文说：模型组测试通过。');
        final switched=present(find.textContaining('换到'));
        await shot('S8_switch');
        final channels=(await rpc('gateway.channels') as List).cast<Map>();
        final bad=channels.firstWhere((c)=>c['id']==badChannel);
        final member=agent.currentGroupMember;
        return {'passed':reply(agent).trim().isNotEmpty&&switched&&(member??'').isNotEmpty&&!(member??'').contains('坏密钥'),
          'reply':reply(agent).trim(),'badMarkedBeforeSend':markedBefore,'switchNoticeShown':switched,'currentMember':member,'badChannelUnavailable':bad['unavailable']};
      });

      // S9 运行结束：请求、花费、错误。
      await step('S9','运行结束：请求、花费与错误',() async {
        final ledger=await rpc('ledger.summary',{}).catchError((e)=>'$e');
        final requests=(await rpc('gateway.requests',{}) as List).cast<Map>();
        final insp=await inspect();
        return {'passed':true,'ledger':ledger,'gatewayRequests':requests.length,'gatewayFailures':[for(final r in requests)if(r['ok']==0||r['error']!=null)'${r['channel']} ${r['model']} ${'${r['error']??''}'.substring(0,'${r['error']??''}'.length.clamp(0,120))}'],'budget':insp['budget']};
      });
    } finally {
      final insp=await inspect().catchError((e)=><String,Object?>{'error':'$e'});
      await tester.pumpWidget(const SizedBox());agent.dispose();
      await tester.runAsync(() async {
        try{await backend.call('test.shutdown');}catch(_){}
        await process.stdin.close();
        await process.exitCode.timeout(const Duration(seconds:120),onTimeout:(){process.kill();return -1;});
        if(!client.isClosed)await client.close();
      });
      final cleanup=cleanupLine.isCompleted?await tester.runAsync(()=>cleanupLine.future):null;
      final report={'at':DateTime.now().toIso8601String(),'maxUsd':maxUsd,'channel':info['provider'],'model':info['model'],'steps':results,'budget':insp['budget'],'cleanup':cleanup,'coreLog':errors.where((l)=>!l.startsWith('V013_CLEANUP')).take(200).toList()};
      File(p.join(out.path,'report.json')).writeAsStringSync(const JsonEncoder.withIndent('  ').convert(report));
    }
    expect(results.where((r)=>r['passed']!=true).map((r)=>r['id']),isEmpty);
  },timeout:const Timeout(Duration(minutes:90)));
}
