import 'dart:io';

import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/ui/message_widgets.dart' show ChatRow, QuestionRow, ReplyRow;
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';
import 'fake_pi.dart';

void main() {
  late FakeBackend backend;
  late List<FakePi> pis;
  late Directory sessions;
  late DateTime now;

  Future<AgentController> startController({bool runtimeAvailable = true, Map<String, Object> prefs = const {}}) async {
    SharedPreferences.setMockInitialValues({'workspace': Directory.systemTemp.path, ...prefs});
    backend.available = runtimeAvailable;
    pis = backend.pis;
    final controller = AgentController(
      preferences: await Preferences.load(),
      sessionStore: SessionStore(sessionsDir: sessions.path),
      backend: backend,
      clock: () => now,
    );
    await controller.init();
    return controller;
  }

  setUp(() {
    backend = FakeBackend();
    now = DateTime(2026, 10, 27, 12);
    sessions = Directory.systemTemp.createTempSync('df_sessions_');
  });
  tearDown(() => sessions.deleteSync(recursive: true));

  group('single session', () {
    test('starts ready, loads models and moves v0.1.0 settings to the core once', () async {
      final agent = await startController(prefs: {'approvalMode': 'all', 'modelKey': 'p/m', 'thinkingLevel': 'high'});
      expect(agent.status, ConnectionStatus.ready);
      expect(agent.models, isNotEmpty);
      expect(agent.thinkingLevels, contains('high'));
      expect(pis.single.sent('set_model'), isEmpty, reason: 'the core applies the default model');
      final migrated = backend.callsTo('settings.update').single;
      expect(migrated, {'approvalMode': 'all', 'autoCompaction': true, 'defaultModel': 'p/m', 'defaultThinking': 'high'});
      expect(agent.approvalMode, ApprovalMode.all);
      expect(agent.defaultModelKey, 'p/m');
      expect(agent.preferences.migratedToCore, isTrue);
      agent.dispose();
    });

    test('choosing a model makes it the default for new sessions', () async {
      final agent = await startController();
      await agent.selectModel(agent.models.first);
      expect(pis.single.sent('set_model'), hasLength(1));
      await pumpEventQueue();
      expect(backend.callsTo('settings.update').last, {'defaultModel': agent.models.first.key});
      agent.dispose();
    });

    test('thinking levels follow the model after a switch, not only the ones from startup (extra test 1, 2)', () async {
      final agent = await startController();
      final pi = pis.single;
      // The session started before any channel existed: only 「关闭」.
      pi.extraResponses['get_available_thinking_levels'] = {'levels': ['off']};
      await agent.selectModel(agent.models.first);
      expect(agent.thinkingLevels, ['off']);
      pi.extraResponses['get_available_thinking_levels'] = {'levels': ['low', 'high', 'max']};
      await agent.selectModel(agent.models.first);
      expect(agent.thinkingLevels, ['low', 'high', 'max']);
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

    test('context usage refreshes after each turn of a long run, not only at the end', () async {
      final agent = await startController();
      final pi = pis.single..startRun('long task');
      await pumpEventQueue();
      final before = pi.sent('get_session_stats').length;
      pi.emit({'type': 'turn_end', 'message': {}, 'toolResults': []});
      await pumpEventQueue();
      expect(agent.isRunning, isTrue);
      expect(pi.sent('get_session_stats').length, before + 1);
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
      expect(agent.statusDetail, contains('后台被关闭'));
      agent.dispose();
    });

    test('a missing core is reported instead of crashing', () async {
      final agent = await startController(runtimeAvailable: false);
      expect(agent.status, ConnectionStatus.missingRuntime);
      expect(agent.statusDetail, contains('无法启动后台服务'));
      agent.dispose();
    });

    test('when the core connection drops, sessions reopen after reconnecting', () async {
      final agent = await startController();
      final pi = pis.single
        ..startRun('hello')
        ..finishRun();
      await pumpEventQueue();
      final path = agent.currentSessionPath!;
      File(path)
        ..createSync(recursive: true)
        ..writeAsStringSync('{}');
      backend.dropConnection();
      await pumpEventQueue(times: 50);
      expect(pi.target.sessionPath, isNull);
      expect(pis, hasLength(2));
      expect(pis.last.target.sessionPath, path, reason: 'reopened from disk in the new core');
      expect(agent.status, ConnectionStatus.ready);
      expect(agent.backendProblem, isNull);
      agent.dispose();
    });

    test('after reconnecting, channels are read from the new core (first-start move, restore)', () async {
      final agent = await startController();
      await pumpEventQueue();
      expect(agent.gatewayChannels, isEmpty);
      backend.handlers['gateway.channels'] = (_) => [
            {'id': 'c1', 'name': 'OpenCode Go', 'provider': 'df-c1', 'kind': 'plan', 'enabled': true, 'models': const [], 'keys': const []},
          ];
      backend.dropConnection();
      await pumpEventQueue(times: 50);
      expect(agent.gatewayChannels.map((c) => c.name), ['OpenCode Go']);
      agent.dispose();
    });

    test('session relocation updates local discovery and reopens the existing tab from the new root', () async {
      final before = p.join(sessions.path, 'before');
      final after = p.join(sessions.path, 'after');
      Directory(before).createSync(); Directory(after).createSync();
      final oldPath = p.join(before, 'kept.jsonl');
      final newPath = p.join(after, 'kept.jsonl');
      File(oldPath).writeAsStringSync('{}');
      backend.sessionsDir = before;
      backend.onLaunch = (pi) => pi.sessionFile = oldPath;
      final agent = await startController();
      expect(agent.sessionStore.sessionsDir, before);
      expect(agent.currentSessionPath, oldPath);
      File(oldPath).renameSync(newPath);
      backend.sessionsDir = after;
      backend.onLaunch = (pi) => pi.sessionFile = pi.target.sessionPath ?? newPath;
      backend.dropConnection();
      await pumpEventQueue(times: 50);
      expect(agent.sessionStore.sessionsDir, after);
      expect(pis.last.target.sessionPath, newPath);
      expect(agent.currentSessionPath, newPath);
      expect(agent.status, ConnectionStatus.ready);
      agent.dispose();
    });

    test('sessions still running in the core are attached on startup', () async {
      backend = FakeBackend(liveSlots: [
        {'slotId': 'bg-1', 'cwd': Directory.systemTemp.path, 'running': true},
        {'slotId': 'sched', 'cwd': Directory.systemTemp.path, 'unattended': true},
        {'slotId': 'side', 'cwd': Directory.systemTemp.path, 'incognito': true, 'forkOf': p.join(sessions.path, 'a.jsonl')},
      ]);
      final agent = await startController();
      expect(pis.first.target.attachSlotId, 'bg-1');
      expect(pis.where((p) => p.target.attachSlotId == 'sched'), isEmpty, reason: 'scheduled runs are not window sessions');
      expect(pis.where((p) => p.target.attachSlotId == 'side'), isEmpty, reason: 'a side conversation is not a conversation of the list (e2e 1b)');
      expect(agent.runtimes.map((r) => r.slotId), contains('bg-1'));
      agent.dispose();
    });

    test('interrupted runs can be resumed or dismissed', () async {
      final file = File(p.join(sessions.path, 'old.jsonl'))..writeAsStringSync('{}');
      backend = FakeBackend(interruptedRuns: [
        {'id': 'r1', 'sessionFile': file.path, 'cwd': Directory.systemTemp.path, 'prompt': '写报告', 'startedAt': 0},
        {'id': 'r2', 'sessionFile': file.path, 'cwd': Directory.systemTemp.path, 'prompt': null, 'startedAt': 0},
      ]);
      final agent = await startController();
      expect(agent.interruptedRuns.map((r) => r.id), ['r1', 'r2']);
      await agent.dismissInterrupted(agent.interruptedRuns.last);
      expect(backend.callsTo('runs.acknowledge').single, {'id': 'r2'});
      await agent.resumeInterrupted(agent.interruptedRuns.single);
      expect(agent.interruptedRuns, isEmpty);
      expect(agent.currentSessionPath, file.path);
      expect(pis.last.commands.lastWhere((c) => c['type'] == 'prompt')['message'], contains('中断'));
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

    test('approval mode is a core setting', () async {
      final agent = await startController();
      await agent.setApprovalMode(ApprovalMode.all);
      expect(backend.callsTo('settings.update').last, {'approvalMode': 'all'});
      expect(agent.approvalMode, ApprovalMode.all);
      agent.dispose();
    });

    test('deleting a session closes it in the core first', () async {
      final agent = await startController();
      pis.single
        ..startRun('doomed')
        ..finishRun();
      await pumpEventQueue();
      final slot = pis.single.slotId;
      await agent.deleteSession(agent.currentSessionPath!);
      expect(backend.callsTo('slot.close').single, {'slotId': slot});
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
      expect(pis.last.target.sessionPath, other);
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

  group('v0.1.1 session management', () {
    Json row(String name, {bool pinned = false, bool archived = false, int modified = 0}) => {
      'path': p.join(sessions.path, '$name.jsonl'),
      'cwd': Directory.systemTemp.path,
      'title': name,
      'modifiedAt': modified,
      'createdAt': 0,
      'pinned': pinned,
      'archived': archived,
    };

    test('the sidebar comes from the core index, with pinned and archived sessions', () async {
      backend.sessionRows = [row('old-pinned', pinned: true, modified: 1), row('recent', modified: 5), row('done', archived: true)];
      final agent = await startController();
      await agent.refreshSessions();
      final entries = agent.sidebar;
      expect(entries.map((e) => e.title), containsAll(['old-pinned', 'recent']));
      expect(entries.where((e) => e.title == 'done'), isEmpty, reason: 'archived sessions are listed separately');
      expect(entries.singleWhere((e) => e.title == 'old-pinned').pinned, isTrue);
      expect(agent.archivedSessions.single.title, 'done');

      await agent.setPinned(entries.singleWhere((e) => e.title == 'recent').path, true);
      expect(backend.callsTo('sessions.setPinned').single['pinned'], isTrue);
      agent.dispose();
    });

    // 0.8.2 user test 4: opening an older conversation moved it to the top. The list is ordered by
    // the last message; opening one is not a message.
    test('opening a conversation does not move it in the list; sending does', () async {
      backend.sessionRows = [row('older', modified: DateTime(2026, 10, 26).millisecondsSinceEpoch), row('recent', modified: DateTime(2026, 10, 27, 9).millisecondsSinceEpoch)];
      final agent = await startController();
      await agent.refreshSessions();
      List<String> order() => [for (final e in agent.sidebar) if (e.path.endsWith('older.jsonl') || e.path.endsWith('recent.jsonl')) p.basename(e.path)];
      expect(order(), ['recent.jsonl', 'older.jsonl']);
      now = DateTime(2026, 10, 27, 12, 30);
      await agent.openSession(p.join(sessions.path, 'older.jsonl'));
      expect(order(), ['recent.jsonl', 'older.jsonl'], reason: 'opening is not a message');
      await agent.send('接着说');
      expect(order(), ['older.jsonl', 'recent.jsonl'], reason: 'a message is');
      agent.dispose();
    });

    test('search results come from the core', () async {
      backend.searchHits = [
        {'path': p.join(sessions.path, 'a.jsonl'), 'cwd': Directory.systemTemp.path, 'title': '季度报告', 'role': 'user', 'snippet': '写【季度报告】'},
      ];
      final agent = await startController();
      final hits = await agent.searchSessions('季度报告');
      expect(hits.single.title, '季度报告');
      expect(backend.callsTo('sessions.search').single['query'], '季度报告');
      agent.dispose();
    });

    test('edited messages show versions and can be switched in place', () async {
      final agent = await startController();
      final pi = pis.single
        ..messages = [
          {'role': 'user', 'content': 'first', 'timestamp': 1},
          {'role': 'user', 'content': 'second v2', 'timestamp': 2},
        ]
        ..branches = [
          {'entryId': 'u1', 'index': 0, 'total': 1, 'targets': <String>[]},
          {'entryId': 'u2b', 'index': 1, 'total': 2, 'targets': ['leaf-a', 'leaf-b']},
        ];
      pi
        ..startRun('x')
        ..finishRun();
      await pumpEventQueue();
      agent.active!.transcript.loadHistory(pi.messages.map(AgentMessage.fromJson));
      final users = agent.transcript.items.whereType<UserItem>().toList();
      expect(agent.active!.branchFor(users.first)!.total, 1);
      final second = agent.active!.branchFor(users.last)!;
      expect((second.index, second.total), (1, 2));

      await agent.switchVersion(users.last, 0);
      expect(pi.commands.lastWhere((c) => c['type'] == 'df_navigate_tree')['entryId'], 'leaf-a');

      pi.navigateText = 'second v2';
      await agent.editMessage(agent.transcript.items.whereType<UserItem>().last);
      expect(pi.commands.lastWhere((c) => c['type'] == 'df_navigate_tree')['entryId'], 'u2b');
      expect(agent.active!.editorText, 'second v2');
      agent.dispose();
    });

    test('a reply is every assistant message between two questions', () {
      final transcript = Transcript()
        ..loadHistory(
          [
            {'role': 'user', 'content': 'q1', 'timestamp': 1},
            {'role': 'assistant', 'content': [{'type': 'text', 'text': 'step'}], 'timestamp': 2},
            {'role': 'assistant', 'content': [{'type': 'text', 'text': 'answer 1'}], 'timestamp': 3},
            {'role': 'user', 'content': 'q2', 'timestamp': 4},
            {'role': 'assistant', 'content': [{'type': 'text', 'text': 'answer 2'}], 'timestamp': 5},
          ].map(AgentMessage.fromJson),
        );
      final items = transcript.items;
      final users = items.whereType<UserItem>().toList();
      final rows = ChatRow.fromItems(items);
      expect(rows.map((r) => r.runtimeType), [QuestionRow, ReplyRow, QuestionRow, ReplyRow]);
      final first = rows[1] as ReplyRow;
      expect(first.assistants, hasLength(2));
      expect(first.info.text, 'step\n\nanswer 1');
      expect((first.info.question, first.info.nextQuestion), (users[0], users[1]));
      expect(first.info.isLatest, isFalse);
      final last = rows[3] as ReplyRow;
      expect((last.info.question, last.info.isLatest), (users[1], true));
    });

    test('forking from a reply keeps the conversation up to that reply', () async {
      final agent = await startController();
      final pi = pis.single;
      pi.messages = [
        {'role': 'user', 'content': 'first', 'timestamp': 1},
        {'role': 'user', 'content': 'second', 'timestamp': 2},
      ];
      agent.transcript.loadHistory(pi.messages.map(AgentMessage.fromJson));
      final second = agent.transcript.items.whereType<UserItem>().last;

      await agent.forkAfterReply(second);
      expect(pi.commands.lastWhere((c) => c['type'] == 'fork')['entryId'], 'e1', reason: 'forks before the next question');
      expect(agent.active!.editorText, isEmpty, reason: 'the next question is not put back');

      await agent.forkAfterReply(null);
      expect(pi.sent('clone'), hasLength(1), reason: 'the last reply duplicates the session');
      agent.dispose();
    });

    test('regenerating with another model switches the model first', () async {
      final agent = await startController();
      final pi = pis.single
        ..messages = [
          {'role': 'user', 'content': 'question', 'timestamp': 1},
        ]
        ..branches = [
          {'entryId': 'u1', 'index': 0, 'total': 1, 'targets': <String>[]},
        ]
        ..navigateText = 'question';
      pi
        ..startRun('x')
        ..finishRun();
      await pumpEventQueue();
      agent.active!.transcript.loadHistory(pi.messages.map(AgentMessage.fromJson));
      final question = agent.transcript.items.whereType<UserItem>().single;
      final other = agent.models.firstWhere((m) => m != agent.model);
      final before = pi.commands.length;

      await agent.regenerate(question, model: other);
      final types = pi.commands.skip(before).map((c) => c['type']).toList();
      expect(types.indexOf('set_model'), lessThan(types.indexOf('df_navigate_tree')));
      expect(pi.commands.lastWhere((c) => c['type'] == 'set_model')['modelId'], other.id);
      expect(pi.commands.last['type'], 'prompt');
      expect(pi.commands.last['message'], 'question');
      agent.dispose();
    });

    test('a temporary chat is never reused as the blank session', () async {
      final agent = await startController();
      await agent.newTemporarySession();
      expect(pis.last.target.incognito, isTrue);
      expect(agent.active!.incognito, isTrue);
      expect(agent.sidebar.where((e) => e.isActive).single.incognito, isTrue);
      await agent.newSession();
      expect(agent.active!.incognito, isFalse, reason: 'new session leaves the temporary chat');
      agent.dispose();
    });

    test('无痕 is minimal mode, and picking a mode from it starts a saved session (0.4)', () async {
      final agent = await startController();
      await agent.newTemporarySession();
      expect(pis.last.target.agentMode, 'minimal');
      final count = pis.length;
      await agent.selectAgentMode('minimal');
      expect(pis.length, count + 1, reason: 'already minimal, but 无痕 is not saved: a new session');
      expect(pis.last.target.incognito, isFalse);
      expect(pis.last.target.agentMode, 'minimal');
      expect(agent.active!.incognito, isFalse);
      agent.dispose();
    });
  });
}
