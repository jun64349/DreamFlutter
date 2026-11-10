import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/ui/keys.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../test/support/clean_env.dart';

class T91Backend implements AgentBackend {
  T91Backend(this.client,this.zone);
  final CoreClient client;
  final Zone zone;
  @override Future<Json> connect() async => asJsonMap(await call('core.hello'));
  @override bool get isConnected => !client.isClosed;
  @override Future<void> get disconnected => client.closed;
  @override Stream<Json> get events => client.events;
  @override Future<Object?> call(String method,[Json params=const {},Duration timeout=const Duration(seconds:60)]) {
    if(method=='sandbox.status')return Future.value({'state':'ready','fixture':true});
    return zone.run(()=>client.call(method,params,timeout));
  }
  @override LaunchedSession launch(SessionTarget target) {
    final local=target.sandbox?SessionTarget(cwd:target.cwd,sessionPath:target.sessionPath,attachSlotId:target.attachSlotId,incognito:target.incognito,agentMode:target.agentMode,forkOf:target.forkOf,sideQuote:target.sideQuote,quoteEntryId:target.quoteEntryId,parentSlotId:target.parentSlotId):target;
    final launched=zone.run(()=>launchInCore(client,local));
    Future<void> ready() async {await launched.ready;if(target.sandbox)await call('test.butterflyRole',{'slotId':launched.slotId!()});}
    return LaunchedSession(launched.client,ready(),slotId:launched.slotId,willPersist:launched.willPersist,afterHistory:launched.afterHistory);
  }
  @override Future<void> dispose()=>client.close();
}

class T91Harness {
  T91Harness(this.process,this.backend,this.info,this.agent,this.errors);
  final Process process;
  final T91Backend backend;
  final Json info;
  final AgentController agent;
  final List<String> errors;
  final capture=GlobalKey();
  final shots=Directory(p.join(Directory.current.path,'build',const String.fromEnvironment('T91_SHOTS',defaultValue:'t91_shots')))..createSync(recursive:true);
  String get workspace=>info['workspace'] as String;
  String get home=>info['home'] as String;
  static Future<T91Harness> start() async {
    HeldKeys.askWindows=false;
    final process=await Process.start('node',['--disable-warning=ExperimentalWarning','integration_test/support/t91_core.ts'],environment:testCoreEnvironment(),includeParentEnvironment:false);
    final errors=<String>[];process.stderr.transform(utf8.decoder).listen(errors.add);
    final ready=Completer<Json>();
    process.stdout.transform(utf8.decoder).transform(const LineSplitter()).listen((line){if(line.startsWith('{')&&!ready.isCompleted)ready.complete(asJsonMap(jsonDecode(line)));});
    process.exitCode.then((code){if(!ready.isCompleted)ready.completeError(StateError('T91 Core exited $code: ${errors.join()}'));});
    final info=await ready.future.timeout(const Duration(seconds:60));
    final client=await CoreClient.connect(port:info['port'] as int,token:info['token'] as String);
    final backend=T91Backend(client,Zone.current);
    SharedPreferences.setMockInitialValues({'workspace':info['workspace'],'recentWorkspaces':[info['workspace'],info['other']],'onboarded':true,'migratedToCore':true,'themeMode':'light'});
    final agent=AgentController(preferences:await Preferences.load(),backend:backend,sessionStore:SessionStore(sessionsDir:info['sessions'] as String));
    return T91Harness(process,backend,info,agent,errors);
  }
  Future<Object?> rpc(String method,[Json params=const {}])=>backend.call(method,params);
  Future<void> script(List<Json> steps) async {await rpc('test.responses',{'steps':steps});}
  Future<void> mount(WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(1400,950));
    await tester.pumpWidget(RepaintBoundary(key:capture,child:DreamFlutterApp(controller:agent)));
    await tester.runAsync(agent.init);await wait(tester,()=>agent.isReady);
  }
  Future<void> tick(WidgetTester tester,[int ms=60]) async {
    await tester.runAsync(()=>Future<void>.delayed(Duration(milliseconds:ms)));
    await tester.pump(const Duration(milliseconds:100));
    final error=tester.takeException();if(error!=null)throw TestFailure('$error');
  }
  Future<void> settle(WidgetTester tester) async {for(var i=0;i<5;i++){await tick(tester);}}
  Future<void> wait(WidgetTester tester,bool Function() probe,{int seconds=20}) async {
    final deadline=DateTime.now().add(Duration(seconds:seconds));
    while(!probe()){if(DateTime.now().isAfter(deadline))throw TestFailure('T91 timeout: ${agent.statusDetail}; running=${agent.isRunning}; editor=${agent.active?.editorText}; transcript=${agent.transcript.items.length}; core=${jsonEncode(await rpc('test.inspect'))}; ${errors.join()}');await tick(tester);}
    await settle(tester);
  }
  Finder get composer=>find.byWidgetPredicate((w)=>w is TextField&&w.decoration?.hintText=='说点什么…');
  Future<void> send(WidgetTester tester,String text,{bool finish=true,AgentController? owner}) async {
    await tester.tap(composer);await tester.enterText(composer,text);await tester.pump();await tester.tap(find.byTooltip('发送'));await tick(tester);
    if(finish)await wait(tester,()=>!(owner??agent).isRunning&&(owner??agent).transcript.items.whereType<AssistantItem>().isNotEmpty);
  }
  Future<void> tap(WidgetTester tester,Finder finder) async {
    bool present(){try{return finder.evaluate().isNotEmpty;}on StateError{return false;}}
    if(!present())await wait(tester,present);
    await tester.ensureVisible(finder);await tester.pump();await tester.tap(finder);await settle(tester);
  }
  Future<void> hoverAnswer(WidgetTester tester) async {
    final text=agent.transcript.items.whereType<AssistantItem>().last.parts.whereType<TextPart>().map((p)=>p.text).join();
    final finder=find.textContaining(text.split('\n').first,findRichText:true).last;
    await tester.ensureVisible(finder);final mouse=await tester.createGesture(kind:PointerDeviceKind.mouse);await mouse.addPointer(location:Offset.zero);await mouse.moveTo(tester.getCenter(finder));await settle(tester);
    addTearDown(mouse.removePointer);
  }
  Future<void> shot(WidgetTester tester,String name) async {
    await settle(tester);await tester.runAsync(() async {final boundary=capture.currentContext!.findRenderObject()! as RenderRepaintBoundary;final image=await boundary.toImage(pixelRatio:1);final bytes=await image.toByteData(format:ui.ImageByteFormat.png);File(p.join(shots.path,'$name.png')).writeAsBytesSync(bytes!.buffer.asUint8List());image.dispose();});
  }
  Future<void> close(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());agent.dispose();
    await tester.runAsync(() async {
      try{await rpc('test.shutdown');}catch(_){}
      await process.stdin.close();await process.exitCode.timeout(const Duration(seconds:15),onTimeout:(){process.kill();return -1;});
      if(!backend.client.isClosed)await backend.dispose();
      if(Directory(info['root'] as String).existsSync())throw StateError('T91 fixture did not clean ${info['root']}');
    });
  }
}
