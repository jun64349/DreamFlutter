import 'dart:async';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/memory_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:dreamflutter/ui/memory_details.dart';
import 'package:flutter_test/flutter_test.dart';

import 't87_fixture.dart';

import 'package:dreamflutter/state/agent_controller.dart';

Future<void> pumpT87(WidgetTester tester) async {
  for (var i = 0; i < 5; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  late T87Fixture fixture;
  Future<void> start(WidgetTester tester) async {
    fixture = (await tester.runAsync(T87Fixture.create))!;
    await tester.binding.setSurfaceSize(const Size(1000, 800));
    await tester.pumpWidget(
      AgentScope(
        controller: fixture.agent,
        child: MaterialApp(
          theme: buildTheme(Brightness.light),
          home: const Scaffold(body: MemoryPage()),
        ),
      ),
    );
    await pumpT87(tester);
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(fixture.dispose);
    });
  }

  testWidgets(
    'T87 shows three groups and only the outdated marker, without the old control panels',
    (tester) async {
      await start(tester);
      for (final label in ['记下的事', '关于你', '关于这个项目', '蝶君自己的', '自动记忆', '可能过时了']) {
        expect(find.text(label), findsOneWidget);
      }
      for (final label in ['待确认', '常驻记忆块', '一级', '二级', '三级', '写入频率']) {
        expect(find.textContaining(label), findsNothing);
      }
    },
  );
  testWidgets(
    'T87 saves edited text when focus leaves and does not claim success on failure',
    (tester) async {
      await start(tester);
      final field = find.byKey(const ValueKey('memory-content-you'));
      await tester.enterText(field, '交流用中文，先说结论');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await pumpT87(tester);
      expect(fixture.items.first['content'], '交流用中文，先说结论');
      expect(fixture.backend.callsTo('memory.update').single['version'], 1);
      fixture.rejectEdit = true;
      await tester.enterText(field, '暂未保存的修改');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await pumpT87(tester);
      expect(fixture.items.first['content'], '交流用中文，先说结论');
      expect(find.textContaining('保存失败'), findsOneWidget);
    },
  );
  testWidgets('T87 deletion is recoverable through the snackbar', (
    tester,
  ) async {
    await start(tester);
    await tester.tap(find.byTooltip('删除记忆').first);
    await pumpT87(tester);
    expect(find.byKey(const ValueKey('memory-content-you')), findsNothing);
    await tester.tap(find.text('撤销'));
    await pumpT87(tester);
    expect(find.byKey(const ValueKey('memory-content-you')), findsOneWidget);
  });
  testWidgets('T87 edited deletion uses the latest version', (tester) async {
    await start(tester);
    await tester.enterText(
      find.byKey(const ValueKey('memory-content-you')),
      '先说结论',
    );
    await tester.tap(find.byTooltip('删除记忆').first);
    await pumpT87(tester);
    expect(fixture.backend.callsTo('memory.setStatus').single['version'], 2);
    expect(find.text('已删除'), findsOneWidget);
  });
  testWidgets(
    'T87 source names the conversation and opens it without sending a prompt',
    (tester) async {
      await start(tester);
      for (
        var i = 0;
        i < 30 && find.textContaining('来自').evaluate().isEmpty;
        i++
      ) {
        await pumpT87(tester);
      }
      expect(find.textContaining('来自'), findsOneWidget);
      await tester.tap(find.text('来自 讨论传感器项目的协作约定'));
      await pumpT87(tester);
      expect(fixture.agent.section, AppSection.chat);
      expect(
        fixture.agent.currentSessionPath,
        endsWith('project-source.jsonl'),
      );
      expect(fixture.backend.pis.expand((p) => p.sent('prompt')), isEmpty);
    },
  );
  testWidgets(
    'T87 add and cancel own the editor until the dialog finishes closing',
    (tester) async {
      await start(tester);
      await tester.tap(find.text('添加记忆'));
      await pumpT87(tester);
      await tester.tap(find.text('取消'));
      await pumpT87(tester);
      expect(tester.takeException(), isNull);
      await tester.tap(find.text('添加记忆'));
      await pumpT87(tester);
      await tester.enterText(find.byType(TextField).last, '每周五整理实验记录');
      await tester.tap(find.text('添加'));
      await pumpT87(tester);
      expect(fixture.backend.callsTo('memory.save'), hasLength(1));
      expect(find.text('每周五整理实验记录'), findsOneWidget);
    },
  );
  testWidgets(
    'T87 recent history and topic records call their owner undo APIs',
    (tester) async {
      await start(tester);
      await tester.tap(find.text('最近'));
      await pumpT87(tester);
      expect(find.text('记住了'), findsOneWidget);
      expect(find.textContaining('换了话题'), findsOneWidget);
      await tester.tap(find.text('撤销').first);
      await pumpT87(tester);
      expect(fixture.backend.callsTo('memory.undo'), hasLength(1));
      await tester.tap(find.text('撤销').last);
      await pumpT87(tester);
      expect(fixture.backend.callsTo('memory.undoBoundary'), hasLength(1));
    },
  );
  testWidgets('T87 leaving a memory detail by Escape saves, and a failed save keeps it open', (tester) async {
    await start(tester);
    unawaited(showMemoryDetails(tester.element(find.byType(MemoryPage)), 'you'));
    await pumpT87(tester);
    final input = find.descendant(of: find.byType(AlertDialog), matching: find.byType(TextField));
    fixture.rejectEdit = true;
    await tester.enterText(input, '保留这次修改');
    await tester.sendKeyEvent(LogicalKeyboardKey.escape); await pumpT87(tester);
    expect(find.byType(AlertDialog), findsOneWidget); expect(find.textContaining('保存失败'), findsOneWidget);
    fixture.rejectEdit = false;
    await tester.sendKeyEvent(LogicalKeyboardKey.escape); await pumpT87(tester);
    expect(find.byType(AlertDialog), findsNothing); expect(fixture.items.first['content'], '保留这次修改');
  });
}
