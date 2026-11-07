import 'dart:convert';
import 'dart:io';
import 'package:dreamflutter/update_bootstrap.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('manual recovery keeps startup read-only and shows the retained backup location', (tester) async {
    final root = Directory.systemTemp.createTempSync('df-update-bootstrap-');
    addTearDown(() => root.deleteSync(recursive: true));
    final updates = Directory('${root.path}/updates')..createSync();
    final backup = '${root.path}/backups/retained.dfbackup';
    File('${updates.path}/journal.json').writeAsStringSync(jsonEncode({'phase': 'manual-recovery', 'acceptedWrites': false, 'backup': backup}));
    var continued = false;
    final held = await bootstrapUpdate(root.path, '0.6.0-test.2', () async { continued = true; });
    await tester.pumpAndSettle();
    expect(held, true); expect(continued, false);
    expect(find.textContaining('自动恢复未能完成'), findsOneWidget);
    expect(find.textContaining(backup), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
