// Extra visual fixtures for v1 only. No production defaults or shared FakePi changes.
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

import 'v012_compare_test.dart' show Demo, at;

/// Serves the project's existing renderer without starting the user's core or a model.
Future<HttpServer> startV1Renderer() async {
  final core = p.normalize(p.join(Directory.current.path, '..', 'core'));
  final module = Uri.file(p.join(core, 'src', 'render', 'renderer.ts'))
      .toString();
  final result = await Process.run(
    'node',
    [
      '--disable-warning=ExperimentalWarning',
      '--input-type=module',
      '-e',
      'import {rendererPage} from ${jsonEncode(module)}; process.stdout.write(rendererPage("djEtbG9jYWwtcmVuZGVyZXI="));',
    ],
    stdoutEncoding: utf8,
    stderrEncoding: utf8,
  );
  if (result.exitCode != 0) throw StateError('演示绘图页面准备失败：${result.stderr}');
  final html = result.stdout as String;
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((request) async {
    try {
      final name = request.uri.path;
      if (name == '/render/renderer.html') {
        request.response.headers.contentType = ContentType.html;
        request.response.headers.set('Cache-Control', 'no-store');
        request.response.headers.set(
          'Content-Security-Policy',
          "default-src 'none'; script-src 'self' 'nonce-djEtbG9jYWwtcmVuZGVyZXI=' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:",
        );
        request.response.write(html);
      } else if (name == '/render/mermaid.min.js' ||
          name == '/render/chart.umd.js') {
        request.response.headers.set(
          'Content-Type',
          'text/javascript; charset=utf-8',
        );
        request.response.add(
          await File(p.join(core, 'assets', 'render', p.basename(name)))
              .readAsBytes(),
        );
      } else {
        request.response.statusCode = HttpStatus.notFound;
      }
    } finally {
      await request.response.close();
    }
  });
  return server;
}

Future<void> installV1VisualData(
  Demo demo,
  List<Json> Function() workbenchMessages, {
  required bool dark,
}) async {
  final now = DateTime.now();
  int today(int h, int m) =>
      DateTime(now.year, now.month, now.day, h, m).millisecondsSinceEpoch;
  final chartPath = p.join(demo.home, 'price.png');
  final chart = await _priceChart(dark);
  File(chartPath).writeAsBytesSync(chart);
  final chart64 = base64Encode(chart);
  const flash = {
    'id': 'deepseek-v4.1-flash',
    'name': 'DeepSeek V4.1 Flash',
    'provider': 'opencode-go',
    'reasoning': true,
    'input': ['text', 'image'],
    'contextWindow': 128000,
    'thinkingLevels': ['off', 'low', 'medium', 'high'],
  };
  const glm = {
    'id': 'glm-4.6',
    'name': 'GLM-4.6',
    'provider': 'glm',
    'reasoning': true,
    'input': ['text'],
    'contextWindow': 128000,
  };
  const vision = {
    'id': 'glm-4.6v',
    'name': 'GLM-4.6V',
    'provider': 'glm',
    'reasoning': true,
    'input': ['text', 'image'],
    'contextWindow': 128000,
  };
  const gpt = {
    'id': 'gpt-6.1-sol',
    'name': 'GPT-6.1 Sol',
    'provider': 'chatgpt',
    'reasoning': true,
    'input': ['text', 'image'],
    'contextWindow': 128000,
  };
  const models = [
    flash,
    glm,
    vision,
    gpt,
    {
      'id': 'daily',
      'name': '日常',
      'provider': 'dreamflutter',
      'reasoning': true,
      'input': ['text', 'image'],
      'contextWindow': 128000,
    },
    {
      'id': 'vision',
      'name': '看图',
      'provider': 'dreamflutter',
      'reasoning': false,
      'input': ['text', 'image'],
      'contextWindow': 128000,
    },
  ];
  demo.backend.settings = {
    ...demo.backend.settings,
    'defaultModel': 'opencode-go/deepseek-v4.1-flash',
    'largeTaskModel': 'dreamflutter/daily',
    'visionModel': 'dreamflutter/vision',
  };
  final oldSessions = demo.backend.handlers['sessions.list']!;
  final oldSchedules = demo.backend.handlers['schedules.list']!;
  final oldGetSchedule = demo.backend.handlers['schedules.get']!;
  final oldLedger = demo.backend.handlers['ledger.summary']!;
  demo.backend.handlers.addAll({
    // 蝶君设置会重新读取整份配置；与真实 Core 的 settings.get 保持一致。
    'settings.get': (_) => demo.backend.settings,
    'gateway.channels': (_) => [
      {
        'id': 'chatgpt',
        'provider': 'chatgpt',
        'platform': 'chatgpt',
        'name': 'ChatGPT',
        'kind': 'plan',
        'oauth': true,
        'enabled': true,
        'models': [gpt],
        'keys': <Json>[],
      },
      {
        'id': 'opencode-go',
        'provider': 'opencode-go',
        'platform': 'opencode-go',
        'name': 'OpenCode Go',
        'kind': 'plan',
        'enabled': true,
        'models': [flash],
        'keys': <Json>[],
      },
      {
        'id': 'glm',
        'provider': 'glm',
        'platform': 'glm',
        'name': '智谱',
        'kind': 'payg',
        'enabled': true,
        'models': [glm, vision],
        'keys': <Json>[],
      },
    ],
    'gateway.groups': (_) => [
      {
        'id': 'daily',
        'name': '日常',
        'entries': [
          {'channel': 'chatgpt', 'model': 'gpt-6.1-sol', 'priority': 0},
          {
            'channel': 'opencode-go',
            'model': 'deepseek-v4.1-flash',
            'priority': 1,
          },
          {'channel': 'glm', 'model': 'glm-4.6', 'priority': 2},
        ],
      },
      {
        'id': 'vision',
        'name': '看图',
        'entries': [
          {'channel': 'glm', 'model': 'glm-4.6v', 'priority': 0},
        ],
      },
    ],
    'sessions.list': (params) => [
      for (final (i, item) in (oldSessions(params) as List).indexed)
        {
          ...(item as Json),
          'modifiedAt': i < 3
              ? today(i == 0 ? 10 : 9, i == 0 ? 12 : 40)
              : at(12 - i, 11, 20),
        },
      if (params['cwd'] == demo.project) ...[
        {
          'path': p.join(demo.root.path, 'archived-refs.jsonl'),
          'title': '参考文献格式统一成 GB/T 7714',
          'cwd': demo.project,
          'modifiedAt': at(10, 11),
          'archived': true,
        },
        {
          'path': p.join(demo.root.path, 'archived-plot.jsonl'),
          'title': '实验数据画成箱线图',
          'cwd': demo.project,
          'modifiedAt': at(8, 11),
          'archived': true,
        },
      ],
    ],
    'sessions.recycleBin': (_) => [
      {
        'batchId': 'demo-xlsx',
        'session': {'title': '问一下：pandas 怎么读 xlsx'},
        'deletedAt': today(9, 0) - 2 * 86400000,
        'expiresAt': today(9, 0) + 28 * 86400000,
      },
    ],
    'ledger.summary': (params) {
      final result = oldLedger(params) as Json;
      if (params['groupBy'] != 'model') return result;
      return {
        ...result,
        'rows': [
          for (final row in result['rows'] as List)
            {
              ...(row as Json),
              'key': switch (row['key']) {
                'glm/glm-4.6' => 'chatgpt/gpt-6.1-sol',
                'opencode-go/deepseek-v4.1' => 'glm/glm-4.6v',
                'deepseek/deepseek-v4.1-flash' =>
                  'opencode-go/deepseek-v4.1-flash',
                final key => '$key',
              },
            },
        ],
      };
    },
    'schedules.list': (params) => [
      for (final row in oldSchedules(params) as List)
        {
          ...(row as Json),
          if (row['id'] == 's_report') 'sessionFile': demo.goalPath,
        },
    ],
    'schedules.get': (params) => {
      ...(oldGetSchedule(params) as Json),
      if (params['id'] == 's_report') 'sessionFile': demo.goalPath,
    },
    'storage.locations': (_) => {
      'rows': [
        {
          'id': 'database',
          'label': '数据目录',
          'layer': '对话、记忆、设置都在这里',
          'path': p.join(demo.root.path, 'data'),
          'bytes': 3650722202,
          'movable': true,
        },
      ],
      'artifacts': <Json>[],
    },
    'updates.status': (_) => {
      'application': {
        'version': '0.12.0-test.6',
        'build': 'T-143',
        'signed': false,
      },
      'state': 'idle',
      'message': '已是最新 · 上次检查 今天 09:12',
      'coreVersion': '0.12.0',
      'platform': 'windows',
      'arch': 'x64',
      'canStartup': false,
      'canInstall': false,
    },
  });
  final previousLaunch = demo.backend.onLaunch;
  demo.backend.onLaunch = (pi) {
    previousLaunch?.call(pi);
    final previousCommand = pi.onCommand;
    Json currentModel = flash;
    String? titleFor(String file) => SessionStore.samePath(file, demo.goalPath)
        ? '整理三款温湿度传感器对比'
        : SessionStore.samePath(file, demo.wbPath)
        ? '整理本周温湿度数据成周报'
        : null;
    void prepareMessages(String file) {
      if (SessionStore.samePath(file, demo.wbPath)) {
        pi.messages = [
          for (final message in workbenchMessages())
            {
              ...message,
              if (message['role'] == 'assistant') 'provider': 'opencode-go',
              if (message['role'] == 'assistant' &&
                  message['stopReason'] == 'stop')
                'usage': {
                  'input': 1260,
                  'output': message['timestamp'] == at(13, 10, 12) ? 2356 : 696,
                },
            },
        ];
        final lastUser = pi.messages.lastIndexWhere((m) => m['role'] == 'user');
        pi.messages[lastUser]['content'] = '再画个图说明数据怎么流到周报，顺便给我汇总脚本的核心部分';
        pi.messages.last['content'] = [
          {
            'type': 'text',
            'text': '数据一共走四步：\n\n```mermaid\nflowchart LR\n  A[网关导出 CSV] --> B[data/raw/2026-11]\n  B --> C[summary.py 汇总]\n  C --> D[周报-W45.md]\n```\n\n```python\ndef weekly(df):\n    df = df.resample("1h").mean()\n    over = df[df.humidity > 75]\n    return df.mean(), len(over)\n```',
          },
        ];
      } else if (SessionStore.samePath(file, demo.goalPath)) {
        pi.messages = [
          for (final message in demo.goalMessages())
            {
              ...message,
              if (message['role'] == 'assistant' &&
                  message['dfProactiveRef'] == null)
                'timestamp': at(13, 10, 5),
              if (message['role'] == 'assistant')
                'usage': {
                  'input': 1800,
                  'output': message['dfProactiveRef'] != null
                      ? 0
                      : message['stopReason'] == 'stop'
                      ? 1640
                      : 0,
                },
              if (message['toolCallId'] == 'plot') ...{
                'details': {'path': chartPath},
                'content': [
                  {'type': 'image', 'mimeType': 'image/png', 'data': chart64},
                ],
              },
            },
        ];
        pi.messages.last['content'] = [
          {'type': 'text', 'text': '好，这件事我按目标来推进，做完会核对交付再告诉你。先抓了一轮价格，画了张对比图。'},
        ];
      }
      // Real saved entry timestamps are the source of history reply timings.
      final tree = <Json>[];
      for (final (i, message) in pi.messages.indexed) {
        final stamp = (message['timestamp'] as num?)?.toInt() ?? at(13, 10, 4);
        final seconds =
            message['role'] != 'assistant' || message['dfProactiveRef'] != null
            ? 0
            : SessionStore.samePath(file, demo.wbPath)
            ? (stamp == at(13, 10, 12) ? 38 : 12)
            : 41;
        tree.add({
          'entry': {
            'id': 'entry-$i',
            'parentId': i == 0 ? null : 'entry-${i - 1}',
            'type': 'message',
            'timestamp': DateTime.fromMillisecondsSinceEpoch(
              stamp + seconds * 1000,
            ).toIso8601String(),
            'message': message,
          },
          'children': <Object>[],
        });
      }
      pi.extraResponses['get_tree'] = {
        'leafId': tree.isEmpty ? null : 'entry-${tree.length - 1}',
        'tree': tree,
      };
    }

    prepareMessages(pi.sessionFile);
    pi.extraResponses['get_available_models'] = {'models': models};
    pi.extraResponses['set_model'] = currentModel;
    pi.onCommand = (command) {
      previousCommand?.call(command);
      final type = command['type'];
      if (type == 'switch_session') {
        prepareMessages(command['sessionPath'] as String);
      }
      if (type == 'new_session') {
        pi.messages = [];
        pi.extraResponses['get_tree'] = {'leafId': null, 'tree': <Json>[]};
      }
      if (type == 'set_model') {
        currentModel =
            models
                .where(
                  (m) =>
                      m['id'] == command['modelId'] &&
                      m['provider'] == command['provider'],
                )
                .firstOrNull ??
            flash;
        pi.extraResponses['set_model'] = currentModel;
      }
      if (type == 'get_state') {
        pi.extraResponses['get_state'] = {
          'model': currentModel,
          'thinkingLevel': 'medium',
          'isStreaming': pi.streaming,
          'isCompacting': false,
          'sessionFile': pi.sessionFile,
          'sessionId': pi.sessionId ?? pi.slotId,
          'sessionName': titleFor(pi.sessionFile),
          'messageCount': pi.messages.length,
          'pendingMessageCount': 0,
          'autoCompactionEnabled': true,
        };
      }
    };
  };
}

Future<List<int>> _priceChart(bool dark) async {
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);
  canvas.drawColor(
    dark ? const Color(0xff29231e) : const Color(0xfffdfbf7),
    BlendMode.src,
  );
  final paint = Paint()
    ..color = (dark ? const Color(0xffc99666) : const Color(0xffa24c29))
        .withValues(alpha: .7);
  const values = [40, 72, 55, 90, 35, 62];
  for (final (i, value) in values.indexed) {
    canvas.drawRRect(
      RRect.fromRectAndCorners(
        Rect.fromLTWH(
          18 + i * 65,
          124 - value.toDouble(),
          55,
          value.toDouble(),
        ),
        topLeft: const Radius.circular(3),
        topRight: const Radius.circular(3),
      ),
      paint,
    );
  }
  final picture = recorder.endRecording();
  final image = await picture.toImage(420, 124);
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  image.dispose();
  picture.dispose();
  return data!.buffer.asUint8List();
}
