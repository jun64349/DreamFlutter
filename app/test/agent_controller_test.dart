import 'dart:convert';
import 'dart:io';

import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_pi.dart';

void main() {
  late List<FakePi> pis;
  late Directory sessions;
  late DateTime now;

  Future<AgentController> startController({bool runtimeAvailable = true}) async {
    SharedPreferences.setMockInitialValues({'workspace': Directory.systemTemp.path});
    final controller = AgentController(
      preferences: await Preferences.load(),
      sessionStore: SessionStore(sessionsDir: sessions.path),
      resolveConfig: (cwd, args) =>
          runtimeAvailable ? PiLaunchConfig(cliPath: 'cli.js', workingDirectory: cwd, extraArgs: args) : null,
      launch: (config) async {
        final pi = FakePi(config);
        pis.add(pi);
        return PiRpcClient(pi);
      },
      clock: () => now,
    );
    await controller.init();
    return controller;
  }

  setUp(() {
    pis = [];
    now = DateTime(2026, 10, 27, 12);
    sessions = Directory.systemTemp.createTempSync('df_sessions_');
  });
  tearDown(() => sessions.deleteSync(recursive: true));

  group('single session', () {
    test('starts ready, loads models and applies the preferred model', () async {
      final agent = await startController();
      expect(agent.status, ConnectionStatus.ready);
      expect(agent.models, isNotEmpty);
      expect(agent.thinkingLevels, contains('high'));
      expect(pis.single.sent('set_model').single, contains(Preferences.defaultModelKey.split('/').last));
      agent.dispose();
    });

    test('send prompts Pi and the replayed stream folds into the transcript', () async {
      final agent = await startController();
      final pi = pis.single;
      await agent.send('  read hello.txt  ');
      expect(pi.commands.lastWhere((c) => c['type'] == 'prompt')['message'], 'read hello.txt');
      expect(pi.commands.lastWhere((c) => c['type'] == 'prompt').containsKey('streamingBehavior'), isFalse);

      final statsBefore = pi.sent('get_session_stats').length;
      FakePi.recordedEvents.forEach(pi.emit);
      await pumpEventQueue();

      expect(agent.isRunning, isFalse);
      expect(agent.transcript.items.whereType<AssistantItem>().last.parts.whereType<TextPart>().single.text, 'hello from dreamflutter');
      expect(pi.sent('get_session_stats').length, greaterThan(statsBefore), reason: 'stats refresh after agent_settled');
      agent.dispose();
    });

    test('sending during a run steers the agent', () async {
      final agent = await startController();
      pis.single.startRun('long task');
      await pumpEventQueue();
      expect(agent.isRunning, isTrue);
      await agent.send('also check README');
      expect(pis.single.commands.lastWhere((c) => c['type'] == 'prompt')['streamingBehavior'], 'steer');
      agent.dispose();
    });

    test('an unexpected exit shows the crashed state', () async {
      final agent = await startController();
      pis.single.crash();
      await pumpEventQueue();
      expect(agent.status, ConnectionStatus.crashed);
      expect(agent.statusDetail, contains('退出码 1'));
      agent.dispose();
    });

    test('missing runtime is reported instead of crashing', () async {
      final agent = await startController(runtimeAvailable: false);
      expect(agent.status, ConnectionStatus.missingRuntime);
      agent.dispose();
    });

  });

  group('extension UI', () {
    test('dialogs wait for the user and the answer goes back to Pi', () async {
      final agent = await startController();
      final pi = pis.single;
      pi.emit({'type': 'extension_ui_request', 'id': 'ui-7', 'method': 'select', 'title': 'Agent 请求执行操作', 'options': ['允许', '拒绝']});
      await pumpEventQueue();
      final dialog = agent.pendingDialog!;
      expect(dialog.options, ['允许', '拒绝']);
      expect(pi.commands.where((c) => c['type'] == 'extension_ui_response'), isEmpty, reason: 'nothing is auto-answered');

      agent.answerDialog(dialog, value: '允许');
      expect(pi.commands.last, {'type': 'extension_ui_response', 'id': 'ui-7', 'value': '允许'});
      expect(agent.pendingDialog, isNull);
      agent.dispose();
    });

    test('a dialog from a background session flags it and shows a toast', () async {
      final agent = await startController();
      final first = pis.single..startRun('task');
      await pumpEventQueue();
      final firstPath = agent.currentSessionPath!;
      await agent.newSession();
      final toasts = <String>[];
      agent.toasts.listen(toasts.add);

      first.emit({'type': 'extension_ui_request', 'id': 'ui-1', 'method': 'confirm', 'title': 'Run?', 'message': 'rm'});
      await pumpEventQueue();
      expect(agent.pendingDialog, isNull, reason: 'the active session has no dialog');
      expect(agent.sidebar.singleWhere((e) => SessionStore.samePath(e.path, firstPath)).needsAttention, isTrue);
      expect(toasts.single, contains('task'));

      await agent.openSession(firstPath);
      expect(agent.pendingDialog?.id, 'ui-1');
      agent.dispose();
    });

    test('a settled run drops stale dialogs', () async {
      final agent = await startController();
      final pi = pis.single..startRun('x');
      pi.emit({'type': 'extension_ui_request', 'id': 'ui-2', 'method': 'input', 'title': 'Name?'});
      await pumpEventQueue();
      expect(agent.pendingDialog, isNotNull);
      pi.finishRun();
      await pumpEventQueue();
      expect(agent.pendingDialog, isNull);
      agent.dispose();
    });

    test('status, widgets and editor text from extensions are exposed', () async {
      final agent = await startController();
      final pi = pis.single
        ..emit({'type': 'extension_ui_request', 'id': 'a', 'method': 'setStatus', 'statusKey': 'git', 'statusText': 'main*'})
        ..emit({'type': 'extension_ui_request', 'id': 'b', 'method': 'setWidget', 'widgetKey': 'todo', 'widgetLines': ['1. tests']})
        ..emit({'type': 'extension_ui_request', 'id': 'c', 'method': 'set_editor_text', 'text': '/review '});
      await pumpEventQueue();
      expect(agent.extensionStatuses, {'git': 'main*'});
      expect(agent.extensionWidgets['todo'], ['1. tests']);
      expect(agent.active!.editorText, '/review ');
      pi.emit({'type': 'extension_ui_request', 'id': 'd', 'method': 'setStatus', 'statusKey': 'git'});
      await pumpEventQueue();
      expect(agent.extensionStatuses, isEmpty);
      agent.dispose();
    });
  });

  group('M2 session features', () {
    test('images are sent with the prompt', () async {
      final agent = await startController();
      await agent.send('what is this?', images: const [ImageBlock(data: 'AAAA', mimeType: 'image/png')]);
      final prompt = pis.single.commands.lastWhere((c) => c['type'] == 'prompt');
      expect(prompt['images'], [
        {'type': 'image', 'data': 'AAAA', 'mimeType': 'image/png'},
      ]);
      agent.dispose();
    });

    test('manual compaction sends instructions and reloads history', () async {
      final agent = await startController();
      final pi = pis.single;
      final result = await agent.compact(instructions: '保留代码改动');
      expect(result!.estimatedTokensAfter, 32000);
      expect(pi.commands.lastWhere((c) => c['type'] == 'compact')['customInstructions'], '保留代码改动');
      expect(pi.sent('get_messages'), isNotEmpty);
      agent.dispose();
    });

    test('forking from a message opens the fork and puts the text back in the input', () async {
      final agent = await startController();
      final pi = pis.single;
      pi.messages = [
        {'role': 'user', 'content': 'first', 'timestamp': 1},
        {'role': 'user', 'content': 'second', 'timestamp': 2},
      ];
      agent.transcript.loadHistory(pi.messages.map(AgentMessage.fromJson));
      final before = agent.currentSessionPath;
      final second = agent.transcript.items.whereType<UserItem>().last;

      await agent.forkFrom(second);
      expect(pi.commands.lastWhere((c) => c['type'] == 'fork')['entryId'], 'e1');
      expect(agent.currentSessionPath, isNot(before));
      expect(agent.active!.editorText, 'edited later');
      agent.dispose();
    });

    test('deleting the active session leaves a blank session behind', () async {
      final agent = await startController();
      final pi = pis.single
        ..startRun('doomed')
        ..finishRun();
      await pumpEventQueue();
      final path = agent.currentSessionPath!;
      await agent.deleteSession(path);
      expect(agent.currentSessionPath, isNot(path));
      expect(agent.transcript.items, isEmpty);
      expect(pi.sent('abort'), isEmpty, reason: 'it was idle');
      agent.dispose();
    });

    test('approval mode is written to the file the Pi extension reads', () async {
      final agent = await startController();
      await agent.setApprovalMode(ApprovalMode.all);
      final json = jsonDecode(File(Preferences.bridgeFile()).readAsStringSync()) as Map;
      expect(json['approvalMode'], 'all');
      await agent.setApprovalMode(ApprovalMode.changes);
      agent.dispose();
    });
  });

  group('parallel sessions', () {
    test('new session while idle reuses the same process', () async {
      final agent = await startController();
      pis.single
        ..startRun('first')
        ..finishRun();
      await pumpEventQueue();
      final firstPath = agent.currentSessionPath;

      await agent.newSession();
      expect(pis, hasLength(1));
      expect(pis.single.sent('new_session'), hasLength(1));
      expect(agent.currentSessionPath, isNot(firstPath));
      expect(agent.transcript.items, isEmpty);
      agent.dispose();
    });

    test('new session while running leaves the run going in the background', () async {
      final agent = await startController();
      final first = pis.single;
      first.startRun('write a long essay');
      await pumpEventQueue();
      final firstRuntime = agent.active!;
      final firstPath = agent.currentSessionPath!;

      await agent.newSession();

      expect(pis, hasLength(2), reason: 'a second Pi process serves the new session');
      expect(first.sent('abort'), isEmpty, reason: 'the running session is not interrupted');
      expect(firstRuntime.isRunning, isTrue);
      expect(agent.active, isNot(firstRuntime));
      expect(agent.transcript.items, isEmpty);
      expect(agent.backgroundRunning, 1);

      final entry = agent.sidebar.singleWhere((e) => SessionStore.samePath(e.path, firstPath));
      expect(entry.isRunning, isTrue);
      expect(entry.title, 'write a long essay');
      agent.dispose();
    });

    test('a background run that finishes is marked unread until reopened', () async {
      final agent = await startController();
      final first = pis.single..startRun('task A');
      await pumpEventQueue();
      final firstRuntime = agent.active!;
      final firstPath = agent.currentSessionPath!;
      await agent.newSession();

      first.finishRun();
      await pumpEventQueue();
      expect(agent.sidebar.singleWhere((e) => SessionStore.samePath(e.path, firstPath)).hasUnseenResult, isTrue);

      await agent.openSession(firstPath);
      expect(pis, hasLength(2), reason: 'switching back reuses the live process');
      expect(agent.active, same(firstRuntime));
      expect(agent.sidebar.singleWhere((e) => SessionStore.samePath(e.path, firstPath)).hasUnseenResult, isFalse);
      agent.dispose();
    });

    test('opening a stored session switches in place when idle, or starts a process when busy', () async {
      final agent = await startController();
      final stored = p.join(sessions.path, 'stored.jsonl');

      await agent.openSession(stored);
      expect(pis, hasLength(1));
      expect(pis.single.sent('switch_session').single, contains('stored.jsonl'));

      pis.single.startRun('busy');
      await pumpEventQueue();
      final other = p.join(sessions.path, 'other.jsonl');
      await agent.openSession(other);
      expect(pis, hasLength(2));
      expect(pis.last.config.extraArgs, ['--session', other]);
      expect(pis.first.sent('abort'), isEmpty);
      agent.dispose();
    });

    test('idle background processes are closed after the grace period', () async {
      final agent = await startController();
      final first = pis.single..startRun('task');
      await pumpEventQueue();
      final firstRuntime = agent.active!;
      await agent.newSession();
      first.finishRun();
      await pumpEventQueue();

      now = now.add(const Duration(minutes: 4));
      agent.reapIdle();
      expect(agent.runtimes, contains(firstRuntime));

      now = now.add(const Duration(minutes: 2));
      agent.reapIdle();
      expect(agent.runtimes, isNot(contains(firstRuntime)));
      expect(firstRuntime.isDisposed, isTrue);
      agent.dispose();
    });

    test('running background sessions are never closed', () async {
      final agent = await startController();
      pis.single.startRun('task');
      await pumpEventQueue();
      final firstRuntime = agent.active!;
      await agent.newSession();
      now = now.add(const Duration(hours: 1));
      agent.reapIdle();
      expect(agent.runtimes, contains(firstRuntime));
      agent.dispose();
    });
  });
}
