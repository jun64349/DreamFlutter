import 'dart:io';
import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/desktop_notifications.dart';
import 'package:dreamflutter/state/installation.dart';
import 'package:dreamflutter/ui/setup_wizard.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 't88_fixture.dart';

void main(){
  testWidgets('new install waits for root selection before writing or launching; existing root is read only',(t)async{
    final f=(await t.runAsync(T88Fixture.create))!;addTearDown(()async{await t.pumpWidget(const SizedBox());await t.runAsync(f.dispose);});
    final root='${f.root.path}/fresh-data';String? saved,launched;
    await t.pumpWidget(DreamFlutterApp(controller:f.agent,home:FreshInstallation(initialRoot:root,rememberRoot:(v)async{saved=v;},launch:(v)async{launched=v;})));await t.pumpAndSettle();
    expect(Directory(root).existsSync(),isFalse);expect(launched,isNull);await t.tap(find.text('开始'));await t.pumpAndSettle();expect(Directory(root).existsSync(),isFalse);
    await t.runAsync(()async{await t.tap(find.text('下一步'));for(var i=0;i<50&&launched==null;i++){await Future<void>.delayed(const Duration(milliseconds:20));}});await t.pump();expect(saved,root);expect(launched,root);
    await t.pumpWidget(DreamFlutterApp(controller:f.agent,home:SetupWizard(status:{'dataRoot':f.root.path},initialStep:1,onComplete:(){})));await t.pumpAndSettle();expect(find.text(f.root.path),findsOneWidget);expect(find.text('选别的文件夹…'),findsNothing);
    expect(Installation.hasData(root),isFalse);File('$root/core.db').writeAsStringSync('fixture');expect(Installation.hasData(root),isTrue);
  });
  testWidgets('four native notifications are deduplicated and click retains target and owner',(t)async{
    final calls=<MethodCall>[];const channel=MethodChannel('local_notifier');
    t.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel,(call)async{calls.add(call);return call.method=='setup'?true:null;});
    addTearDown(()=>t.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel,null));
    final opened=<Map<String,dynamic>>[];
    final notifications=DesktopNotifications((target,origin)async{opened.add({...target,...origin});});
    await notifications.init();addTearDown(notifications.dispose);
    for(final kind in ['butterfly.done','butterfly.waiting','workbench.approval','workbench.done']){
      final event=<String,dynamic>{'id':kind,'event':'notification','kind':kind,'title':'完成','body':'需要你看看','target':{'page':'chat','slotId':'slot-$kind','sessionFile':'C:/fixture/$kind.jsonl'}};
      await notifications.receive(event);await notifications.receive(event);
      t.binding.channelBuffers.push('local_notifier',const StandardMethodCodec().encodeMethodCall(MethodCall('onLocalNotificationClick',{'notificationId':kind})),(_){});await t.pump();
    }
    expect(calls.where((c)=>c.method=='notify'),hasLength(4));expect(opened,hasLength(4));expect(opened.first['role'],'butterfly');expect(opened.last['role'],'main');expect(opened.last['slotId'],'slot-workbench.done');expect(opened.last['sessionFile'],'C:/fixture/workbench.done.jsonl');
  });
  testWidgets('existing data tests its encrypted channel without asking for the secret again',(t)async{
    final f=(await t.runAsync(T88Fixture.create))!;addTearDown(()async{await t.pumpWidget(const SizedBox());await t.runAsync(f.dispose);});
    await t.pumpWidget(DreamFlutterApp(controller:f.agent,home:SetupWizard(status:{'dataRoot':f.root.path,'models':{'conversation':'df-c1/flash'}},initialStep:3,onComplete:(){})));await t.pumpAndSettle();
    expect(find.widgetWithText(TextField,'留空沿用已保存的密钥'),findsOneWidget);
    await t.tap(find.text('测试连接'));await t.pumpAndSettle();expect(find.text('连接成功'),findsOneWidget);expect(f.backend.callsTo('gateway.saveChannel'),isEmpty);expect(f.backend.callsTo('setup.testChannel').single,{'channel':'c1'});
  });
  test('failed delayed action resurfaces with a retryable error and event count',()async{
    final f=await T88Fixture.create();addTearDown(f.dispose);
    final state=f.agent.attention;await state.refresh();final receipt=(await state.resolve(f.later.single,'allow'))!;expect(state.undoable,hasLength(1));
    final failed={...receipt,'status':'failed','undoable':false,'error':'暂时无法采用，请重试。'};f.receipts[receipt['id']]=failed;f.backend.push({'event':'attention.action','receipt':failed});f.backend.push({'event':'attention.changed','counts':{'total':2}});await Future<void>.delayed(Duration.zero);await state.refresh();
    expect(state.undoable,isEmpty);expect(state.hidden, isNot(contains('proposal:p')));expect(state.error,contains('请重试'));expect(state.total,2);
  });
}
