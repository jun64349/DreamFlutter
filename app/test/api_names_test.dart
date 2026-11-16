import 'dart:io';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('all literal RPC and subscribed event names are documented, with no retired APIs', () {
    final docs = Directory('../docs/api').listSync().whereType<File>().where((f) => f.path.endsWith('.md'));
    final names = <String>{};
    for (final file in docs) {
      names.addAll(RegExp(r'^#{2,3} ([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+)+)\s*$', multiLine: true)
          .allMatches(file.readAsStringSync()).map((m) => m[1]!));
    }
    expect(names, containsAll(['goals.get', 'goals.changed', 'jobs.changed']));
    final domains = names.map((n) => n.split('.').first).toSet();
    final retired = RegExp(r'''['"](?:butterfly\.(?:prepare|start|answer|cancel|tasks)|memory\.list|providers\.[a-zA-Z]+|notes\.save)['"]''');
    final literal = RegExp(r'''['"]([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+)+)['"]''');
    final failures = <String>[];
    for (final file in Directory('lib').listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart'))) {
      final source = file.readAsStringSync();
      for (final match in retired.allMatches(source)) { failures.add('${file.path}: retired ${match[0]}'); }
      // Includes method variables, conditional calls and event switch/list subscriptions,
      // not only the simplest backend.call('literal') syntax.
      for (final match in literal.allMatches(source)) {
        final name = match[1]!;
        if (RegExp(r'\.(dart|db|lock)$').hasMatch(name)) continue; // File names, not protocol names.
        final start = source.lastIndexOf('\n', match.start) + 1;
        final end = source.indexOf('\n', match.end);
        final line = source.substring(start, end < 0 ? source.length : end);
        if (line.contains("event['kind']")) continue; // Notification payload enum, not event discriminator.
        if (domains.contains(name.split('.').first) && !names.contains(name)) failures.add('${file.path}: undocumented $name');
      }
    }
    expect(failures, isEmpty, reason: failures.join('\n'));
  });
}
