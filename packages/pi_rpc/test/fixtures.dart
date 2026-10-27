import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

/// Real RPC recordings made by `runtime/scripts/rpc-smoke.mjs`.
final fixturesDir = p.normalize(p.join(Directory.current.path, '..', '..', 'runtime', 'fixtures'));

List<Json> fixtureJson(String name) => File(p.join(fixturesDir, 'rpc-session-$name.jsonl'))
    .readAsLinesSync()
    .where((l) => l.trim().isNotEmpty)
    .map((l) => (jsonDecode(l) as Map).cast<String, dynamic>())
    .toList();

List<PiRecord> fixtureRecords(String name) => fixtureJson(name).map(PiRecord.fromJson).toList();

List<PiEvent> fixtureEvents(String name) => fixtureRecords(name).whereType<PiEvent>().toList();
