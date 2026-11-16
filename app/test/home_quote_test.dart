import 'dart:math';

import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/home_quote.dart';
import 'package:dreamflutter/ui/shell_widgets.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('the 12 paintings select their cultural pool and all 48 entries are concise', () {
    final chinese = {'warmPaper', 'twilight', 'jiadie', 'moye', 'shiqing'};
    final foreign = {
      'caodie',
      'yuhua',
      'shensi',
      'qiandie',
      'youhua',
      'liuguang',
      'huandie',
    };
    expect(
      PaintingTheme.all.map((theme) => theme.id).toSet(),
      chinese.union(foreign),
    );
    for (final theme in PaintingTheme.all) {
      expect(homeQuoteIsForeign(theme.id), foreign.contains(theme.id));
    }
    expect(chineseHomeQuotes.length, 24);
    expect(foreignHomeQuotes.length, 24);
    expect(chineseHomeQuotes.map((q) => q.original).toSet().length, 24);
    expect(foreignHomeQuotes.map((q) => q.original).toSet().length, 24);
    for (final quote in chineseHomeQuotes) {
      expect(quote.original.runes.length, lessThanOrEqualTo(28));
      expect(quote.translation, isNull);
      expect(quote.source, startsWith('《庄子·'));
      expect(quote.sourceUrl, startsWith('https://'));
    }
    for (final quote in foreignHomeQuotes) {
      expect(
        quote.original.split(RegExp(r'\s+')).length,
        lessThanOrEqualTo(20),
      );
      expect(quote.translation, isNotEmpty);
      expect(quote.source, isNotEmpty);
      expect(quote.sourceUrl, startsWith('https://'));
    }
  });

  test('shuffle bags avoid repeats until exhausted and session bindings stay stable', () {
    final picker = HomeQuotePicker(random: Random(7));
    final token = Object();
    final first = picker.pick(sessionToken: token, foreign: false);
    expect(picker.pick(sessionToken: token, foreign: false), same(first));
    expect(
      picker.pick(
        sessionToken: token,
        sessionPath: 'session-a',
        foreign: false,
      ),
      same(first),
    );
    expect(
      picker.pick(
        sessionToken: Object(),
        sessionPath: 'session-a',
        foreign: false,
      ),
      same(first),
    );
    final otherCulture = picker.pick(
      sessionToken: token,
      sessionPath: 'session-a',
      foreign: true,
    );
    expect(otherCulture.isForeign, isTrue);
    expect(
      picker.pick(
        sessionToken: token,
        sessionPath: 'session-a',
        foreign: false,
      ),
      same(first),
    );

    final all = <HomeQuoteContent>[first];
    for (var i = 1; i < 24; i++) {
      all.add(picker.pick(sessionToken: Object(), foreign: false));
    }
    expect(all.toSet().length, 24);
    final next = picker.pick(sessionToken: Object(), foreign: false);
    expect(next, isNot(same(all.last)));
    final replacement = picker.pick(
      sessionToken: token,
      sessionPath: 'session-b',
      foreign: false,
    );
    expect(
      picker.pick(
        sessionToken: token,
        sessionPath: 'session-b',
        foreign: false,
      ),
      same(replacement),
    );
    expect(
      picker.pick(
        sessionToken: Object(),
        sessionPath: 'session-a',
        foreign: false,
      ),
      same(first),
    );

    final englishPicker = HomeQuotePicker(random: Random(17));
    final english = <HomeQuoteContent>[
      for (var i = 0; i < 24; i++)
        englishPicker.pick(sessionToken: Object(), foreign: true),
    ];
    expect(english.toSet().length, 24);
    expect(
      englishPicker.pick(sessionToken: Object(), foreign: true),
      isNot(same(english.last)),
    );
  });

  test('a fresh session on a reused runtime draws a new quote; returning restores the old one', () {
    final picker = HomeQuotePicker(random: Random(31));
    final runtime = Object();
    final first = picker.pick(
      sessionToken: runtime,
      sessionPath: 'a',
      foreign: false,
    );
    final second = picker.pick(
      sessionToken: runtime,
      sessionPath: 'b',
      foreign: false,
    );
    expect(second, isNot(same(first)));
    expect(
      picker.pick(sessionToken: runtime, sessionPath: 'a', foreign: false),
      same(first),
    );
    final unsaved = picker.pick(sessionToken: runtime, foreign: false);
    expect(unsaved, isNot(same(first)));
    expect(picker.pick(sessionToken: runtime, foreign: false), same(unsaved));
    expect(
      picker.pick(sessionToken: runtime, sessionPath: 'a', foreign: false),
      same(first),
    );
    final firstUnsaved = picker.pick(
      sessionToken: runtime, sessionId: 'unsaved-1', foreign: false,
    );
    final nextUnsaved = picker.pick(
      sessionToken: runtime, sessionId: 'unsaved-2', foreign: false,
    );
    expect(nextUnsaved, isNot(same(firstUnsaved)));
    expect(
      picker.pick(sessionToken: runtime, sessionId: 'unsaved-2', foreign: false),
      same(nextUnsaved),
    );
  });

  testWidgets(
    'foreign quote keeps English italic and translation before attribution',
    (tester) async {
      final token = Object();
      await tester.pumpWidget(
        MaterialApp(
          theme: buildTheme(Brightness.light, painting: PaintingTheme.caodie),
          home: Scaffold(
            body: Center(child: HomeQuote(sessionToken: token)),
          ),
        ),
      );
      final quote = tester.widget<ShellQuoteLine>(find.byType(ShellQuoteLine));
      final original = find.text(quote.line);
      final translation = find.text(quote.translation!);
      final source = find.text(quote.source);
      expect(tester.widget<Text>(original).style?.fontStyle, FontStyle.italic);
      expect(
        tester.widget<Text>(translation).style?.fontFamily,
        AppTokens.kaiFamily,
      );
      expect(
        tester.getTopLeft(translation).dy,
        greaterThan(tester.getBottomLeft(original).dy),
      );
      expect(
        tester.getTopLeft(source).dy,
        greaterThan(tester.getBottomLeft(translation).dy),
      );
      expect(
        tester.getSize(find.byType(ShellQuoteLine)).height,
        greaterThanOrEqualTo(100),
      );
      await tester.pump();
      expect(
        tester.widget<ShellQuoteLine>(find.byType(ShellQuoteLine)).line,
        quote.line,
      );
    },
  );
}
