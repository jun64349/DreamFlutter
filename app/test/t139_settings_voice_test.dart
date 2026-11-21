import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dreamflutter/state/voice_input.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/settings_butterfly.dart';
import 'package:dreamflutter/ui/settings_voice.dart';
import 'package:dreamflutter/ui/settings_restore.dart';
import 'package:dreamflutter/ui/library_page.dart';
import 'package:dreamflutter/theme.dart';
import 'fake_backend.dart';
import 't87_fixture.dart';
import 'v012_fixture.dart';

class FakeVoiceAudio implements VoiceAudioSource {
  final audio=StreamController<Uint8List>.broadcast();int stops=0;
  @override Future<Stream<Uint8List>> start()async=>audio.stream;
  @override Future<void> stop()async{stops++;}
  @override Future<void> dispose()async{await audio.close();}
}
void main(){
  Future<void> settle(WidgetTester t)async{await t.runAsync(()=>Future<void>.delayed(const Duration(milliseconds:60)));await t.pump();}
  Future<T87Fixture> mount(WidgetTester t,Widget child)async{
    final f=(await t.runAsync(T87Fixture.create))!;
    f.backend.settings=(V012Fixtures.read('settings.get.t139') as Map).cast<String,dynamic>();
    f.agent.coreSettings={...f.backend.settings};f.backend.handlers['settings.get']=(_)=>f.backend.settings;
    for(final m in ['persona.presets','selfwork.longGoals.list','selfwork.history','selfwork.longGoals.save','selfwork.longGoals.delete','selfwork.skills.list','selfwork.skills.adopt','voice.keyStatus','voice.modelStatus','voice.downloadModel','voice.setKey','uninstall.preservedData']){f.backend.useFixture(m);}
    addTearDown(()async{await t.pumpWidget(const SizedBox());await t.runAsync(f.dispose);});
    await t.binding.setSurfaceSize(const Size(1200,1000));
    await t.pumpWidget(AgentScope(controller:f.agent,child:MaterialApp(theme:buildTheme(Brightness.light),home:Scaffold(body:SingleChildScrollView(child:child)))));await settle(t);return f;
  }
  testWidgets('persona, proactivity and budget write documented setting keys',(t)async{
    final f=await mount(t,const Column(children:[PersonaChoices(),ButterflyProactivity()]));
    expect(f.backend.callsTo('persona.presets').last,isEmpty);
    await t.tap(find.text('暖'));await settle(t);
    expect(f.backend.callsTo('settings.update').last,{'butterflyPersona':'warm'});
    expect(find.text(personaWords['warm']!.$3),findsOneWidget); // 原型气泡预览不带引号
    await t.tap(find.text('中'));await settle(t);
    expect(f.backend.callsTo('settings.update').last,{'butterflyProactivity':'mid'});
    expect(find.text('再按你给的长期目标自己往前推。'),findsOneWidget);
    await t.tap(find.text('0.5 美元（默认）'));await t.pumpAndSettle();await t.tap(find.widgetWithText(MenuItemButton,'1 美元'));await settle(t);
    expect(f.backend.callsTo('settings.update').last,{'butterflyDailyBudget':1});
  });
  testWidgets('long goal expansion, revisioned edit and deletion use recorded results',(t)async{
    final f=await mount(t,const ButterflyLongGoals());
    final row=(V012Fixtures.read('selfwork.longGoals.list') as List).first as Map;
    await t.tap(find.text('${row['title']}'));await settle(t);
    expect(f.backend.callsTo('selfwork.history').last,isEmpty);expect(find.text('整理了三篇公开资料'),findsOneWidget);
    await t.tap(find.text('修改'));await t.pumpAndSettle();await t.tap(find.text('保存'));await settle(t);await t.pumpAndSettle();
    expect(f.backend.callsTo('selfwork.longGoals.save').last,{'id':row['id'],'revision':row['revision'],'title':row['title'],'instruction':row['instruction']});
    f.backend.useFixture('selfwork.longGoals.list','deleted');await t.tap(find.text('删除'));await settle(t);
    expect(f.backend.callsTo('selfwork.longGoals.delete').last,{'id':row['id']});expect(find.text('${row['title']}'),findsNothing);
  });
  testWidgets('cloud voice settings never display the saved key',(t)async{
    final f=await mount(t,const VoiceSettings());
    expect(find.text('服务'),findsNothing);await t.tap(find.text('云端'));await settle(t);
    expect(f.backend.callsTo('settings.update').last,{'voiceMode':'cloud'});expect(find.text('阿里云百炼'),findsOneWidget);
    await t.tap(find.text('填写'));await t.pumpAndSettle();await t.enterText(find.byType(TextField),'T139_TEST_KEY');
    expect(t.widget<TextField>(find.byType(TextField)).obscureText,isTrue);
    f.backend.useFixture('voice.keyStatus','configured');await t.tap(find.text('保存'));await settle(t);await t.pumpAndSettle();
    expect(f.backend.callsTo('voice.setKey').last,{'key':'T139_TEST_KEY'});expect(find.text('已填写'),findsOneWidget);expect(find.text('T139_TEST_KEY'),findsNothing);
    await t.tap(find.text('本机'));await settle(t);expect(f.backend.callsTo('settings.update').last,{'voiceMode':'local'});
    await t.pump(const Duration(milliseconds:300)); // Let the closed key dialog dispose its field.
  });
  testWidgets('local voice model downloads from settings and follows progress events (0.13.1 step 3)',(t)async{
    final f=await mount(t,const VoiceSettings());
    expect(find.text('本机模型'),findsOneWidget);
    await t.tap(find.text('下载 · 约 230 MB'));await settle(t);
    expect(f.backend.callsTo('voice.downloadModel'),hasLength(1));expect(find.text('下载中 0%'),findsOneWidget);
    f.backend.push({'event':'voice.model','state':'downloading','received':119616921,'total':239233841,'error':null});await settle(t);
    expect(find.text('下载中 50%'),findsOneWidget);
    f.backend.push({'event':'voice.model','state':'failed','received':119616920,'total':239233841,'error':'语音模型下载失败'});await settle(t);
    expect(find.text('重新下载'),findsOneWidget);expect(find.text('语音模型下载失败'),findsOneWidget);
    f.backend.push({'event':'voice.model','state':'ready','received':239233841,'total':239233841,'error':null});await settle(t);
    expect(find.text('已就绪'),findsOneWidget);
    await t.tap(find.text('云端'));await settle(t);expect(find.text('本机模型'),findsNothing);
  });
  testWidgets('self-written skills adopt into current workspace and keep source mark',(t)async{
    final f=await mount(t,const ButterflySkills());expect(find.text('蝶君写的'),findsOneWidget);
    f.backend.useFixture('selfwork.skills.list','adopted');await t.tap(find.text('也给工作台用'));await settle(t);
    expect(f.backend.callsTo('selfwork.skills.adopt').last,{'id':'ui-skill','cwd':f.agent.workspace});expect(find.text('工作台也在用'),findsOneWidget);
  });
  testWidgets('preserved data restore and restart choice use original candidate path',(t)async{
    final row=((V012Fixtures.read('uninstall.preservedData.found') as Map)['candidates'] as List).first as Map;
    var continued=0,restored=0;
    final f=await mount(t,PreservedDataWelcome(candidate:row.cast<String,dynamic>(),onContinue:()=>continued++,onRestored:()=>restored++));
    await t.tap(find.text('重新开始'));await t.pump();expect(find.text('${row['path']}'),findsOneWidget);
    await t.tap(find.text('继续'));expect(continued,1);expect(f.backend.callsTo('uninstall.restorePreservedData'),isEmpty);
    await t.pumpWidget(const SizedBox());
    f.backend.useFixture('uninstall.restorePreservedData');
    await t.pumpWidget(AgentScope(controller:f.agent,child:MaterialApp(theme:buildTheme(Brightness.light),home:Scaffold(body:PreservedDataWelcome(candidate:row.cast<String,dynamic>(),onContinue:(){},onRestored:()=>restored++)))));
    await t.tap(find.text('找回来'));await settle(t);expect(f.backend.callsTo('uninstall.restorePreservedData').last,{'path':row['path']});expect(find.text('正在找回'),findsOneWidget);
    final result=(V012Fixtures.read('backup.restoreResult.preserved') as Map).cast<String,dynamic>();result['at']=DateTime.now().millisecondsSinceEpoch;
    f.agent.restoreResult.value=result;await t.pump();expect(restored,1);
  });
  // Starting the uninstall itself is covered in t141_hookup_test; cancelling must not touch it.
  testWidgets('uninstall dialog cancel writes no marker and launches nothing',(t)async{
    final f=await mount(t,const UninstallSetting());await t.tap(find.text('卸载…'));await t.pumpAndSettle();await t.tap(find.text('保留我的数据'));await t.pump();
    await t.tap(find.text('取消'));await t.pumpAndSettle();expect(f.backend.calls.where((c)=>c.method.startsWith('uninstall.')),isEmpty);
  });
  test('voice sends 150ms PCM in order, corrected final text, then cancels separately',()async{
    final backend=FakeBackend(),source=FakeVoiceAudio();String text='';
    for(final method in ['voice.start','voice.chunk','voice.end','voice.cancel']){backend.useFixture(method);}
    final voice=VoiceInput(backend,source:source,onText:(v)=>text=v);
    await voice.start('原文：');final id=(V012Fixtures.read('voice.start') as Map)['sessionId'];
    source.audio.add(Uint8List(9600));await Future<void>.delayed(const Duration(milliseconds:10));
    expect(backend.callsTo('voice.chunk').length,2);for(final call in backend.callsTo('voice.chunk')){expect(call,{'sessionId':id,'pcm':base64Encode(Uint8List(4800))});}
    for(final e in V012Fixtures.read('events/voice.partial') as List){backend.push((e as Map).cast<String,dynamic>());}await Future<void>.delayed(Duration.zero);expect(text,'原文：123');
    for(final e in V012Fixtures.read('events/voice.final') as List){backend.push((e as Map).cast<String,dynamic>());}await Future<void>.delayed(Duration.zero);
    await voice.end();expect(text,'原文：123.');expect(backend.callsTo('voice.end').last,{'sessionId':id});expect(backend.calls.map((c)=>c.method),['voice.start','voice.chunk','voice.chunk','voice.end']);
    backend.useFixture('voice.start','cancel');await voice.start(text);await voice.cancel();expect(backend.callsTo('voice.cancel').last,{'sessionId':(V012Fixtures.read('voice.start.cancel') as Map)['sessionId']});
    voice.dispose();await Future<void>.delayed(Duration.zero);await backend.dispose();
  });
}
