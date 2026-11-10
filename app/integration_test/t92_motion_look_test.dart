import 'dart:io';
import 'dart:ui' as ui;
import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/message_widgets.dart';
import 'package:dreamflutter/ui/motion.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import '../test/t87_fixture.dart';
import '../test/t89_fixture.dart';

void main(){
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('T92 completed pages motion in light dark and reduced states',(tester)async{
    final memory=(await tester.runAsync(T87Fixture.create))!;
    final garden=(await tester.runAsync(T89Fixture.create))!;
    final boundary=GlobalKey();final shots=Directory(p.join(Directory.current.path,'build','t92_shots'))..createSync(recursive:true);
    addTearDown(()async{tester.platformDispatcher.clearAccessibilityFeaturesTestValue();await tester.pumpWidget(const SizedBox());await tester.runAsync(memory.dispose);await tester.runAsync(garden.dispose);});
    Future<void> wait()async{for(var i=0;i<6;i++){await tester.runAsync(()=>Future<void>.delayed(const Duration(milliseconds:35)));await tester.pump(const Duration(milliseconds:100));}expect(tester.takeException(),isNull);}
    Future<void> shot(String name,{bool settle=true})async{if(settle)await wait();await tester.runAsync(()async{final image=await(boundary.currentContext!.findRenderObject()as RenderRepaintBoundary).toImage(pixelRatio:1);final data=await image.toByteData(format:ui.ImageByteFormat.png);File(p.join(shots.path,'$name.png')).writeAsBytesSync(data!.buffer.asUint8List());image.dispose();});expect(tester.takeException(),isNull);}
    Future<void> mount(AgentController agent)async{await tester.pumpWidget(const SizedBox());await tester.pumpWidget(RepaintBoundary(key:boundary,child:DreamFlutterApp(controller:agent)));await wait();}
    Future<void> mid(Duration duration)async{await tester.runAsync(()=>Future<void>.delayed(const Duration(milliseconds:20)));await tester.pump();await tester.pump(duration~/2);}
    await tester.binding.setSurfaceSize(const Size(1400,900));memory.agent.showSection(AppSection.memory);await mount(memory.agent);
    for(final dark in [false,true]){
      final color=dark?'dark':'light';final agent=memory.agent;
      await agent.setThemeMode(dark?ThemeMode.dark:ThemeMode.light);agent.showSection(AppSection.memory);await shot('memory_$color');
      await tester.tap(find.byType(MotionSwitch).first);await mid(AppTokens.fast);await shot('memory_switch_mid_$color',settle:false);await wait();
      await tester.tap(find.byTooltip('删除记忆').first);await mid(AppTokens.medium);await shot('memory_delete_mid_$color',settle:false);
      await tester.tap(find.text('撤销').last);await mid(AppTokens.medium);await shot('memory_restore_mid_$color',settle:false);await wait();
      await tester.runAsync(agent.openButterfly);agent.butterfly!.setRunPanelOpen(false);await shot('butterfly_$color');
      agent.showSection(AppSection.chat);await wait();final pi=memory.backend.pis.first;
      pi.startRun('核对实验小结');final tool={'role':'assistant','content':[{'type':'toolCall','id':'edit-$color','name':'edit','arguments':{'path':'report.md','oldText':'待核对','newText':'实验小结已核对'}}],'timestamp':DateTime.now().millisecondsSinceEpoch,'stopReason':'toolUse'};
      pi.emit({'type':'message_start','message':tool});pi.emit({'type':'message_end','message':tool});pi.emit({'type':'tool_execution_start','toolCallId':'edit-$color','toolName':'edit','args':(tool['content']as List).first['arguments']});await wait();
      await tester.tap(find.descendant(of:find.byType(WorkBlock).last,matching:find.byType(InkWell)).first);await mid(AppTokens.medium);await shot('process_mid_$color',settle:false);
      memory.backend.handlers['attention.list']=(_)=>{'counts':{'total':2},'now':[],'later':[],'pending':[]};await tester.runAsync(agent.attention.refresh);
      agent.setRunPanelOpen(true);await tester.pump();await tester.pump(AppTokens.slow~/2);await shot('panel_mid_$color',settle:false);await wait();
      tester.platformDispatcher.accessibilityFeaturesTestValue=FakeAccessibilityFeatures(disableAnimations:true);await tester.pump();await shot('reduced_generating_$color');
      pi.finishRun();agent.setRunPanelOpen(false);tester.platformDispatcher.clearAccessibilityFeaturesTestValue();await wait();
    }
    garden.agent.showSection(AppSection.library);await mount(garden.agent);
    for(final dark in [false,true]){
      final color=dark?'dark':'light';await garden.agent.setThemeMode(dark?ThemeMode.dark:ThemeMode.light);await shot('garden_$color');
      await tester.tap(find.byType(MotionSwitch).first);await mid(AppTokens.fast);await shot('garden_switch_mid_$color',settle:false);await wait();
      await tester.tap(find.text('删除').last);await mid(AppTokens.medium);await shot('garden_delete_mid_$color',settle:false);await wait();
      await tester.tap(find.text('撤销').last);await mid(AppTokens.medium);await shot('garden_restore_mid_$color',settle:false);await wait();
    }
  });
}
