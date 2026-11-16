import 'dart:async';

import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/data_storage_panel.dart';
import 'package:dreamflutter/ui/number_setting.dart';
import 'package:dreamflutter/ui/settings_controls.dart';
import 'package:dreamflutter/ui/settings_workspace.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 't87_fixture.dart';

void main(){
  Future<void> frame(WidgetTester t,{String value='2000',required Future<void> Function(String) save,Brightness brightness=Brightness.light})async{
    await t.pumpWidget(MaterialApp(theme:buildTheme(brightness),home:Scaffold(body:SingleChildScrollView(child:Padding(
      padding:const EdgeInsets.all(24),child:PresetNumberSetting(label:'每次带上的记忆',value:value,defaultValue:2000,presets:const [1000,2000,4000,8000],unit:'token',save:save,
        validator:(v){final n=int.tryParse(v);return n==null||n<=0?'请输入有效整数':null;},
      ),
    )))));
    await t.pumpAndSettle();
  }
  Future<void> choose(WidgetTester t,String label)async{
    await t.tap(find.byType(MenuAnchor));await t.pumpAndSettle();
    await t.tap(find.widgetWithText(MenuItemButton,label));await t.pumpAndSettle();
  }
  testWidgets('presets mark the default, do not write on open and save the chosen number',(t)async{
    final saved=<String>[];
    await frame(t,save:(v)async{saved.add(v);});
    expect(find.text('2,000 token（默认）'),findsOneWidget);
    expect(find.byType(TextField),findsNothing);expect(saved,isEmpty);
    await choose(t,'4,000 token');
    expect(saved,['4000']);expect(find.text('4,000 token'),findsOneWidget);
    await choose(t,'自定义…');
    expect(t.widget<TextField>(find.byType(TextField)).controller!.text,'4000');
    expect(saved,['4000']);
  });
  testWidgets('custom numbers survive loading, validate and keep the last saved value after a failed preset',(t)async{
    final saved=<String>[];var fail=false;
    await frame(t,value:'3456',save:(v)async{if(fail)throw StateError('保存失败');saved.add(v);});
    expect(find.text('自定义 · 3,456 token'),findsOneWidget);
    await t.enterText(find.byType(TextField),'-1');
    await t.testTextInput.receiveAction(TextInputAction.done);await t.pumpAndSettle();
    expect(find.text('请输入有效整数'),findsOneWidget);expect(saved,isEmpty);
    await t.enterText(find.byType(TextField),'5678');
    await t.testTextInput.receiveAction(TextInputAction.done);await t.pumpAndSettle();
    expect(saved,['5678']);expect(find.text('自定义 · 5,678 token'),findsOneWidget);
    fail=true;await choose(t,'8,000 token');
    expect(find.textContaining('未保存：'),findsOneWidget);
    expect(t.widget<SettingMenu<String>>(find.byType(SettingMenu<String>)).value,'custom');
    expect(t.widget<TextField>(find.byType(TextField)).controller!.text,'5678');
  });
  testWidgets('a pending blur save cannot overwrite a later preset',(t)async{
    final first=Completer<void>();final writes=<String>[];
    await frame(t,value:'3000',save:(v)async{writes.add(v);if(v=='3500')await first.future;});
    final custom=t.widget<AutoSaveField>(find.byType(AutoSaveField));
    final oldSave=custom.save('3500');await t.pump();
    final menu=t.widget<SettingMenu<String>>(find.byType(SettingMenu<String>));
    menu.onSelected('4000');await t.pump();
    expect(writes,['3500']);
    first.complete();await oldSave;await t.pumpAndSettle();
    expect(writes,['3500','4000']);
    expect(find.text('4,000 token'),findsOneWidget);expect(find.byType(TextField),findsNothing);
  });
  testWidgets('presets and custom input fit a narrow page with enlarged text',(t)async{
    await t.binding.setSurfaceSize(const Size(360,700));addTearDown(()=>t.binding.setSurfaceSize(null));
    t.platformDispatcher.textScaleFactorTestValue=1.5;addTearDown(t.platformDispatcher.clearTextScaleFactorTestValue);
    for(final brightness in Brightness.values){
      await frame(t,value:'3456',brightness:brightness,save:(_)async{});
      await choose(t,'8,000 token');
      expect(t.takeException(),isNull);
    }
  });
  testWidgets('data safety prioritizes backup and uninstall and only expands locations on request or search',(t)async{
    final f=(await t.runAsync(T87Fixture.create))!;
    addTearDown(()async{await t.pumpWidget(const SizedBox());await t.runAsync(f.dispose);await t.binding.setSurfaceSize(null);});
    await t.binding.setSurfaceSize(const Size(1200,1100));
    await t.pumpWidget(AgentScope(controller:f.agent,child:MaterialApp(theme:buildTheme(Brightness.light),home:const Scaffold(body:SettingsPage(category:'数据与安全')))));
    await t.pumpAndSettle();
    expect(t.getTopLeft(find.text('备份').first).dy,lessThan(t.getTopLeft(find.text('卸载').first).dy));
    expect(t.getTopLeft(find.text('卸载').first).dy,lessThan(t.getTopLeft(find.text('敏感路径').first).dy));
    expect(find.byType(DataStoragePanel),findsNothing);
    await t.ensureVisible(find.text('数据位置'));await t.tap(find.text('数据位置'));await t.pumpAndSettle();
    expect(find.byType(DataStoragePanel),findsOneWidget);
    await t.tap(find.text('数据位置'));await t.pumpAndSettle();
    expect(find.byType(DataStoragePanel),findsNothing);
    await t.enterText(find.widgetWithText(TextField,'搜索设置'),'数据位置');await t.pumpAndSettle();
    expect(find.byType(DataStoragePanel),findsOneWidget);
    expect(t.takeException(),isNull);
  });
  testWidgets('memory preset and custom value keep the documented settings key',(t)async{
    final f=(await t.runAsync(T87Fixture.create))!;
    addTearDown(()async{await t.pumpWidget(const SizedBox());await t.runAsync(f.dispose);await t.binding.setSurfaceSize(null);});
    await t.binding.setSurfaceSize(const Size(1200,1100));
    await t.pumpWidget(AgentScope(controller:f.agent,child:MaterialApp(theme:buildTheme(Brightness.light),home:const Scaffold(body:SettingsPage(category:'记忆')))));
    await t.pumpAndSettle();
    final field=find.byKey(const ValueKey('memoryBudgetTokens'));
    final menu=find.descendant(of:field,matching:find.byType(MenuAnchor));
    await t.ensureVisible(menu);await t.tap(menu);await t.pumpAndSettle();
    await t.tap(find.widgetWithText(MenuItemButton,'8,000 token'));await t.pumpAndSettle();
    expect(f.backend.callsTo('settings.update').last,{'memoryBudgetTokens':8000});
    await t.tap(menu);await t.pumpAndSettle();await t.tap(find.widgetWithText(MenuItemButton,'自定义…'));await t.pumpAndSettle();
    final input=find.descendant(of:field,matching:find.byType(TextField));
    await t.enterText(input,'3500');await t.testTextInput.receiveAction(TextInputAction.done);await t.pumpAndSettle();
    expect(f.backend.callsTo('settings.update').last,{'memoryBudgetTokens':3500});
  });
}
