import 'dart:convert';
import 'dart:io';

import 'package:dreamflutter/state/project_trust.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;

void main() {
  late Directory root;
  late ProjectTrust trust;

  setUp(() {
    root = Directory.systemTemp.createTempSync('df_trust_');
    trust = ProjectTrust(agentDir: p.join(root.path, 'agent'));
  });
  tearDown(() => root.deleteSync(recursive: true));

  Directory project(String name, {List<String> piEntries = const []}) {
    final dir = Directory(p.join(root.path, name))..createSync(recursive: true);
    for (final entry in piEntries) {
      final path = p.join(dir.path, '.pi', entry);
      if (entry.contains('.')) {
        File(path)
          ..createSync(recursive: true)
          ..writeAsStringSync('{}');
      } else {
        Directory(path).createSync(recursive: true);
      }
    }
    return dir;
  }

  test('only protected .pi entries require trust', () {
    expect(ProjectTrust.requiresTrust(project('plain').path), isFalse);
    expect(ProjectTrust.requiresTrust((project('bare')..createSync()).path), isFalse);
    Directory(p.join(root.path, 'bare', '.pi')).createSync();
    expect(ProjectTrust.requiresTrust(p.join(root.path, 'bare')), isFalse, reason: 'a bare .pi folder is fine');
    expect(ProjectTrust.requiresTrust(project('cfg', piEntries: ['settings.json']).path), isTrue);
    expect(ProjectTrust.requiresTrust(project('sk', piEntries: ['skills']).path), isTrue);
  });

  test('.agents/skills in an ancestor requires trust', () {
    final parent = project('mono');
    Directory(p.join(parent.path, '.agents', 'skills')).createSync(recursive: true);
    final child = Directory(p.join(parent.path, 'packages', 'app'))..createSync(recursive: true);
    expect(ProjectTrust.requiresTrust(child.path), isTrue);
  });

  test('remembered decisions are written to trust.json and found for subfolders', () {
    final dir = project('remembered', piEntries: ['settings.json']);
    expect(trust.savedDecision(dir.path), isNull);
    trust.remember(dir.path, true);
    expect(trust.savedDecision(dir.path), isTrue);
    expect(trust.savedDecision(p.join(dir.path, 'src')), isTrue);
    final data = jsonDecode(File(trust.trustFile).readAsStringSync()) as Map;
    expect(data.values.single, isTrue);
  });

  test('launchArgs asks only when needed and maps the answer to a CLI flag', () async {
    var asked = 0;
    Future<TrustChoice?> answer(TrustChoice choice) async {
      asked++;
      return choice;
    }

    expect(await trust.launchArgs(project('none').path, (_) => answer(TrustChoice.trustOnce)), isEmpty);
    expect(asked, 0);

    final once = project('once', piEntries: ['settings.json']);
    expect(await trust.launchArgs(once.path, (_) => answer(TrustChoice.trustOnce)), ['--approve']);
    expect(trust.savedDecision(once.path), isNull, reason: 'one-time answers are not saved');

    final no = project('no', piEntries: ['extensions']);
    expect(await trust.launchArgs(no.path, (_) => answer(TrustChoice.distrustRemember)), ['--no-approve']);
    expect(trust.savedDecision(no.path), isFalse);
    expect(await trust.launchArgs(no.path, (_) => answer(TrustChoice.trustOnce)), isEmpty, reason: 'Pi applies the saved decision');
    expect(asked, 2);

    expect(await trust.launchArgs(project('dismissed', piEntries: ['skills']).path, (_) async => null), ['--no-approve']);
  });
}
