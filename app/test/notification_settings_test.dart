import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/notification_settings.dart';
import 'package:dreamflutter/ui/settings_controls.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 't87_fixture.dart';

void main(){
  testWidgets('separate notification defaults and writes keep the existing master switch',(t)async{
    final f=(await t.runAsync(T87Fixture.create))!;
    addTearDown(()async{await t.pumpWidget(const SizedBox());await t.runAsync(f.dispose);});
    await t.pumpWidget(AgentScope(controller:f.agent,child:MaterialApp(theme:buildTheme(Brightness.light),home:const Scaffold(body:NotificationSettings()))));
    await t.pumpAndSettle();
    Finder toggle(String title)=>find.descendant(of:find.widgetWithText(SettingsSwitch,title),matching:find.byType(V1Toggle));
    expect(t.widget<V1Toggle>(toggle('工作台')).value,isFalse);
    expect(t.widget<V1Toggle>(toggle('蝶君')).value,isTrue);
    await t.tap(toggle('工作台'));await t.pumpAndSettle();
    expect(f.backend.callsTo('settings.update').last,{'workbenchNotifications':true});
    await t.tap(toggle('蝶君'));await t.pumpAndSettle();
    expect(f.backend.callsTo('settings.update').last,{'butterflyNotifications':false});
    await t.tap(toggle('系统通知'));await t.pumpAndSettle();
    expect(f.backend.callsTo('settings.update').last,{'notifications':false});
  });
}
