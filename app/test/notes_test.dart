// The one short-notice style (user 2026-11-17, docs/design/v1-redesign-spec.md 6.1).
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/notes.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget host({double width = 1200}) => MaterialApp(
      theme: buildTheme(Brightness.light),
      home: Stack(children: [
        Row(children: [const SizedBox(width: 264), Expanded(child: KeyedSubtree(key: noteAnchorKey, child: const SizedBox.expand()))]),
        const Positioned.fill(child: NoteLayer()),
      ]),
    );

void main() {
  tearDown(() => currentNote.value = null);

  testWidgets('a note sits at the top of the conversation column and leaves on its own', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1200, 800));
    await tester.pumpWidget(host());
    showNote('已保存');
    await tester.pumpAndSettle();
    final rect = tester.getRect(find.byKey(const ValueKey('note')));
    // Centred on the column right of the 264 sidebar, near the top, never over the composer.
    expect((rect.center.dx - (264 + (1200 - 264) / 2)).abs(), lessThan(1));
    expect(rect.top, lessThan(80));
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(find.text('已保存'), findsNothing);
  });

  testWidgets('brief notes leave sooner; a new note replaces the old one', (tester) async {
    await tester.pumpWidget(host());
    showNote('已复制', brief: true);
    await tester.pumpAndSettle();
    showNote('已复制代码', brief: true);
    await tester.pumpAndSettle();
    expect(find.text('已复制'), findsNothing);
    expect(find.text('已复制代码'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 1700));
    await tester.pumpAndSettle();
    expect(find.text('已复制代码'), findsNothing);
  });

  testWidgets('a failure stays until closed', (tester) async {
    await tester.pumpWidget(host());
    showFailure('保存失败：磁盘空间不足');
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 30));
    expect(find.text('保存失败：磁盘空间不足'), findsOneWidget);
    await tester.tap(find.byTooltip('关闭'));
    await tester.pumpAndSettle();
    expect(find.text('保存失败：磁盘空间不足'), findsNothing);
  });

  testWidgets('its one action runs and closes the note', (tester) async {
    await tester.pumpWidget(host());
    var undone = 0;
    showNote('已删除', action: '撤销', onAction: () => undone++);
    await tester.pumpAndSettle();
    await tester.tap(find.text('撤销'));
    await tester.pumpAndSettle();
    expect(undone, 1);
    expect(find.text('已删除'), findsNothing);
  });

  testWidgets('the width follows the words: a short sentence is one line', (tester) async {
    await tester.pumpWidget(host());
    showNote('蝶君 · 定时任务完成：本周实验周报', kind: NoteKind.info, action: '查看', onAction: () {});
    await tester.pumpAndSettle();
    final line = tester.getSize(find.text('蝶君 · 定时任务完成：本周实验周报')).height;
    expect(line, lessThan(30), reason: 'the 0.12 top card wrapped its last character onto a second line');
    expect(tester.getSize(find.byKey(const ValueKey('note'))).width, lessThanOrEqualTo(520));
  });

  test('controller messages are failures only by their words', () {
    expect(noteKindOf('操作失败：连接断开'), NoteKind.fail);
    expect(noteKindOf('蝶君交付了：周报.docx'), NoteKind.info);
  });
}
