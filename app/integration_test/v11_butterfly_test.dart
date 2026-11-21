import 'dart:io';

import 'package:dreamflutter/ui/artifact_widgets.dart';
import 'package:dreamflutter/ui/butterfly_tasks_view.dart';
import 'package:dreamflutter/ui/sidebar.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'support/t91_harness.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  const packageRoot = String.fromEnvironment('DREAMFLUTTER_NATIVE_PACKAGE');
  testWidgets(
    'the Windows window assigns and previews real native Butterfly deliveries',
    (tester) async {
      final h = (await tester.runAsync(
        () => T91Harness.start(nativePackage: packageRoot),
      ))!;
      addTearDown(() => h.close(tester));
      await h.mount(tester);
      final status = await h.rpc('sandbox.status') as Map;
      expect(status['kind'], 'appcontainer');
      expect(status['online'], false);
      Finder sidebar(String label) => find
          .descendant(of: find.byType(Sidebar), matching: find.text(label))
          .first;
      await h.tap(tester, sidebar('蝶君'));
      await h.wait(tester, () => h.agent.butterfly?.isReady == true);

      for (final (index, scenario) in [
        (
          kind: 'research',
          prompt: '请先汇总两份合成样本 17 和 25，再用 Python 算均值，最后交付 window-queue.md。',
          file: 'window-queue.md',
          text: '均值为 21.0',
        ),
        (
          kind: 'compatibility',
          prompt: '请先核对随包 Node 版本，再用实际运行结果验证环境，最后交付 window-compat.md。',
          file: 'window-compat.md',
          text: '实际随包 Node v24',
        ),
      ].indexed) {
        final previous = h.agent.butterfly?.currentSessionPath;
        if (index > 0) {
          await h.tap(tester, sidebar('新对话'));
          await h.wait(
            tester,
            () =>
                h.agent.butterfly?.isReady == true &&
                find.byType(ButterflyTasksHome).evaluate().isNotEmpty,
          );
        }
        await h.rpc('test.job', {'kind': scenario.kind});
        await h.send(tester, scenario.prompt, finish: false);
        final detail = find.byTooltip('详情：任务进度');
        if (detail.evaluate().isNotEmpty) await h.tap(tester, detail);
        final row = find.widgetWithText(ButterflyDeliveryFile, scenario.file);
        await h.wait(tester, () => row.evaluate().isNotEmpty, seconds: 65);
        if (index > 0) {
          expect(h.agent.butterfly?.currentSessionPath, isNot(previous));
        }
        expect(find.text('交付'), findsWidgets);
        await h.tap(
          tester,
          find.descendant(of: row, matching: find.byTooltip('更多')),
        );
        await h.tap(tester, find.text('预览'));
        await h.wait(
          tester,
          () => find
              .textContaining(scenario.text, findRichText: true)
              .evaluate()
              .isNotEmpty,
        );
        final preview = tester.widget<FilePreviewBody>(
          find.byType(FilePreviewBody),
        );
        expect(
          await tester.runAsync(() => File(preview.path).readAsString()),
          contains(scenario.text),
        );
        final inspect = await h.rpc('test.inspect') as Map;
        expect((inspect['artifactRequests'] as List).last, scenario.file);
        await h.shot(tester, '${scenario.kind}-delivery-preview');
        await h.tap(tester, find.widgetWithText(FilledButton, '关闭'));
      }
    },
    timeout: const Timeout(Duration(minutes: 5)),
    skip: !Platform.isWindows || packageRoot.isEmpty,
  );
}
