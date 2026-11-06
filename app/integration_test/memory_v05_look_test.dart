// Step 8 visual evidence using native Windows fonts and synthetic data.
// flutter test integration_test/memory_v05_look_test.dart -d windows --no-pub
import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:dreamflutter/ui/chat_view.dart';
import 'package:dreamflutter/ui/context_dialog.dart';
import 'package:dreamflutter/ui/memory_page.dart';
import 'package:dreamflutter/ui/memory_details.dart';
import 'package:dreamflutter/ui/session_dialogs.dart';
import 'package:dreamflutter/ui/settings_page.dart';
import 'package:dreamflutter/ui/side_chat_view.dart';
import 'package:dreamflutter/ui/keys.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import '../test/v05_harness.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  HeldKeys.askWindows = false;
  for (final brightness in [Brightness.light, Brightness.dark]) {
    testWidgets('step 8 ${brightness.name} screenshots', (tester) async {
      final h=await startV05(tester);
      await tester.binding.setSurfaceSize(const Size(1200,1000));
      final shots=Directory('build/t10_shots')..createSync(recursive:true);
      Future<void> page(Widget child) async {
        await tester.pumpWidget(const SizedBox());
        await h.mount(tester,child,brightness:brightness);
      }
      Future<void> shot(String name) async {
        await settleV05(tester);
        expect(tester.takeException(),isNull);
        await tester.runAsync(() async {
          final boundary=h.capture.currentContext!.findRenderObject()! as RenderRepaintBoundary;
          final image=await boundary.toImage(pixelRatio:1);
          final png=await image.toByteData(format:ui.ImageByteFormat.png);
          File('${shots.path}/${brightness.name}-$name.png').writeAsBytesSync(png!.buffer.asUint8List());
          image.dispose();
        });
      }
      h.agent.openMemory(tab:'memory');
      await page(const MemoryPage());
      await shot('01-memory');
      h.agent.openMemory(tab:'pending');await settleV05(tester);
      await shot('02-pending');
      h.agent.openMemory(tab:'log');await settleV05(tester);
      await tester.tap(find.byType(ExpansionTile).first);
      await shot('03-log');
      if (const bool.fromEnvironment('T10_LOG_ONLY')) return;
      await tester.tap(find.text('撤销整批').first);
      await shot('04-partial');
      h.navigator.currentState!.pop();await settleV05(tester);
      unawaited(showMemoryDetails(tester.element(find.byType(MemoryPage)),'m1'));
      await shot('05-details');
      await tester.tap(find.text('更多 ▾'));await settleV05(tester);
      await tester.tap(find.text('彻底删除').last);
      await shot('06-purge-warning');
      await tester.tap(find.widgetWithText(FilledButton,'彻底删除'));
      await shot('07-purge-result');
      h.navigator.currentState!.pop();await settleV05(tester);
      h.fixture.purged=false;

      h.backend.push(h.fixture.claim());
      h.backend.push({'event':'memory.task','sessionId':'parent-session','kind':'guessed','taskId':'task-guessed'});
      for(final kind in ['capacity_full','expired_protected','blocked','summary_revived']) {
        h.backend.push({'event':'memory.warning','kind':kind,'sessionId':'parent-session','itemIds':['m1'],'tokens':40100,'capacity':40000});
      }
      await h.agent.setRunPanelOpen(true);
      await page(const ChatView());
      await shot('08-chat');
      await tester.tap(find.text('保存').first);
      await shot('09-save');
      h.navigator.currentState!.pop();await settleV05(tester);
      await page(const SettingsPage(category:'记忆'));
      await tester.tap(find.text('高级'));await settleV05(tester);
      await shot('10-settings-memory');
      await page(const SettingsPage(category:'对话'));
      await tester.ensureVisible(find.text('后台压缩模型').first);
      await shot('11-settings-agent');
      await page(const ChatView());
      unawaited(showContextDialog(tester.element(find.byType(ChatView))));
      await shot('12-context');
      h.navigator.currentState!.pop();await settleV05(tester);
      final rows=(await h.backend.call('sessions.children') as List).cast<Map>().map((e)=>e.cast<String,dynamic>()).toList();
      unawaited(showRelatedConversations(tester.element(find.byType(ChatView)),rows));
      await shot('13-related');
      await tester.tap(find.text('验证细节'));await settleV05(tester);
      await shot('14-side');
      h.agent.closeSideChat();
      await tester.runAsync(h.agent.newTemporarySession);
      await tester.runAsync(()=>h.agent.openSideChat('无痕会话里的临时问题'));
      await page(SideChatView(side:h.agent.sideChat!));
      await shot('15-private-side');
      await tester.binding.setSurfaceSize(const Size(1000,800));
      await tester.pumpWidget(const SizedBox());
      await h.mount(tester,const SettingsPage(category:'对话'),brightness:brightness,zoom:1.5);
      await tester.ensureVisible(find.text('Agent 提问时等多久'));
      await shot('16-settings-narrow');
    });
  }
}
