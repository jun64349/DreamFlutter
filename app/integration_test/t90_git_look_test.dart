import 'dart:io';
import 'dart:ui' as ui;
import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/ui/message_widgets.dart';
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
  testWidgets('T-90 native themes with real Core Git RPC', (tester) async {
    final core=(await tester.runAsync(startT90Core))!;final backend=T90Backend(core.client,core.zone)..sessionRows=[];
    final cwd=core.workspace;
    backend.onLaunch=(pi){pi.messages=t90History(cwd);};
    backend.handlers['runs.list']=(_)=>[{'id':'run','status':'done','files':['$cwd/report.md','$cwd/summary.md']}];
    backend.handlers['tasks.forSession']=(_)=>{'id':'task'};
    backend.handlers['artifacts.list']=(_)=>[{'path':'$cwd/report.md'},{'path':'$cwd/summary.md'}];
    SharedPreferences.setMockInitialValues({'workspace':cwd,'onboarded':true});
    final agent=AgentController(preferences:await Preferences.load(),backend:backend,sessionStore:SessionStore(sessionsDir:core.info['sessions'] as String));
    final boundary=GlobalKey();final shots=Directory(p.join(Directory.current.path,'build','t90_shots'))..createSync(recursive:true);
    addTearDown(() async{await tester.pumpWidget(const SizedBox());agent.dispose();await tester.runAsync(core.close);});
    Future<void> wait() async{for(var i=0;i<150;i++){await tester.runAsync(()=>Future<void>.delayed(const Duration(milliseconds:100)));await tester.pump(const Duration(milliseconds:100));if(backend.pendingGit==0 && i>=5)break;}expect(backend.pendingGit,0);expect(tester.takeException(),isNull);}
    Future<void> shot(String name) async{await wait();await tester.runAsync(() async{final image=await (boundary.currentContext!.findRenderObject() as RenderRepaintBoundary).toImage(pixelRatio:1);final bytes=await image.toByteData(format:ui.ImageByteFormat.png);File(p.join(shots.path,'$name.png')).writeAsBytesSync(bytes!.buffer.asUint8List());image.dispose();});}
    await tester.binding.setSurfaceSize(const Size(1400,900));await tester.pumpWidget(RepaintBoundary(key:boundary,child:DreamFlutterApp(controller:agent)));
    await tester.runAsync(agent.init);await tester.runAsync(()=>agent.openSession(p.join(cwd,'conversation.jsonl')));await wait();
    final pi=backend.pis.last;
    for(final dark in [false,true]){
      final color=dark?'dark':'light';await agent.setThemeMode(dark?ThemeMode.dark:ThemeMode.light);agent.setRunPanelOpen(true);await shot('changes_$color');
      expect(find.text('report.md'),findsOneWidget);expect(find.text('summary.md'),findsOneWidget);
      await tester.tap(find.widgetWithText(ListTile,'report.md'));await shot('diff_$color');await tester.tap(find.text('关闭').last);await wait();
      await tester.tap(find.text('提交这些改动'));await shot('commit_$color');expect(backend.callsTo('git.commit'),isEmpty);await tester.tap(find.text('取消').last);await wait();
      agent.setRunPanelOpen(false);pi.startRun('再检查一下实验小结。');
      final tool=<String,dynamic>{'role':'assistant','content':[{'type':'toolCall','id':'live-$color','name':'edit','arguments':{'path':'$cwd/report.md','oldText':'结论待补充。','newText':'已补充三组实验的对比与下一步验证。'}}],'timestamp':10,'stopReason':'toolUse'};
      pi.emit({'type':'message_start','message':tool});pi.emit({'type':'message_end','message':tool});pi.emit({'type':'tool_execution_start','toolCallId':'live-$color','toolName':'edit','args':tool['content'][0]['arguments']});await wait();
      await tester.tap(find.descendant(of:find.byType(WorkBlock).last,matching:find.byType(InkWell)).first);await shot('process_$color');
      pi.emit({'type':'extension_ui_request','id':'approval-$color','method':'select','title':'Agent 请求执行操作\n\n修改文件：$cwd/report.md','options':['允许','拒绝','本会话内总是允许「edit」']});await shot('approval_$color');
      expect(find.text('这一笔等你点头'),findsNothing);expect(find.text('修改文件：report.md'),findsOneWidget);
      await tester.binding.setSurfaceSize(const Size(1000,800));await agent.setZoom(1.5);await tester.runAsync(()=>Future<void>.delayed(const Duration(seconds:2)));await shot('approval_150_$color');
      await tester.tap(find.text('拒绝').last);pi.finishRun();await agent.setZoom(1);await tester.binding.setSurfaceSize(const Size(1400,900));
      agent.transcript.loadHistory(t90History(cwd).map(AgentMessage.fromJson));pi.messages=t90History(cwd);await wait();
    }
    await tester.runAsync(()=>core.call('test.manual'));agent.setRunPanelOpen(true);await wait();
    await tester.tap(find.text('提交这些改动'));await wait();
    final input=find.byWidgetPredicate((w)=>w is TextField && w.decoration?.labelText=='提交说明');
    await tester.enterText(input,'手动确认实验小结');
    for(final dark in [false,true]){await agent.setThemeMode(dark?ThemeMode.dark:ThemeMode.light);await shot('manual_${dark?'dark':'light'}');}
    await tester.tap(find.text('确认提交'));await wait();expect(find.textContaining('已提交 '),findsOneWidget);expect(find.textContaining('小任务模型暂时不可用'),findsNothing);
    for(final dark in [false,true]){await agent.setThemeMode(dark?ThemeMode.dark:ThemeMode.light);await shot('success_${dark?'dark':'light'}');}
    expect(await tester.runAsync(()=>core.call('confirm.list')),isEmpty);
    final result=await tester.runAsync(()=>core.call('test.result')) as Map;expect(result['files'],['report.md','summary.md']);expect(result['staged'],'unrelated.txt');
  });
}
