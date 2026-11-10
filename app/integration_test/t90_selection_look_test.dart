import 'dart:io';
import 'dart:ui' as ui;
import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../test/t90_fixture.dart';

void main(){
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('T-90 selectable file diffs in native light dark and 150 percent', (tester) async {
    final core=(await tester.runAsync(startT90Core))!;final backend=T90Backend(core.client,core.zone)..sessionRows=[];final cwd=core.workspace;
    backend.onLaunch=(pi){pi.messages=t90History(cwd);};
    backend.handlers['runs.list']=(_)=>[{'id':'run','status':'done','files':['$cwd/report.md','$cwd/summary.md']}];
    backend.handlers['tasks.forSession']=(_)=>{'id':'task'};
    backend.handlers['artifacts.list']=(_)=>[{'path':'$cwd/report.md'},{'path':'$cwd/summary.md'}];
    SharedPreferences.setMockInitialValues({'workspace':cwd,'onboarded':true});
    final agent=AgentController(preferences:await Preferences.load(),backend:backend,sessionStore:SessionStore(sessionsDir:core.info['sessions'] as String));
    final boundary=GlobalKey();final shots=Directory(p.join(Directory.current.path,'build','t90_selection_shots'))..createSync(recursive:true);
    addTearDown(() async{await tester.pumpWidget(const SizedBox());agent.dispose();await tester.runAsync(core.close);});
    Future<void> wait() async{for(var i=0;i<150;i++){await tester.runAsync(()=>Future<void>.delayed(const Duration(milliseconds:100)));await tester.pump(const Duration(milliseconds:100));if(backend.pendingGit==0 && i>=5)break;}expect(backend.pendingGit,0);expect(tester.takeException(),isNull);}
    Future<void> shot(String name) async{await wait();await tester.runAsync(() async{final image=await (boundary.currentContext!.findRenderObject() as RenderRepaintBoundary).toImage(pixelRatio:1);final bytes=await image.toByteData(format:ui.ImageByteFormat.png);File(p.join(shots.path,'$name.png')).writeAsBytesSync(bytes!.buffer.asUint8List());image.dispose();});}
    await tester.binding.setSurfaceSize(const Size(1400,900));await tester.pumpWidget(RepaintBoundary(key:boundary,child:DreamFlutterApp(controller:agent)));
    await tester.runAsync(agent.init);await tester.runAsync(()=>agent.openSession(p.join(cwd,'conversation.jsonl')));agent.setRunPanelOpen(true);await wait();
    for(final dark in [false,true]){
      final color=dark?'dark':'light';await agent.setThemeMode(dark?ThemeMode.dark:ThemeMode.light);
      await tester.tap(find.text('提交这些改动'));await shot('collapsed_$color');
      expect(tester.widgetList<Checkbox>(find.byType(Checkbox)).map((w)=>w.value),everyElement(isTrue));
      await tester.tap(find.byKey(const ValueKey('commit-expand-report.md')));await tester.tap(find.byKey(const ValueKey('commit-expand-summary.md')));await shot('expanded_$color');
      expect(find.textContaining('diff --git'),findsNothing);expect(find.textContaining('@@'),findsNothing);
      await tester.tap(find.byKey(const ValueKey('commit-select-summary.md')));await shot('selected_$color');
      await tester.binding.setSurfaceSize(const Size(1000,800));await agent.setZoom(1.5);await tester.runAsync(()=>Future<void>.delayed(const Duration(seconds:2)));await shot('selected_150_$color');
      await tester.tap(find.text('取消').last);await agent.setZoom(1);await tester.binding.setSurfaceSize(const Size(1400,900));await wait();
    }
    await tester.tap(find.text('提交这些改动'));await wait();await tester.tap(find.byKey(const ValueKey('commit-select-summary.md')));
    final input=find.byWidgetPredicate((w)=>w is TextField && w.decoration?.labelText=='提交说明');await tester.enterText(input,'只更新实验小结');await wait();
    await tester.tap(find.text('确认提交'));await wait();expect(find.textContaining('已提交 '),findsOneWidget);
    for(final dark in [false,true]){await agent.setThemeMode(dark?ThemeMode.dark:ThemeMode.light);await shot('success_${dark?'dark':'light'}');}
    final result=await tester.runAsync(()=>core.call('test.result')) as Map;expect(result['files'],['report.md']);expect(result['staged'],'unrelated.txt');expect(await tester.runAsync(()=>core.call('confirm.list')),isEmpty);
  });
}
