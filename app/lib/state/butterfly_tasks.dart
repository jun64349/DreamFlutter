import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

import 'agent_controller.dart';
import 'memory_ui.dart';

class ButterflyTasks extends ChangeNotifier {
  ButterflyTasks(this.root) {
    _events = root.backend.events.listen((event) {
      if ([
        'tasks.changed',
        'butterfly.prepared',
        'butterfly.delivery',
        'butterfly.outbox',
        'schedules.changed',
        'run.finished',
        'sandbox.changed',
      ].contains(event['event'])) {
        if (!_queued) {
          _queued = true;
          scheduleMicrotask(() {
            _queued = false;
            if (!_disposed) unawaited(load());
          });
        }
      }
    });
  }
  final AgentController root;
  AgentController? worker;
  List<Json> tasks = [], schedules = [];
  Json sandbox = {};
  String? selectedId, error;
  bool loading = true, preparing = false;
  bool _queued = false, _disposed = false, _connecting = false;
  int _request = 0;
  String? _identity;
  StreamSubscription<Json>? _events;
  Json? get selected => tasks.where((t) => t['id'] == selectedId).firstOrNull;
  bool get ready => sandbox['state'] == 'ready';
  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> load() async {
    final request = ++_request;
    try {
      final results = await Future.wait([
        root.backend.call('butterfly.tasks'),
        root.backend.call('schedules.list'),
        root.backend.call('sandbox.status'),
      ]);
      if (_disposed || request != _request) return;
      tasks = memoryRows(results[0]);
      schedules = memoryRows(results[1]);
      sandbox = memoryMap(results[2]);
      error = null;
      loading = false;
      if (ready && worker == null && !_connecting) {
        _connecting = true;
        try {
          final connected = await root.ensureButterfly();
          if (_disposed) return;
          worker = connected;
          worker?.butterflySubmission = submit;
          worker?.butterflySlotHasPlan = (slotId) =>
              preparing && slotId == worker?.active?.slotId ||
              tasks.any((t) => memoryMap(t['intent'])['slot_id'] == slotId);
          worker?.addListener(_changedSession);
        } finally {
          _connecting = false;
        }
      }
      // The task can acquire its saved path after its first run has begun.
      // Resolve it again after the authoritative task list catches up.
      final file = worker?.currentSessionPath;
      selectedId ??=
          tasks
                  .where(
                    (t) =>
                        file != null &&
                            t['sessionFile'] is String &&
                            SessionStore.samePath(
                              t['sessionFile'] as String,
                              file,
                            ) ||
                        memoryMap(t['intent'])['slot_id'] != null &&
                            memoryMap(t['intent'])['slot_id'] ==
                                worker?.active?.slotId,
                  )
                  .firstOrNull?['id']
              as String?;
      _notify();
    } catch (e) {
      if (_disposed || request != _request) return;
      loading = false;
      error = SessionRuntime.describeError(e);
      _notify();
    }
  }

  void _changedSession() {
    final identity = '${worker?.active?.slotId}:${worker?.currentSessionPath}';
    if (_identity == identity) return;
    _identity = identity;
    final file = worker?.currentSessionPath;
    final match = tasks
        .where(
          (t) =>
              t['sessionFile'] != null &&
              file != null &&
              SessionStore.samePath(t['sessionFile'] as String, file),
        )
        .firstOrNull;
    final intentSlot = memoryMap(selected?['intent'])['slot_id'];
    if (match != null) {
      selectedId = match['id'] as String?;
    } else if (file == null || intentSlot != worker?.active?.slotId) {
      // A new conversation reuses the slot: it is not the old task's any more.
      selectedId = null;
    }
    _notify();
  }

  Future<void> open(Json task) async {
    selectedId = task['id'] as String?;
    _notify();
    final file = task['sessionFile'] as String?;
    if (file != null && worker != null) {
      await worker!.openSession(file);
    } else if (worker != null) {
      final intent = memoryMap(task['intent']);
      if (intent['slot_id'] is String &&
          !await worker!.activateSlot(intent['slot_id'] as String)) {
        await worker!.newSession(forceNew: true);
        if (intent['state'] == 'needs_input') {
          await root.backend.call('butterfly.start', {
            'id': intent['id'],
            'slotId': worker!.active!.slotId,
          });
        }
      }
    }
    selectedId = task['id'] as String?;
    _notify();
  }

  Future<void> submit(String text, List<ImageBlock> images) async {
    final agent = worker;
    final slotId = agent?.active?.slotId;
    if (agent == null || slotId == null || preparing) {
      throw StateError('蝶君还没准备好，请稍后重试');
    }
    final current = selected;
    final intent = memoryMap(current?['intent']);
    // 0.8.2 (user test): 蝶君 is a conversation. A message goes straight to
    // 蝶君, which says what it understood and starts in its reply; nothing
    // lands in 「等你处理」 unless 蝶君 really needs an answer. Only a plan
    // prepared by an earlier version is still answered through it.
    if (intent.isEmpty) {
      // Pictures go into 蝶君's inbox as files, as before: it works on them with its tools.
      final message = images.isEmpty ? text : await _importImages(text, images);
      if (!await agent.active!.send(message)) {
        throw StateError('蝶君还没准备好，请稍后重试');
      }
      return;
    }
    preparing = true;
    error = null;
    _notify();
    try {
      String goal = text;
      if (images.isNotEmpty) goal = await _importImages(text, images);
      Json prepared;
      if (intent['state'] == 'needs_input') {
        prepared = memoryMap(
          await root.backend.call('butterfly.answer', {
            'id': intent['id'],
            'answer': goal,
          }, const Duration(seconds: 90)),
        );
      } else if (intent.isNotEmpty &&
          RegExp(r'^(可以|好|好的|开始|开工|就这样)[。！!\s]*$').hasMatch(goal.trim())) {
        await start(intent);
        return;
      } else {
        if (intent.isNotEmpty) goal = '${intent['goal']}\n用户补充：$goal';
        prepared = memoryMap(
          await root.backend.call('butterfly.prepare', {
            'slotId': slotId,
            'goal': goal,
          }, const Duration(seconds: 90)),
        );
      }
      if (agent.active?.slotId == slotId) {
        selectedId = prepared['task_id'] as String?;
      }
      await load();
      if (selectedId != null && selected == null) {
        tasks = [
          ...tasks,
          {
            'id': selectedId,
            'title': prepared['goal'],
            'goal': prepared['goal'],
            'status': 'waiting',
            'progress': '已复述任务',
            'intent': prepared,
          },
        ];
      }
    } catch (e) {
      error = SessionRuntime.describeError(e);
      rethrow;
    } finally {
      preparing = false;
      _notify();
    }
  }

  Future<String> _importImages(String goal, List<ImageBlock> images) async {
    final folder = await Directory.systemTemp.createTemp('df-butterfly-input-');
    try {
      final files = <String>[];
      for (var i = 0; i < images.length; i++) {
        final image = images[i];
        final extension = switch (image.mimeType) {
          'image/jpeg' => 'jpg',
          'image/webp' => 'webp',
          'image/gif' => 'gif',
          _ => 'png',
        };
        final file = File(
          p.join(
            folder.path,
            'image-${DateTime.now().microsecondsSinceEpoch}-$i.$extension',
          ),
        );
        await file.writeAsBytes(base64Decode(image.data));
        files.add(file.path);
      }
      final result = memoryMap(
        await root.backend.call('butterfly.import', {
          'paths': files,
        }, const Duration(minutes: 5)),
      );
      final paths = (result['paths'] as List? ?? [])
          .whereType<String>()
          .toList();
      if (paths.length != images.length) throw StateError('图片还没传好，请重新添加');
      return '$goal\n\n请读取这些图片：\n${paths.join('\n')}';
    } finally {
      if (await folder.exists()) await folder.delete(recursive: true);
    }
  }

  Future<void> start(Json intent) async {
    await root.backend.call('butterfly.start', {
      'id': intent['id'],
      'slotId': ?worker?.active?.slotId,
    });
    await load();
  }

  Future<void> cancel(Json intent) async {
    await root.backend.call('butterfly.cancel', {'id': intent['id']});
    await load();
  }

  Future<void> changeSchedule(String id, String? status) async {
    await root.backend.call(
      status == null ? 'schedules.remove' : 'schedules.setStatus',
      {'id': id, 'status': ?status},
    );
    await load();
  }

  @override
  void dispose() {
    _disposed = true;
    _events?.cancel();
    worker?.removeListener(_changedSession);
    worker?.butterflySubmission = null;
    worker?.butterflySlotHasPlan = null;
    super.dispose();
  }
}
