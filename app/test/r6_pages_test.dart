import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/schedule_page.dart';
import 'package:dreamflutter/ui/setup_wizard.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 't87_fixture.dart';
import 't88_fixture.dart';

void main() {
  testWidgets('R6 wizard fits the last step and allows going back', (tester) async {
    final fixture = (await tester.runAsync(T88Fixture.create))!;
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(fixture.dispose);
      await tester.binding.setSurfaceSize(null);
    });
    await tester.binding.setSurfaceSize(const Size(760, 900));
    await tester.pumpWidget(DreamFlutterApp(controller: fixture.agent, home: SetupWizard(status: {'dataRoot': fixture.root.path}, initialStep: 3, onComplete: () {})));
    await tester.pumpAndSettle();
    expect(find.text('常用的项目文件夹'), findsOneWidget);
    expect(find.text('跳过'), findsOneWidget);
    expect(find.text('开始使用'), findsOneWidget);
    await tester.tap(find.text('上一步'));
    await tester.pumpAndSettle();
    expect(find.text('怎么称呼你'), findsOneWidget);
    expect(fixture.backend.callsTo('setup.complete'), isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets('R6 a failed calendar occurrence retries its own schedule through the existing API', (tester) async {
    final fixture = (await tester.runAsync(T87Fixture.create))!;
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(fixture.dispose);
    });
    final now = DateTime.now();
    final at = DateTime(now.year, now.month, now.day, 9).millisecondsSinceEpoch;
    fixture.backend.handlers['schedules.occurrences'] = (_) => {
      'items': [{'scheduleId': 'failed-report', 'at': at, 'status': 'failed', 'error': '网页打不开'}],
      'schedules': [{'id': 'failed-report', 'name': '交传感器对比', 'kind': 'task', 'createdBy': 'butterfly'}],
    };
    fixture.backend.handlers['patrol.status'] = (_) => {'enabled': true, 'running': false};
    fixture.backend.handlers['patrol.log'] = (_) => <dynamic>[];
    await tester.binding.setSurfaceSize(const Size(760, 900));
    await tester.pumpWidget(AgentScope(controller: fixture.agent, child: MaterialApp(theme: buildTheme(Brightness.light), home: const SchedulePage())));
    await tester.pumpAndSettle();
    expect(find.text('时令'), findsOneWidget);
    expect(find.text('网页打不开'), findsWidgets);
    await tester.tap(find.text('现在再做一次'));
    await tester.pumpAndSettle();
    expect(fixture.backend.callsTo('schedules.runNow').single, {'id': 'failed-report'});
    expect(tester.takeException(), isNull);
  });

  testWidgets('a selected weekday expands across the month and shows its appointment time', (tester) async {
    final fixture = (await tester.runAsync(T87Fixture.create))!;
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(fixture.dispose);
    });
    final now = DateTime.now();
    final at = DateTime(now.year, now.month, 14, 14).millisecondsSinceEpoch;
    fixture.backend.handlers['schedules.occurrences'] = (_) => {
      'items': [{'scheduleId': 'meeting', 'at': at, 'status': 'done'}],
      'schedules': [{'id': 'meeting', 'name': '导师见面', 'kind': 'reminder', 'createdBy': 'user'}],
    };
    fixture.backend.handlers['patrol.status'] = (_) => {'enabled': true, 'running': false};
    fixture.backend.handlers['patrol.log'] = (_) => <dynamic>[];
    await tester.binding.setSurfaceSize(const Size(1400, 1000));
    await tester.pumpWidget(AgentScope(controller: fixture.agent, child: MaterialApp(theme: buildTheme(Brightness.light), home: const SchedulePage())));
    await tester.pumpAndSettle();

    Finder day(int number) => find.byKey(ValueKey('schedule-day-$number'));
    await tester.tap(day(14));
    await tester.pumpAndSettle();
    expect(tester.getSize(day(14)).width, 200);
    expect(tester.getSize(day(7)).width, 200);
    expect(tester.getSize(day(15)).width, lessThan(200));
    expect(find.descendant(of: day(14), matching: find.text('14:00 导师见面')), findsOneWidget);
    expect(find.text('${now.month} 月 14 日'), findsOneWidget);
    expect(find.text('已提醒'), findsOneWidget);

    await tester.tap(day(15));
    await tester.pumpAndSettle();
    expect(tester.getSize(day(15)).width, 200);
    expect(tester.getSize(day(14)).width, lessThan(200));
    expect(find.text('${now.month} 月 15 日'), findsOneWidget);
    expect(find.text('已提醒'), findsNothing);
  });
}
