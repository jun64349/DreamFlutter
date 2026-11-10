import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'dart:io';
import 'fake_backend.dart';
import 'package:dreamflutter/ui/motion.dart';
import 'package:dreamflutter/ui/butterfly_motion.dart';
import 'package:dreamflutter/ui/shell_widgets.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('reduced motion changes the product theme without an active transition', (tester) async {
    final root=Directory.systemTemp.createTempSync('df_t92_theme_');
    SharedPreferences.setMockInitialValues({});
    final agent=AgentController(preferences:await Preferences.load(),backend:FakeBackend(),sessionStore:SessionStore(sessionsDir:root.path));
    addTearDown(()async{tester.platformDispatcher.clearAccessibilityFeaturesTestValue();await tester.pumpWidget(const SizedBox());agent.dispose();root.deleteSync(recursive:true);});
    tester.platformDispatcher.accessibilityFeaturesTestValue=FakeAccessibilityFeatures(disableAnimations:true);
    await agent.setThemeMode(ThemeMode.light);
    await tester.pumpWidget(DreamFlutterApp(controller:agent,home:const SizedBox()));
    await agent.setThemeMode(ThemeMode.dark);await tester.pump();await tester.pump();
    final rendered=Theme.of(tester.element(find.byType(SizedBox).last));
    expect(rendered.brightness,Brightness.dark);
    expect(rendered.colorScheme.surface,buildTheme(Brightness.dark).colorScheme.surface);
  });
  final theme=buildTheme(Brightness.light);
  Widget host(Widget child, {bool reduced=false, bool enabled=true}) => MaterialApp(theme:theme,themeAnimationDuration:Duration.zero,home:MediaQuery(data:MediaQueryData(disableAnimations:reduced),child:TickerMode(enabled:enabled,child:Scaffold(body:child))));
  testWidgets('row removal stays in place and immediate undo keeps one GlobalKey editor', (tester) async {
    final editor=GlobalKey();final a=KeyedSubtree(key:const ValueKey('a'),child:SizedBox(key:editor,height:40,child:const Text('A')));const b=SizedBox(key:ValueKey('b'),height:40,child:Text('B'));
    var rows=<Widget>[a,b];late StateSetter update;
    await tester.pumpWidget(host(StatefulBuilder(builder:(context,set){update=set;return MotionRows(children:rows);})));await tester.pumpAndSettle();
    final before=tester.getTopLeft(find.text('A')).dy;
    update(()=>rows=[b]);await tester.pump();await tester.pump(AppTokens.medium~/2);
    expect(tester.getTopLeft(find.text('A')).dy,before);expect(tester.getSize(find.byType(MotionRows)).height,inExclusiveRange(40,80));
    update(()=>rows=[a,b]);await tester.pumpAndSettle();expect(find.byKey(editor),findsOneWidget);expect(find.text('A'),findsOneWidget);expect(tester.takeException(),isNull);
    update(()=>rows=[b]);await tester.pumpAndSettle();expect(find.text('A'),findsNothing);expect(tester.getTopLeft(find.text('B')).dy,before);
  });
  testWidgets('reduced motion settles an in-flight row and stops all generated-state tickers', (tester) async {
    var reduced=false, selected=false;late StateSetter update;
    await tester.pumpWidget(StatefulBuilder(builder:(context,set){update=set;return host(Column(children:[const BreathingDot(),const StreamingCaret(),const ButterflyAvatar(activity:ButterflyActivity.working),MotionSwitch(value:selected,onChanged:(value)=>update(()=>selected=value)),MotionRows(children:[if(!selected)const SizedBox(key:ValueKey('row'),height:40,child:Text('row'))])]),reduced:reduced);}));
    await tester.pump(AppTokens.fast);expect(tester.binding.transientCallbackCount,greaterThan(0));
    update((){selected=true;reduced=true;});await tester.pump();await tester.pump();
    expect(find.text('row'),findsNothing);expect(find.byType(TweenAnimationBuilder<double>),findsNothing);expect(tester.binding.transientCallbackCount,0);
  });
  testWidgets('hidden page loops stop, and a completed butterfly can run again', (tester) async {
    var enabled=true;var activity=ButterflyActivity.working;late StateSetter update;
    await tester.pumpWidget(StatefulBuilder(builder:(context,set){update=set;return host(Column(children:[const BreathingDot(),const StreamingCaret(),ButterflyAvatar(activity:activity)]),enabled:enabled);}));
    await tester.pump(AppTokens.medium);update(()=>enabled=false);await tester.pump();expect(tester.binding.transientCallbackCount,0);
    update((){enabled=true;activity=ButterflyActivity.complete;});await tester.pump();await tester.pump(AppTokens.slow*2);
    update(()=>activity=ButterflyActivity.working);await tester.pump();await tester.pump(AppTokens.slow*6);
    double y()=>tester.widgetList<Transform>(find.descendant(of:find.byType(ButterflyAvatar),matching:find.byType(Transform))).first.transform.storage[13];
    final first=y();await tester.pump(AppTokens.fast);expect(y(),isNot(closeTo(first,0.001)));
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets('switch accepts pointer and keyboard, using short tokens and immediate reduced pose', (tester) async {
    var value=false,reduced=false;late StateSetter update;
    await tester.pumpWidget(StatefulBuilder(builder:(context,set){update=set;return host(MotionSwitch(label:'自动记忆',value:value,onChanged:(next)=>update(()=>value=next)),reduced:reduced);}));await tester.pumpAndSettle();
    await tester.tap(find.byType(MotionSwitch));await tester.pump();expect(value,isTrue);
    expect(tester.widget<TweenAnimationBuilder<double>>(find.byType(TweenAnimationBuilder<double>)).duration,AppTokens.fast);
    await tester.pumpAndSettle();await tester.sendKeyEvent(LogicalKeyboardKey.tab);await tester.sendKeyEvent(LogicalKeyboardKey.space);await tester.pumpAndSettle();expect(value,isFalse);
    update((){value=true;reduced=true;});await tester.pump();expect(find.byType(TweenAnimationBuilder<double>),findsNothing);
  });
  testWidgets('attention count animates through zero without leaving a badge', (tester) async {
    var count='1';late StateSetter update;
    await tester.pumpWidget(host(StatefulBuilder(builder:(context,set){update=set;return ShellCount(count:count);})));await tester.pumpAndSettle();
    update(()=>count='');await tester.pump();expect(find.text('1'),findsOneWidget);await tester.pumpAndSettle();expect(find.text('1'),findsNothing);expect(tester.getSize(find.byType(ShellCount)),Size.zero);
  });
}
