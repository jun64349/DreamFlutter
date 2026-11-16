import 'dart:convert';
import 'dart:io';
import 'package:pi_rpc/pi_rpc.dart';
import 'fake_backend.dart';

/// Wire values are retained; only the isolated session/slot and clock are bound
/// to the receiving test window. No hand-authored replacement result shapes.
class V012Fixtures {
  V012Fixtures(this.backend, {required this.sessionFile, required this.slotId})
      : offset = DateTime.now().millisecondsSinceEpoch - (read('goals.get') as Map)['createdAt'] as int;
  final FakeBackend backend;
  final String sessionFile, slotId;
  final int offset;
  static Object? read(String name) => jsonDecode(File('test/fixtures/api/$name.json').readAsStringSync());
  Object? bind(Object? value, [String? key]) {
    if (['sessionFile', 'session_file'].contains(key) && value is String) return sessionFile;
    if (['slotId', 'slot_id'].contains(key) && value is String) return slotId;
    if (value is int && value > 1000000000000 && value < 3000000000000) return value + offset;
    if (value is List) return value.map((v) => bind(v)).toList();
    if (value is Map) return {for (final entry in value.entries) '${entry.key}': bind(entry.value, '${entry.key}')};
    return value;
  }
  void use(String method, [String? name]) => backend.handlers[method] = (_) => bind(read(name ?? method));
  void goals() {
    for (final method in ['goals.list', 'goals.get', 'goals.proposals', 'jobs.list', 'jobs.output', 'jobs.stop', 'confirm.list', 'confirm.answer']) { use(method); }
    use('goals.control', 'goals.control.pause');
    use('goals.proposals.resolve', 'goals.proposals.resolve.reject');
  }
  void schedules() {
    for (final method in ['schedules.occurrences','schedules.get','schedules.history','schedules.defaults','schedules.save','schedules.undo','schedules.runNow','schedules.remove','patrol.status','patrol.log','patrol.runNow','autonomy.rules.list','autonomy.rules.mode']) { use(method); }
  }
  List<Json> events(String event) => (bind(read('events/$event')) as List).map((e) => (e as Map).cast<String, dynamic>()).toList();
}
