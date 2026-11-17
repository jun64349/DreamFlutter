// 0.13.1 install verification: skipping the model step must still let the wizard finish
// (setup.complete rejected the empty `models: {}` the skip left behind).
import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/ui/setup_wizard.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 't88_fixture.dart';

void main(){
  testWidgets('wizard finishes after skipping the model and leaves models out',(t)async{
    final f=(await t.runAsync(T88Fixture.create))!;await t.binding.setSurfaceSize(const Size(1000,800));
    addTearDown(()async{await t.pumpWidget(const SizedBox());await t.runAsync(f.dispose);});
    var completed=false;
    await t.pumpWidget(DreamFlutterApp(controller:f.agent,home:SetupWizard(status:{'dataRoot':f.root.path},initialStep:2,onComplete:()=>completed=true)));await t.pumpAndSettle();
    await t.enterText(find.widgetWithText(TextField,'称呼'),'小周');await t.tap(find.text('下一步'));await t.pumpAndSettle();
    await t.tap(find.text('跳过'));await t.pumpAndSettle();
    await t.tap(find.text('跳过'));await t.pumpAndSettle();
    await t.tap(find.text('以后再说'));await t.tap(find.text('开始使用'));await t.pumpAndSettle();
    expect(completed,isTrue);
    final p=f.backend.callsTo('setup.complete').single;
    expect(p['channelId'],isNull);
    expect(p.containsKey('models'),isFalse,reason:'setup.complete rejects an empty models map');
  });
}
