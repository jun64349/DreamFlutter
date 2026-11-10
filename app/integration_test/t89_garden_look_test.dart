import 'dart:io';
import 'dart:ui' as ui;
import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/garden_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import '../test/t89_fixture.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('T89 garden and accepted T87 refinements in both themes at 1000x800 and 150 percent', (tester) async {
    final f=(await tester.runAsync(T89Fixture.create))!;
    f.backend.handlers['sandbox.status']=(_) => {'state':'ready'};
    final worker=(await tester.runAsync(f.agent.ensureButterfly))!;
    final tasks=<Map<String,dynamic>>[];
    f.backend.handlers['butterfly.tasks']=(_) => tasks;
    final shots=Directory(p.join(Directory.current.path,'build','t89_shots'))..createSync(recursive:true);
    final key=GlobalKey();
    addTearDown(() async { await tester.pumpWidget(const SizedBox()); await tester.runAsync(f.dispose); });
    Future<void> wait() async { for(var i=0;i<6;i++){ await tester.runAsync(()=>Future<void>.delayed(const Duration(milliseconds:40))); await tester.pump(const Duration(milliseconds:100)); } expect(tester.takeException(),isNull); }
    Finder listText(String text) => find.descendant(of: find.descendant(of: find.byType(GardenPage), matching: find.byType(ListView)), matching: find.text(text));
    Future<void> reveal(String text, [double delta=180]) async {
      await tester.scrollUntilVisible(listText(text), delta, scrollable: find.descendant(of: find.byType(GardenPage), matching: find.byType(Scrollable)).first);
      await wait();
    }
    Future<void> shot(String name) async { await wait(); await tester.runAsync(() async { final boundary=key.currentContext!.findRenderObject()! as RenderRepaintBoundary; final image=await boundary.toImage(pixelRatio:1); final data=await image.toByteData(format:ui.ImageByteFormat.png); File(p.join(shots.path,'$name.png')).writeAsBytesSync(data!.buffer.asUint8List()); image.dispose(); }); }
    await tester.binding.setSurfaceSize(const Size(1000,800)); f.agent.showSection(AppSection.library);
    await tester.pumpWidget(RepaintBoundary(key:key,child:DreamFlutterApp(controller:f.agent))); await wait();
    for(final dark in [false,true]) {
      final theme=dark?'dark':'light'; await f.agent.setThemeMode(dark?ThemeMode.dark:ThemeMode.light); await f.agent.setZoom(1);
      f.agent.showSection(AppSection.library); await wait();
      await reveal('文献整理', -180); await tester.tap(listText('文献整理')); await shot('garden_$theme');
      await tester.tap(find.text('新建')); await shot('new_$theme'); await tester.sendKeyEvent(LogicalKeyboardKey.escape); await wait();
      await tester.tap(find.text('实验室资料库').first); await shot('service_$theme');
      await tester.tap(find.text('检查引用').first); await shot('pending_$theme');
      await f.agent.setZoom(1.5); await shot('pending_150_$theme');
      await tester.tap(find.byTooltip('返回技能列表')); await reveal('文献整理', -180); await shot('garden_150_$theme');
      await reveal('实验室资料库');
      await tester.tap(find.text('实验室资料库').first); await shot('service_150_$theme');
      await tester.tap(find.byTooltip('返回技能列表')); await f.agent.setZoom(1);
      final now=DateTime.now().millisecondsSinceEpoch;
      tasks.clear(); tasks.addAll([
        {'id':'plan','title':'整理本周的实验记录','status':'in_progress','progress':'已复述任务，等待开工','intent':{'id':'i','slot_id':worker.active!.slotId,'created_at':now-5000,'start_at':now+55000,'state':'waiting','restatement':'我会整理本周的实验记录','plan':'先看资料，再归纳结论。'}},
        {'id':'done','title':'整理组会纪要','status':'completed','progress':'已整理3次组会','sessionFile':'${f.root.path}/done.jsonl','delivery':{'summary':'已整理三次组会，列出十一项待办。','files':[],'cost':0.05,'durationMs':360000}},
      ]);
      await tester.runAsync(()=>f.agent.openButterfly()); f.backend.push({'event':'tasks.changed'}); await wait();
      if (find.byTooltip('蝶君首页').evaluate().isNotEmpty) { await tester.tap(find.byTooltip('蝶君首页')); await wait(); }
      await tester.tap(find.text('整理本周的实验记录').first); await wait();
      expect(tester.widget<Text>(find.text('我会整理本周的实验记录')).style?.fontFamily,isNot(AppTokens.handwritingFamily));
      expect(find.byKey(const ValueKey('butterfly-start-progress')),findsOneWidget); await shot('plan_$theme');
      await tester.tap(find.byTooltip('蝶君首页')); await wait(); await tester.tap(find.text('整理组会纪要').first); await wait();
      expect(tester.widget<Text>(find.text('交付')).style?.fontFamily,isNot(AppTokens.handwritingFamily)); await shot('delivery_$theme');
    }
  });
}
