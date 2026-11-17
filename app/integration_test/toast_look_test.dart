// What the short notices look like (one note style since 2026-11-17, spec 6.1) (user 2026-11-17: 「已发送、已更新、已保存这样的提示现在的效果是怎样的」).
// Production window + T91 Core + scripted Faux; no paid model. Shots in app/build/toast_shots/.
//   flutter test integration_test/toast_look_test.dart -d windows --dart-define=T91_SHOTS=toast_shots
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'support/t91_harness.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('notes: a button confirmation, a core message and a failure',(tester) async {
    final h=(await tester.runAsync(T91Harness.start))!;
    addTearDown(()=>h.close(tester));
    await h.mount(tester);
    await h.script([{'text':'三组实验结果一致，第二组建议复测。'}]);
    await h.send(tester,'帮我看看实验结果。');
    // One mouse stays over the reply for both themes (adding a second pointer asserts).
    await h.hoverAnswer(tester);
    // 「已复制」 lasts one second: capture mid-way, without the harness's settle.
    Future<void> grab(String name) async {
      for(var i=0;i<6;i++){await tester.pump(const Duration(milliseconds:60));}
      await tester.runAsync(() async {final b=h.capture.currentContext!.findRenderObject()! as RenderRepaintBoundary;final img=await b.toImage(pixelRatio:1);final bytes=await img.toByteData(format:ui.ImageByteFormat.png);File(p.join(h.shots.path,'$name.png')).writeAsBytesSync(bytes!.buffer.asUint8List());img.dispose();});
    }
    Future<void> gone() async {for(var i=0;i<80&&find.byKey(const ValueKey('note')).evaluate().isNotEmpty;i++){await h.tick(tester,100);}}
    for(final mode in [ThemeMode.light,ThemeMode.dark]){
      final tag=mode==ThemeMode.light?'light':'dark';
      await h.agent.setThemeMode(mode);await h.settle(tester);
      await tester.tap(find.byTooltip('复制').first);await tester.pump();
      expect(find.byKey(const ValueKey('note')),findsOneWidget);
      await grab('copied_$tag');
      await gone();
      await h.rpc('test.broadcast',{'message':{'event':'schedules.delivered','title':'蝶君 · 定时任务完成：本周实验周报','body':'','runId':'r1'}});
      await tester.pump();
      expect(find.byKey(const ValueKey('note')),findsOneWidget);
      await grab('delivered_$tag');
      await gone();
      // A failure from the core: stays until closed.
      await h.rpc('test.broadcast',{'message':{'event':'schedules.delivered','title':'蝶君 · 定时任务失败：需要的工具没有放行：write','body':'','runId':'r2'}});
      await tester.pump();
      await grab('failed_$tag');
      await tester.tap(find.byTooltip('关闭').last);await h.settle(tester);
    }
    // A narrow window: still at the top of the conversation column.
    await h.agent.setThemeMode(ThemeMode.light);
    await tester.binding.setSurfaceSize(const Size(760,900));await h.settle(tester);
    await h.rpc('test.broadcast',{'message':{'event':'schedules.delivered','title':'蝶君 · 定时任务完成：本周实验周报','body':'','runId':'r3'}});
    await tester.pump();
    await grab('delivered_light_760');
    await gone();
  });
}
