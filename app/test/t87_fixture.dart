import 'dart:io';
import 'dart:convert';

import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';

class T87Fixture {
  T87Fixture._(this.root, this.backend, this.agent);
  final Directory root;
  final FakeBackend backend;
  final AgentController agent;
  final items = <Json>[];
  final tasks = <Json>[];
  final schedules = <Json>[];
  final undo = <String, Json>{};
  bool rejectEdit = false;
  int _batch = 0;
  static Future<T87Fixture> create() async {
    final root = Directory.systemTemp.createTempSync('df_t87_');
    final project = Directory('${root.path}/传感器项目')..createSync();
    final home = Directory('${root.path}/butterfly')..createSync();
    SharedPreferences.setMockInitialValues({
      'workspace': project.path,
      'onboarded': true,
      'runPanelOpen': false,
    });
    final backend = FakeBackend()..butterflyHome = home.path;
    final agent = AgentController(
      preferences: await Preferences.load(),
      sessionStore: SessionStore(sessionsDir: root.path),
      backend: backend,
    );
    final fixture = T87Fixture._(root, backend, agent)..seed();
    await agent.init();
    return fixture;
  }

  Json receipt(Json item) => {
    'item': {...item},
    'batchId': 'b${++_batch}',
    'applied': [
      {'itemId': item['id']},
    ],
    'pending': [],
    'rejected': [],
  };
  void seed() {
    final now = DateTime.now().millisecondsSinceEpoch;
    final source = File('${root.path}/project-source.jsonl')
      ..writeAsStringSync(
        [
          {
            'type': 'session',
            'id': 'source',
            'cwd': agent.workspace,
            'timestamp': DateTime.now().toIso8601String(),
          },
          {
            'type': 'message',
            'id': 'q',
            'message': {'role': 'user', 'content': '讨论传感器项目的协作约定'},
          },
        ].map(jsonEncode).join('\n'),
      );
    for (final row in [
      {'id': 'you', 'content': '交流用简体中文，回复简练', 'scope': 'global'},
      {
        'id': 'project',
        'content': '原始数据只读，周报写到 reports 文件夹',
        'scope': 'workspace',
        'workspacePath': agent.workspace,
      },
      {'id': 'own', 'content': '参考文献统一用 GB/T 7714 格式', 'scope': 'butterfly'},
      {
        'id': 'old',
        'content': '实验室温湿度计需要重新校准',
        'scope': 'workspace',
        'workspacePath': agent.workspace,
        'possiblyOutdated': true,
      },
    ]) {
      items.add({'version': 1, 'status': 'active', 'updatedAt': now, ...row});
    }
    final report = File('${root.path}/组会纪要.md')
      ..writeAsStringSync('# 组会纪要\n\n已整理三次组会，列出十一项待办。');
    tasks.addAll([
      {
        'id': 'running',
        'title': '把 30 篇参考文献统一格式',
        'status': 'in_progress',
        'progress': '正在核对第 28 篇文献',
        'cwd': backend.butterflyHome,
        'sessionFile': '${root.path}/running.jsonl',
      },
      {
        'id': 'waiting',
        'title': '对比三款温湿度传感器',
        'status': 'waiting',
        'progress': '等你回答预算上限',
        'cwd': backend.butterflyHome,
        'sessionFile': '${root.path}/waiting.jsonl',
      },
      {
        'id': 'complete',
        'title': '每周一整理上周的组会纪要',
        'status': 'completed',
        'progress': '已整理 3 次组会',
        'cwd': backend.butterflyHome,
        'sessionFile': '${root.path}/complete.jsonl',
        'scheduleId': 'weekly',
        'delivery': {
          'summary': '按约定整理了三次组会，共十一项待办，已标出四项需要跟进的事项。',
          'files': [
            {'path': report.path, 'exists': true},
          ],
          'cost': 0.05,
          'durationMs': 360000,
        },
      },
      {
        'id': 'failed',
        'title': '把 MQTT 报文抓包整理成表',
        'status': 'failed',
        'progress': '抓包文件打不开，请换一份文件',
        'cwd': backend.butterflyHome,
        'sessionFile': '${root.path}/failed.jsonl',
      },
    ]);
    schedules.add({
      'id': 'weekly',
      'name': '每周组会纪要',
      'status': 'active',
      'sessionFile': '${root.path}/complete.jsonl',
      'nextRunAt': now + 86400000,
    });
    backend.handlers.addAll({
      'sandbox.status': (_) => {'state': 'ready'},
      'memory.items': (params) => items
          .where(
            (i) =>
                i['status'] != 'forgotten' &&
                (params['scope'] == 'butterfly'
                    ? i['scope'] == 'butterfly'
                    : i['scope'] != 'butterfly'),
          )
          .map((i) => {...i})
          .toList(),
      'memory.item': (params) => {
        'item': items.firstWhere((i) => i['id'] == params['id']),
        'sources': [
          if (params['id'] == 'project')
            {'kind': 'session', 'ref': source.path, 'at': now}
          else
            {'kind': 'user_edit', 'at': now},
        ],
        'versions': [],
        'log': [],
      },
      'memory.update': (params) {
        if (rejectEdit) {
          return {
            'applied': [],
            'rejected': [
              {'reason': '连接暂时中断，请重试'},
            ],
          };
        }
        final item = items.firstWhere((i) => i['id'] == params['id']);
        item['content'] = params['content'];
        item['version'] = (item['version'] as int) + 1;
        return receipt(item);
      },
      'memory.setStatus': (params) {
        final item = items.firstWhere((i) => i['id'] == params['id']);
        final before = {...item};
        item['status'] = params['status'];
        final result = receipt(item);
        undo[result['batchId'] as String] = before;
        return result;
      },
      'memory.undoBatch': (params) {
        final item = undo[params['batchId']]!;
        items[items.indexWhere((i) => i['id'] == item['id'])] = item;
        return {
          'undone': ['op'],
          'conflicts': [],
        };
      },
      'memory.undo': (_) => {
        'undone': ['op'],
        'conflicts': [],
      },
      'memory.undoBoundary': (_) => {'sessionId': 'topic', 'task': {}},
      'memory.save': (params) {
        final item = {
          'id': 'added',
          'version': 1,
          'updatedAt': now,
          'status': 'active',
          ...params,
        };
        items.add(item);
        return receipt(item);
      },
      'memory.log': (_) => {
        'days': [
          {
            'day': '今天',
            'entries': [
              {
                'opId': 'recent',
                'kind': 'add',
                'after': {...items.first},
                'undoable': true,
              },
            ],
          },
        ],
        'boundaries': [
          {
            'id': 'boundary',
            'changed': true,
            'after': {'prompt': '整理实验记录'},
          },
        ],
        'hasMore': false,
      },
      'butterfly.tasks': (_) => tasks.map((t) => {...t}).toList(),
      'butterfly.prepare': (params) {
        final intent = {
          'id': 'intent',
          'task_id': 'prepared',
          'slot_id': params['slotId'],
          'state': 'waiting',
          'goal': params['goal'],
          'restatement': '我会整理本周的实验记录',
          'plan': '先读取资料，再归纳结论，最后交付周报。',
          'start_at': now + 60000,
        };
        tasks.removeWhere((t) => t['id'] == 'prepared');
        tasks.insert(0, {
          'id': 'prepared',
          'title': params['goal'],
          'status': 'in_progress',
          'progress': '已复述任务，等待开工',
          'intent': intent,
        });
        return intent;
      },
      'butterfly.start': (_) {
        final t = tasks.firstWhere((t) => t['id'] == 'prepared');
        t.remove('intent');
        t['status'] = 'in_progress';
        t['progress'] = '正在读取资料';
        return {'ok': true};
      },
      'butterfly.cancel': (_) {
        tasks.removeWhere((t) => t['id'] == 'prepared');
        return {'ok': true};
      },
      'schedules.list': (_) => schedules,
      'schedules.setStatus': (params) {
        schedules.firstWhere((s) => s['id'] == params['id'])['status'] =
            params['status'];
        return {'ok': true};
      },
      'schedules.remove': (params) {
        schedules.removeWhere((s) => s['id'] == params['id']);
        return {'ok': true};
      },
    });
  }

  Future<void> dispose() async {
    agent.dispose();
    // Refreshes already in flight can briefly hold a JSONL handle on Windows.
    for (var attempt = 0; root.existsSync(); attempt++) {
      try {
        await root.delete(recursive: true);
      } on FileSystemException {
        if (attempt == 9) rethrow;
        await Future<void>.delayed(const Duration(milliseconds: 50));
      }
    }
  }
}
