import 'dart:io';
import 'dart:ui' as ui;
import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/ui/settings_page.dart';
import 'package:dreamflutter/ui/setup_wizard.dart';
import 'package:dreamflutter/ui/window_frame.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import '../test/t88_fixture.dart';

void main(){
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('T88 review fixes use the actual shell in both themes and zooms',(t)async{
    final f=(await t.runAsync(T88Fixture.create))!;
    final shots=Directory(p.join(Directory.current.path,'build','t88_review_shots'))..createSync(recursive:true);final key=GlobalKey();
    addTearDown(()async{await t.pumpWidget(const SizedBox());await t.runAsync(f.dispose);});
    Future<void> wait()async{for(var i=0;i<4;i++){await t.runAsync(()=>Future<void>.delayed(const Duration(milliseconds:35)));await t.pump(const Duration(milliseconds:120));}expect(t.takeException(),isNull);}
    Future<void> render({Widget? home})async{await t.pumpWidget(RepaintBoundary(key:key,child:DreamFlutterApp(controller:f.agent,home:home)));await wait();}
    Future<void> shot(String name)async{await wait();await t.runAsync(()async{final boundary=key.currentContext!.findRenderObject()! as RenderRepaintBoundary;final image=await boundary.toImage(pixelRatio:1);final bytes=await image.toByteData(format:ui.ImageByteFormat.png);File(p.join(shots.path,'$name.png')).writeAsBytesSync(bytes!.buffer.asUint8List());image.dispose();});}
    Future<void> navigate(String name)async{if(find.byTooltip('打开侧栏').evaluate().isNotEmpty){await t.tap(find.byTooltip('打开侧栏'));await wait();}await t.tap(find.text(name).last);await wait();}
    Future<void> group(String name)async{
      final dropdown=find.descendant(of:find.byType(SettingsPage),matching:find.byType(DropdownButtonFormField<String>));
      if(dropdown.evaluate().isNotEmpty){await t.tap(dropdown.first);await wait();await t.tap(find.text(name).last);}else{await t.tap(find.widgetWithText(ListTile,name));}await wait();
    }
    for(final dark in [false,true]){
      final theme=dark?'dark':'light';await f.agent.setThemeMode(dark?ThemeMode.dark:ThemeMode.light);
      for(final zoom in [1.0,1.5]){
        final size=zoom==1?'100':'150';await t.binding.setSurfaceSize(const Size(1000,800));await f.agent.setZoom(zoom);
        f.agent.showSection(AppSection.tasks);await render();await shot('attention_${size}_$theme');
        await navigate('设置');expect(find.descendant(of:find.byType(AppTitleBar),matching:find.text('设置')),findsOneWidget);await group('通用');await shot('settings_${size}_$theme');
        await group('模型');await shot('models_${size}_$theme');
        if(zoom==1){await t.binding.setSurfaceSize(const Size(1280,800));await shot('groups_$theme');await t.binding.setSurfaceSize(const Size(1000,800));await wait();}
        await navigate('花费');await shot('spending_${size}_$theme');
        await t.ensureVisible(find.text('账目'));await wait();await shot('ledger_${size}_$theme');
        await render(home:SetupWizard(key:ValueKey('wizard-$theme-$size'),status:{'dataRoot':f.root.path},initialStep:2,onComplete:(){}));
        expect(find.descendant(of:find.byType(AppTitleBar),matching:find.text('花费')),findsNothing);
        await t.enterText(find.widgetWithText(TextField,'称呼'),'小周');await t.tap(find.text('下一步'));await wait();await t.enterText(find.widgetWithText(TextField,'密钥'),'test-only-not-a-key');await t.tap(find.text('测试连接'));await wait();expect(find.text('DeepSeek-V4.1-Flash'),findsNWidgets(3));await shot('wizard_models_${size}_$theme');
      }
    }
  });
}
