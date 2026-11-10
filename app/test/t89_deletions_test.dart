import 'dart:convert';
import 'package:dreamflutter/desktop_shell.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/garden_deletions.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:tray_manager/tray_manager.dart';
import 'fake_backend.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('T89 deletion commits once after five seconds independently of the page', (tester) async {
    SharedPreferences.setMockInitialValues({}); await tester.runAsync(SharedPreferences.getInstance);
    final backend = FakeBackend(), queue = GardenDeletions(FakeBackend());
    final actual = GardenDeletions(backend); addTearDown(actual.dispose); queue.dispose();
    await actual.stage('skill:a','skills.remove',{'filePath':'a'});
    await tester.pump(const Duration(seconds:4)); expect(backend.callsTo('skills.remove'),isEmpty);
    await tester.pump(const Duration(seconds:1)); await tester.pump();
    expect(backend.callsTo('skills.remove'),hasLength(1)); expect(actual.hiddenKeys,isEmpty);
    await tester.pump(const Duration(seconds:5)); expect(backend.callsTo('skills.remove'),hasLength(1));
  });
  testWidgets('T89 interrupted undo grace commits on restart and backup excludes pending deletes', (tester) async {
    SharedPreferences.setMockInitialValues({}); final prefs=(await tester.runAsync(Preferences.load))!;
    final backend=FakeBackend(), old=GardenDeletions(FakeBackend());
    await old.stage('template:a','templates.remove',{'name':'a'}); old.dispose();
    expect(prefs.exportAll(),isNot(contains(GardenDeletions.preferenceKey)));
    final next=GardenDeletions(backend); addTearDown(next.dispose); await next.resume();
    expect(backend.callsTo('templates.remove'),hasLength(1)); expect(next.hiddenKeys,isEmpty);
    await prefs.importAll({GardenDeletions.preferenceKey:jsonEncode([{'id':'stale'}])});
    expect((await SharedPreferences.getInstance()).getString(GardenDeletions.preferenceKey),'[]');
  });
  testWidgets('T89 failed exit deletion is retained for the next successful restart', (tester) async {
    SharedPreferences.setMockInitialValues({}); await tester.runAsync(SharedPreferences.getInstance);
    final backend=FakeBackend()..handlers['mcp.remove']=(_)=>throw StateError('offline');
    final old=GardenDeletions(backend); await old.stage('mcp:a','mcp.remove',{'name':'a','source':'user'}); await old.flushPending(); old.dispose();
    backend.handlers['mcp.remove']=(_)=>{'ok':true};
    final next=GardenDeletions(backend); addTearDown(next.dispose); await next.resume();
    expect(backend.callsTo('mcp.remove'),hasLength(2)); expect(next.hiddenKeys,isEmpty);
  });
  testWidgets('T89 cancelling exit preserves undo; confirmed exit deletes before Core shutdown', (tester) async {
    final order=<String>[];
    for(final name in ['window_manager','tray_manager']) {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(MethodChannel(name),(call) async { order.add(call.method); return call.method=='isFocused'?true:null; });
      addTearDown(()=>TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(MethodChannel(name),null));
    }
    SharedPreferences.setMockInitialValues({});
    final backend=FakeBackend(); backend.handlers['app.exitState']=(_)=>{'busy':true};
    backend.handlers['skills.remove']=(_){order.add('delete');return {'ok':true};}; backend.handlers['core.shutdown']=(_){order.add('shutdown');return {'ok':true};};
    final agent=AgentController(preferences:(await tester.runAsync(Preferences.load))!,backend:backend); addTearDown(agent.dispose);
    var allow=false;
    final shell=DesktopShell(agent,confirmExit:() async=>allow); await tester.runAsync(shell.init);
    await agent.gardenDeletions.stage('skill:a','skills.remove',{'filePath':'a'});
    shell.onTrayMenuItemClick(MenuItem(key:'quit_all')); await tester.pump(); expect(order,isNot(contains('delete')));
    allow=true; shell.onTrayMenuItemClick(MenuItem(key:'quit_all'));
    for(var i=0;i<10;i++){await tester.runAsync(()=>Future<void>.delayed(const Duration(milliseconds:10)));await tester.pump();}
    expect(order.indexOf('delete'),greaterThanOrEqualTo(0)); expect(order.indexOf('delete'),lessThan(order.indexOf('shutdown'))); expect(order,contains('destroy'));
  });
}
