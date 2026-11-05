import 'package:dreamflutter/ui/greetings.dart';
import 'package:flutter_test/flutter_test.dart';

/// 0.4 (v0.3.1 test 5): one greeting on a new conversation, many to pick from.
void main() {
  test('every hour of the day has lines of its own', () {
    for (var hour = 0; hour < 24; hour++) {
      expect(greetingsFor(DateTime(2026, 11, 5, hour)), isNotEmpty, reason: '$hour 点');
    }
    expect(greetingsFor(DateTime(2026, 11, 5, 7)), isNot(greetingsFor(DateTime(2026, 11, 5, 23))));
  });

  test('the same seed gives the same line; seeds reach the hour\'s lines and the any-time ones', () {
    final now = DateTime(2026, 11, 5, 15);
    expect(pickGreeting(now: now, seed: 41), pickGreeting(now: now, seed: 41));
    final seen = {for (var seed = 0; seed < 40; seed++) pickGreeting(now: now, seed: seed)};
    expect(seen.length, greaterThan(8), reason: 'many lines, picked at random');
    expect(seen.intersection(greetingsFor(now).toSet()), isNotEmpty);
    expect(seen, contains('今天想做点什么？'));
  });

  test('蝶君 has its own lines', () {
    final now = DateTime(2026, 11, 5, 15);
    final lines = {for (var seed = 0; seed < 12; seed++) pickGreeting(now: now, seed: seed, butterfly: true)};
    expect(lines.any((l) => l.contains('蝶君')), isTrue);
    expect(lines.intersection(greetingsFor(now).toSet()), isEmpty);
  });

  test('no line is too long for one line at the greeting\'s size', () {
    for (final line in allGreetings) {
      expect(line.length, lessThanOrEqualTo(16), reason: line);
    }
  });
}
