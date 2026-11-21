import 'dart:io';

import 'package:dreamflutter/state/agent_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pi_rpc/pi_rpc.dart' show AssistantItem;

import 'support/t91_harness.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'memory follows the restart setting in the same DSH conversation',
    (tester) async {
      final root = Directory.systemTemp.createTempSync('df-window-v11-');
      String? path;
      String? itemId;
      const note = '试验项目蓝槭编号七三六';
      try {
        for (var launch = 0; launch < 3; launch++) {
          final h = (await tester.runAsync(
            () => T91Harness.start(persistentRoot: root.path),
          ))!;
          try {
            await h.mount(tester);
            final agent = h.agent;
            await h.wait(tester, () => agent.desktopPlugins.loaded);
            expect(agent.desktopPlugins.active('memory'), launch != 1);
            if (launch == 0) {
              final saved = await h.rpc('memory.save', {
                'content': '项目名：「$note」',
                'scope': 'global',
                'pinned': true,
              }) as Map;
              itemId = (saved['item'] as Map)['id'] as String;
            } else {
              await tester.runAsync(() => agent.openSession(path!));
            }
            if (launch == 2) {
              final item = await h.rpc('memory.item', {'id': itemId}) as Map;
              expect((item['item'] as Map)['content'], contains(note));
            }
            await h.rpc('test.reply');
            await tester.runAsync(() => agent.send('第${launch + 1}轮窗口验收'));
            await h.wait(
              tester,
              () =>
                  !agent.isRunning &&
                  agent.active?.sessionPath != null &&
                  agent.transcript.items.whereType<AssistantItem>().length >=
                      launch + 1,
            );
            path ??= agent.active!.sessionPath!;
            expect(agent.active!.sessionPath, path);
            final input =
                (await h.rpc('test.inspect') as Map)['context'] as String;
            expect(input.contains(note), launch != 1);
            if (launch > 0) expect(input, contains('第1轮窗口验收'));
            if (launch < 2) {
              agent.openSettings('插件');
              final row = find.byKey(const ValueKey('plugin-memory'));
              await h.tap(
                tester,
                find.descendant(
                  of: row,
                  matching: find.text(launch == 0 ? '停用' : '启用'),
                ),
              );
              expect(
                find.textContaining(launch == 0 ? '重启梦蝶后停用' : '重启梦蝶后启用'),
                findsOneWidget,
              );
            }
          } finally {
            await h.close(tester);
          }
        }
      } finally {
        if (root.existsSync()) root.deleteSync(recursive: true);
      }
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
  testWidgets(
    'install, use and remove the catalog plugins in the Windows workbench',
    (tester) async {
      final harness = (await tester.runAsync(T91Harness.start))!;
      addTearDown(() => harness.close(tester));
      await harness.mount(tester);
      final agent = harness.agent;
      Future<void> manage() async {
        agent.openSettings('插件');
        await harness.wait(
          tester,
          () =>
              find.byKey(const ValueKey('plugin-memory')).evaluate().isNotEmpty,
        );
      }

      Future<void> action(String id, String label) async {
        await harness.tap(
          tester,
          find.descendant(
            of: find.byKey(ValueKey('plugin-$id')),
            matching: find.text(label),
          ),
        );
      }

      Future<void> shortcut() async {
        await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
        await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
        await tester.sendKeyEvent(LogicalKeyboardKey.keyU);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
        await harness.settle(tester);
      }

      await manage();
      await action('usage-dashboard', '安装');
      await action('window-shortcuts', '安装');
      await action('memory', '停用');
      expect(find.textContaining('重启梦蝶后停用'), findsOneWidget);
      final memory = agent.desktopPlugins.entries.singleWhere(
        (plugin) => plugin.id == 'memory',
      );
      expect(memory.active, isTrue);
      expect(memory.enabled, isFalse);
      await harness.shot(tester, 'v11-installed-plugins');
      await action('memory', '启用');

      agent.showSection(AppSection.chat);
      await harness.settle(tester);
      await shortcut();
      expect(agent.section, AppSection.spending);
      await harness.wait(
        tester,
        () => find.text('近 7 天用量').evaluate().isNotEmpty,
      );
      await harness.shot(tester, 'v11-plugin-usage');

      await manage();
      await action('window-shortcuts', '卸载');
      await action('usage-dashboard', '卸载');
      agent.showSection(AppSection.chat);
      await harness.settle(tester);
      await shortcut();
      expect(agent.section, AppSection.chat);
      agent.showSection(AppSection.spending);
      await harness.settle(tester);
      expect(find.text('近 7 天用量'), findsNothing);
    },
  );
}
