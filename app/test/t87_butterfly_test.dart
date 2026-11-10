import 'dart:io';

import 'package:dreamflutter/state/butterfly_tasks.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/butterfly_tasks_view.dart';
import 'package:dreamflutter/ui/zoom.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';

import 't87_fixture.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late T87Fixture fixture;
  late ButterflyTasks model;
  setUp(() async {
    fixture = await T87Fixture.create();
    model = ButterflyTasks(fixture.agent);
    await model.load();
  });
  tearDown(() async {
    model.dispose();
    await fixture.dispose();
  });

  test('T87 new butterfly messages prepare a task; normal chat still sends directly', () async {
    await fixture.agent.send('工作台里的问题');
    expect(fixture.backend.pis.first.sent('prompt'), hasLength(1));
    await model.worker!.send('整理实验记录');
    expect(fixture.backend.callsTo('butterfly.prepare').single, {
      'slotId': model.worker!.active!.slotId,
      'goal': '整理实验记录',
    });
    expect(fixture.backend.pis.last.sent('prompt'), isEmpty);
    expect(model.selected?['id'], 'prepared');
    expect(model.selected?['intent']['restatement'], isNotEmpty);
    expect(
      fixture.backend.callsTo('butterfly.start'),
      isEmpty,
      reason: 'the core owns the configurable countdown',
    );
    await model.start(
      (model.selected!['intent'] as Map).cast<String, dynamic>(),
    );
    expect(fixture.backend.callsTo('butterfly.start').single['id'], 'intent');
  });
  test(
    'T87 a new chat preserves the slot of a plan that has not started',
    () async {
      await model.worker!.send('整理实验记录');
      final old = model.worker!.active!.slotId;
      final oldPi = fixture.backend.pis.last;
      await model.worker!.newSession();
      expect(model.worker!.active!.slotId, isNot(old));
      expect(oldPi.sent('new_session'), isEmpty);
      await model.open(model.tasks.firstWhere((t) => t['id'] == 'prepared'));
      expect(model.worker!.active!.slotId, old);
      expect(model.selectedId, 'prepared');
    },
  );
  test(
    'T87 missing information answers the saved intent without a direct prompt',
    () async {
      await model.submit('查传感器', []);
      final intent = (fixture.tasks.first['intent'] as Map)
          .cast<String, dynamic>();
      intent['state'] = 'needs_input';
      intent['missing'] = '预算多少？';
      intent['start_at'] = null;
      fixture.backend.handlers['butterfly.answer'] = (p) {
        expect(p, {'id': 'intent', 'answer': '预算 300 元'});
        return intent;
      };
      await model.load();
      await model.worker!.send('预算 300 元');
      expect(fixture.backend.callsTo('butterfly.answer'), hasLength(1));
      expect(fixture.backend.pis.last.sent('prompt'), isEmpty);
    },
  );
  test('T87 continuing a saved task uses its own conversation', () async {
    final task = model.tasks.firstWhere((t) => t['id'] == 'complete');
    await model.open(task);
    await model.worker!.send('再补上负责人');
    expect(model.worker!.currentSessionPath, task['sessionFile']);
    expect(fixture.backend.pis.last.sent('prompt').single, contains('再补上负责人'));
    expect(fixture.backend.callsTo('butterfly.prepare'), isEmpty);
    expect(fixture.backend.pis.first.sent('prompt'), isEmpty);
  });
  test('T87 imported images exist during transfer and temporary copies are removed', () async {
    late List<String> local;
    fixture.backend.handlers['butterfly.import'] = (p) {
      local = (p['paths'] as List).cast<String>();
      expect(File(local.single).readAsBytesSync(), [1, 2, 3]);
      return {
        'paths': ['/workspace/inbox/image.png'],
      };
    };
    await model.submit('看这张图', [
      const ImageBlock(data: 'AQID', mimeType: 'image/png'),
    ]);
    expect(
      fixture.backend.callsTo('butterfly.prepare').single['goal'],
      contains('/workspace/inbox/image.png'),
    );
    expect(Directory(File(local.single).parent.path).existsSync(), isFalse);
  });
  test(
    'T87 failed transfers clean temporary files and do not create a task',
    () async {
      late String local;
      fixture.backend.handlers['butterfly.import'] = (p) {
        local = (p['paths'] as List).single as String;
        throw CoreException('offline', '连接中断');
      };
      await expectLater(
        model.submit('看图', [
          const ImageBlock(data: 'AQID', mimeType: 'image/png'),
        ]),
        throwsA(isA<CoreException>()),
      );
      expect(File(local).parent.existsSync(), isFalse);
      expect(fixture.backend.callsTo('butterfly.prepare'), isEmpty);
      expect(model.preparing, isFalse);
    },
  );
  test(
    'T87 schedule controls keep the backend as the source of truth',
    () async {
      await model.changeSchedule('weekly', 'paused');
      expect(model.schedules.single['status'], 'paused');
      await model.changeSchedule('weekly', 'active');
      expect(model.schedules.single['status'], 'active');
      await model.changeSchedule('weekly', null);
      expect(model.schedules, isEmpty);
    },
  );
  test('T87 status labels have exactly four user-facing states', () {
    expect(model.tasks.map(butterflyTaskLabel), ['进行中', '等你', '已完成', '没做成']);
  });
  for (final brightness in Brightness.values) {
    testWidgets('T87 irreversible schedule deletion requires confirmation at 150 percent in $brightness', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1000, 800));
      await tester.pumpWidget(MaterialApp(theme: buildTheme(brightness), builder: (context, child) => AppZoom(controller: fixture.agent, zoom: 1.5, textScale: 1, child: child!), home: Scaffold(body: ButterflySchedule(schedule: model.schedules.single, tasks: model))));
      await tester.tap(find.text('删除')); await tester.pumpAndSettle();
      expect(find.text('删除后不能撤销。'), findsOneWidget);
      expect(fixture.backend.callsTo('schedules.remove'), isEmpty);
      await tester.tap(find.text('取消')); await tester.pumpAndSettle();
      expect(fixture.backend.callsTo('schedules.remove'), isEmpty);
      await tester.tap(find.text('删除')); await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, '删除')); await tester.pumpAndSettle();
      expect(fixture.backend.callsTo('schedules.remove'), hasLength(1));
      await tester.pumpWidget(const SizedBox());
    });
  }
}
