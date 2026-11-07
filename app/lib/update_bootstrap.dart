import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:window_manager/window_manager.dart';

/// No preferences, user sessions or editable UI are opened before update validation.
Future<bool> bootstrapUpdate(String dataDir, String appVersion, Future<void> Function() continueStartup) async {
  final file = File(p.join(dataDir, 'updates', 'journal.json'));
  if (!file.existsSync()) return false;
  Map<String, dynamic> read() => jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
  Map<String, dynamic> journal;
  try { journal = read(); } catch (_) {
    runApp(const MaterialApp(home: Scaffold(body: Center(child: Text('更新记录无法读取，已保留数据。请检查后台日志和更新前备份。')))));
    return true;
  }
  if (!{'prepared', 'applying', 'validating', 'verified', 'accepted', 'rollback-needed', 'rolled-back', 'cancelled', 'manual-recovery'}.contains(journal['phase'])) {
    runApp(const MaterialApp(home: Scaffold(body: Center(child: Text('更新阶段无法识别，已保留数据和备份。请检查后台日志。')))));
    return true;
  }
  if (journal['acceptedWrites'] == true || !{'prepared', 'applying', 'validating', 'rollback-needed', 'manual-recovery'}.contains(journal['phase'])) return false;
  runApp(const MaterialApp(home: Scaffold(body: Center(child: Padding(padding: EdgeInsets.all(24), child: Column(mainAxisSize: MainAxisSize.min, children: [CircularProgressIndicator(), SizedBox(height: 20), Text('正在更新并验证数据，请稍候…')]))))));
  unawaited(() async {
    CoreClient? client;
    var uiReady = false;
    try {
      for (var attempt = 0; attempt < 900; attempt++) {
        journal = read();
        if ({'verified', 'accepted', 'rolled-back', 'cancelled'}.contains(journal['phase'])) { await client?.close(); await continueStartup(); return; }
        if (journal['phase'] == 'manual-recovery') throw StateError('自动恢复未能完成。数据和备份已保留，请检查后台日志。');
        if (!uiReady && journal['phase'] == 'validating' && journal['to'] == appVersion) {
          client ??= await CoreLocator.ensureRunning(searchRoots: [p.dirname(Platform.resolvedExecutable), Directory.current.path], dataDir: dataDir);
          await WidgetsBinding.instance.endOfFrame;
          if (Platform.isWindows) { await windowManager.ensureInitialized(); await windowManager.show(); }
          await client.call('updates.uiReady', {'nonce': journal['nonce'], 'pid': pid, 'version': appVersion});
          uiReady = true;
        }
        await Future<void>.delayed(const Duration(milliseconds: 200));
      }
      throw StateError('更新验证等待超时。数据和备份已保留，请检查后台日志。');
    } catch (error) {
      await client?.close();
      runApp(MaterialApp(home: Scaffold(body: Center(child: Padding(padding: const EdgeInsets.all(24), child: SelectableText('$error\n\n更新前备份：${journal['backup'] ?? '请查看 updates/journal.json'}'))))));
    }
  }());
  return true;
}
