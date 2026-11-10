import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/memory_chat_controls.dart';
import 'package:dreamflutter/ui/memory_log.dart';
import 'package:dreamflutter/ui/memory_page.dart';
import 'package:dreamflutter/ui/side_chat_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'v05_harness.dart' show settleV05;
import 'support/clean_env.dart';

class _RealBackend implements AgentBackend {
  _RealBackend(this.client);
  final CoreClient client;
  final calls = <({String method, Json params})>[];
  @override Future<Json> connect() async => (await client.call('core.hello') as Map).cast<String,dynamic>();
  @override bool get isConnected => !client.isClosed;
  @override Future<void> get disconnected => client.closed;
  @override Stream<Json> get events => client.events;
  @override LaunchedSession launch(SessionTarget target) => launchInCore(client,target);
  @override Future<Object?> call(String method,[Json params=const {},Duration timeout=const Duration(seconds:60)]) {calls.add((method:method,params:params));return client.call(method,params,timeout);}
  @override Future<void> dispose() => client.close();
}

void main() {
  testWidgets('real T-09 RPC: paged days, source purge/cascade, matching cleared event and side reopen', (tester) async {
    final previousHttp = HttpOverrides.current;
    HttpOverrides.global = null;
    addTearDown(() => HttpOverrides.global = previousHttp);
    await tester.binding.setSurfaceSize(const Size(1200,1600));
    final errors = <String>[];
    final launched = (await tester.runAsync(() async {
      final process = await Process.start('node',['--disable-warning=ExperimentalWarning','test/support/t10_core.ts'],environment:testCoreEnvironment(),includeParentEnvironment:false);
      process.stderr.transform(utf8.decoder).listen(errors.add);
      final ready = Completer<Json>();
      process.stdout.transform(utf8.decoder).transform(const LineSplitter()).listen((line) {
        if(line.startsWith('{') && !ready.isCompleted) ready.complete((jsonDecode(line) as Map).cast<String,dynamic>());
      });
      process.exitCode.then((code){if(!ready.isCompleted) ready.completeError(StateError('Core exited $code: ${errors.join()}'));});
      return (process:process,info:await ready.future.timeout(const Duration(seconds:60)));
    }))!;
    final process = launched.process;
    final info = launched.info;
    final client = (await tester.runAsync(()=>CoreClient.connect(port:info['port'] as int,token:info['token'] as String)))!;
    final backend = _RealBackend(client);
    final received = <Json>[];
    final events = client.events.listen(received.add);
    SharedPreferences.setMockInitialValues({'workspace':info['workspace'],'onboarded':true});
    final prefs = (await tester.runAsync(Preferences.load))!;
    final agent = AgentController(preferences:prefs,sessionStore:SessionStore(sessionsDir:info['sessions'] as String),backend:backend);
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(() async {
        await events.cancel();
        try {await client.call('test.shutdown');} catch (_) {}
        agent.dispose();
        await process.stdin.close();
        await process.exitCode.timeout(const Duration(seconds:15),onTimeout:(){process.kill();return -1;});
      });
    });
    Future<void> mount(Widget child) async {
      await tester.pumpWidget(const SizedBox());
      await tester.pumpWidget(AgentScope(controller:agent,child:MaterialApp(theme:buildTheme(Brightness.light),home:Scaffold(body:child))));
      await settleV05(tester);
    }
    Future<void> turn(String question,String answer) async {
      await tester.runAsync(() async {
        await client.call('test.respond',{'text':answer});
        final before=received.where((e)=>e['event']=='run.finished').length;
        await agent.send(question);
        for(var i=0;i<200;i++) {
          if(received.where((e)=>e['event']=='run.finished').length>before || (!agent.isRunning && received.any((e)=>e['event']=='memory.unsaved'))) break;
          await Future<void>.delayed(const Duration(milliseconds:25));
        }
        await Future<void>.delayed(const Duration(milliseconds:100));
        await agent.active!.refreshHistory();
      });
      await settleV05(tester);
    }
    await mount(const SizedBox());
    await tester.runAsync(agent.init);
    await settleV05(tester);
    expect(agent.isReady,isTrue,reason:errors.join());
    await turn('请记住用户喜欢蓝色封面','我已经记住了，下次会按这个来。');
    final sid=agent.activeSessionId!;
    final claim=(await tester.runAsync(()=>client.call('memory.unsaved',{'sessionId':sid})) as Map).cast<String,dynamic>();
    expect(claim['replyEntryId'],isA<String>());
    await mount(UnsavedMemoryNote(replies:agent.transcript.items.whereType<AssistantItem>().toList()));
    expect(find.text('这件事还没记下'),findsOneWidget);
    await tester.tap(find.text('保存'));
    await settleV05(tester);
    await tester.tap(find.widgetWithText(FilledButton,'保存'));
    await settleV05(tester);
    expect(find.text('这件事还没记下'),findsNothing);
    expect(received.any((e)=>e['event']=='memory.unsaved' && e['cleared']==true && e['runId']==claim['runId']),isTrue);
    expect(await tester.runAsync(()=>client.call('memory.unsaved',{'sessionId':sid})),isNull);
    expect(agent.memoryUi.unsaved,isEmpty);

    final seed=(await tester.runAsync(()=>client.call('test.seed',{'slotId':agent.active!.slotId})) as Map).cast<String,dynamic>();
    await mount(const MemoryPage());
    expect(find.text('同意'),findsNothing);
    await tester.runAsync(() async {
      final pending = await client.call('memory.pending') as List;
      for (final item in pending) { await client.call('memory.acceptPending', {'id': (item as Map)['id']}); }
    });
    expect(await tester.runAsync(()=>client.call('memory.pending')),isEmpty);
    await mount(const SingleChildScrollView(child:MemoryLog()));
    await tester.ensureVisible(find.text('更早的记录'));
    await tester.tap(find.text('更早的记录'));
    await settleV05(tester);
    final pages=backend.calls.where((c)=>c.method=='memory.log').toList();
    expect(pages.last.params['cursor'],isA<String>());
    expect(find.byWidgetPredicate((w)=>w.key is ValueKey<String> && (w.key as ValueKey<String>).value.startsWith('memory-log-entry-')),findsNWidgets(56));
    expect(find.byType(ExpansionTile),findsNothing);
    expect(find.text('更早的记录'),findsNothing);
    await tester.runAsync(() async {await expectLater(client.call('memory.log',{'cursor':'invalid'}),throwsA(isA<CoreException>()));});
    await tester.runAsync(()=>client.call('context.setSession',{'slotId':agent.active!.slotId,'thresholdPercent':72,'background':true}));
    final contextInfo=await tester.runAsync(()=>client.call('context.info',{'slotId':agent.active!.slotId})) as Map;
    expect(contextInfo['ownThreshold'],72);
    await tester.runAsync(()=>agent.openSideChat('测试清单包含通过和失败'));
    final side=agent.sideChat!;
    final sideSlot=side.runtime.slotId;
    expect(side.runtime.sessionPath,isNull);
    await mount(SideChatView(side:side));
    await tester.runAsync(() async {
      await client.call('settings.update',{'approvalMode':'all'});
      await client.call('test.respond',{'text':'列出实际结果。','toolSearch':true});
      await side.ask('包含哪些验证？');
      for(var i=0;i<200 && side.runtime.pendingDialogs.isEmpty;i++) {await Future<void>.delayed(const Duration(milliseconds:30));}
    });
    await settleV05(tester);
    expect(side.runtime.slotId,sideSlot,reason:'first-send persistence retains the slot connection');
    expect(side.runtime.pendingDialogs.single.title,contains('tool_search'));
    final approvalId=side.runtime.pendingDialogs.single.id;
    final allow=find.descendant(of:find.byType(SideChatView),matching:find.widgetWithText(FilledButton,'允许'));
    expect(allow,findsOneWidget);
    await tester.tap(allow);
    await tester.runAsync(() async {
      for(var i=0;i<100 && (side.runtime.isRunning || side.runtime.sessionPath==null);i++) {await Future<void>.delayed(const Duration(milliseconds:30));}
    });
    await settleV05(tester);
    expect(side.runtime.pendingDialogs,isEmpty);
    expect(side.runtime.isRunning,isFalse);
    final confirmations=await tester.runAsync(()=>client.call('confirm.list')) as List;
    final answered=confirmations.singleWhere((c)=>c['id']==approvalId) as Map;
    expect(answered['slotId'],sideSlot);
    expect(answered['status'],'answered');
    expect(answered['answer']['value'],'允许');
    expect(side.lastAnswer,contains('列出实际结果。'));
    final sidePath=side.runtime.sessionPath!;
    expect(File(sidePath).existsSync(),isTrue);
    agent.closeSideChat();
    await settleV05(tester);
    final children=await tester.runAsync(()=>client.call('sessions.children',{'parentSession':seed['sourcePath']})) as List;
    expect(children,hasLength(1));
    await tester.runAsync(()=>agent.openSavedSideChat((children.single as Map).cast<String,dynamic>()));
    expect(agent.sideChat!.items.whereType<UserItem>().single.text,contains('包含哪些验证？'));
    expect(agent.sideChat!.items.whereType<UserItem>().any((i)=>i.text.contains('蓝色封面')),isFalse);
    agent.closeSideChat();
    await settleV05(tester);

    // Advanced purge is a backend capability; v0.8's memory page only has
    // recoverable deletion. Preserve real RPC/cascade/privacy coverage here.
    await tester.runAsync(() async {
      await expectLater(client.call('memory.purge', {'id': seed['sourceId']}), throwsA(isA<CoreException>()));
      final receipt = await client.call('memory.purge', {'id': seed['sourceId'], 'confirm': true}) as Map;
      expect(receipt['sessions'], isNotEmpty);
      expect(File(seed['sourcePath'] as String).existsSync(), isTrue);
      final preview = await client.call('sessions.deletePreview', {'path': seed['sourcePath']}) as Map;
      expect(preview['sideCount'], 1);
      await client.call('sessions.delete', {'path': seed['sourcePath']});
    });
    expect(File(sidePath).existsSync(), isFalse);
    expect(File(seed['sourcePath'] as String).existsSync(), isFalse);
    final log=await tester.runAsync(()=>client.call('memory.log',{'itemId':seed['sourceId']})) as Map;
    final purge=((log['days'] as List).single['entries'] as List).single as Map;
    expect(purge['kind'],'purge');expect(purge['after'],isNull);expect(purge['undoable'],isFalse);
    expect(jsonEncode(purge),isNot(contains('来源记忆：测试清单')));
  },timeout:const Timeout(Duration(minutes:3)));
}
