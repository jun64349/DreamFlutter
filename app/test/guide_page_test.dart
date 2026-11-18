import 'dart:io';

import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/guide_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 't87_fixture.dart';

/// Route step 4 (user 2026-11-18): the ten-lesson beginner's guide, shipped in app/assets/guide.
void main() {
  test('every lesson ships, and every link in it leads somewhere real', () {
    const settingsGroups = {'通用', '蝶君', '记忆', '模型', '工作台', '外观', '窗口与通知', '数据与安全', '归档与回收', '关于与更新'};
    final files = {for (final l in guideLessons) l.file};
    for (final lesson in guideLessons) {
      final text = File(lesson.asset).readAsStringSync();
      expect(text, startsWith('# 第 '), reason: lesson.file);
      for (final m in RegExp(r'\]\(([^)]+)\)').allMatches(text)) {
        final href = m.group(1)!;
        if (href.startsWith('go:')) {
          final parts = href.substring(3).split('/');
          if (parts[0] == 'settings') {
            expect(settingsGroups, contains(parts[1]), reason: '${lesson.file}: $href');
          } else {
            expect(parts[0], 'section', reason: '${lesson.file}: $href');
            expect(AppSection.values.map((s) => s.name), contains(parts[1]), reason: '${lesson.file}: $href');
          }
        } else if (href.endsWith('.md')) {
          expect(files.contains(href) || href == 'README.md', isTrue, reason: '${lesson.file}: $href');
        } else if (!href.startsWith('http')) {
          expect(href, startsWith('images/'), reason: '${lesson.file}: $href');
        }
      }
    }
  });

  testWidgets('the guide opens on a lesson, switches lessons and shows its pictures, with placeholders for missing ones', (t) async {
    final f = (await t.runAsync(T87Fixture.create))!;
    addTearDown(() async { await t.pumpWidget(const SizedBox()); await t.runAsync(f.dispose); });
    await t.binding.setSurfaceSize(const Size(1200, 900));
    addTearDown(() => t.binding.setSurfaceSize(null));
    await t.pumpWidget(AgentScope(controller: f.agent, child: MaterialApp(theme: buildTheme(Brightness.light), home: const GuidePage(initial: 2))));
    await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
    await t.pumpAndSettle();
    expect(find.textContaining('第 3 课　第一次对话'), findsOneWidget);
    expect(find.byType(Image), findsWidgets, reason: 'lesson 3 has its screenshots');
    expect(find.textContaining('截图待补'), findsNothing);
    // Lesson 2: the DeepSeek website pictures are still to be taken (images/截图清单.md).
    await t.tap(find.text('2  接上一个模型'));
    await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
    await t.pumpAndSettle();
    expect(find.textContaining('截图待补'), findsWidgets);
    await t.tap(find.text('5  认识蝶君'));
    await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
    await t.pumpAndSettle();
    expect(find.textContaining('第 5 课　认识蝶君'), findsOneWidget);
    expect(t.takeException(), isNull);
  });

  testWidgets('a go: link opens that place in the app', (t) async {
    final f = (await t.runAsync(T87Fixture.create))!;
    addTearDown(() async { await t.pumpWidget(const SizedBox()); await t.runAsync(f.dispose); });
    expect(openGuideTarget(f.agent, 'section/memory'), isTrue);
    expect(f.agent.section, AppSection.memory);
    expect(openGuideTarget(f.agent, 'settings/模型'), isTrue);
    expect(f.agent.section, AppSection.settings);
    expect(f.agent.settingsTarget.value, '模型');
    expect(openGuideTarget(f.agent, 'section/nowhere'), isFalse);
  });
}
