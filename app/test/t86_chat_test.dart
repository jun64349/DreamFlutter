import 'dart:async';
import 'dart:io';

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/conversation_git.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/theme.dart';
import 'package:dreamflutter/ui/agent_scope.dart';
import 'package:dreamflutter/ui/chat_view.dart';
import 'package:dreamflutter/ui/conversation_actions.dart';
import 'package:dreamflutter/ui/conversation_cards.dart' show ConversationPresence;
import 'package:dreamflutter/ui/conversation_controls.dart';
import 'package:dreamflutter/ui/conversation_memory.dart';
import 'package:dreamflutter/ui/run_summary.dart';
import 'package:dreamflutter/ui/message_widgets.dart' show ChatRowView, WorkBlock;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_backend.dart';

class TestGitBridge implements ConversationGitBridge {
  final commits = <Json>[];
  bool fail = false;
  @override
  Future<ConversationGitState> inspect(String cwd, List<String> paths) async => const ConversationGitState(isRepository: true, head: 'before', paths: ['report.md'], suggestedMessage: '整理报告');
  @override
  Future<ConversationGitState> prepare(String cwd, List<String> paths) => inspect(cwd, paths);
  @override
  Future<String> diff(String cwd, String path) async => '-旧内容\n+新内容';
  @override
  Future<String> commit(String cwd, {required List<String> paths, required String message, required String? expectedHead, String? expectedFingerprint, List<String>? expectedPaths}) async {
    commits.add({'cwd': cwd, 'paths': paths, 'message': message, 'head': expectedHead});
    if (fail) throw StateError('文件已变化，请重新检查');
    return 'abcdef1';
  }
}

void main() {
  late Directory root;
  late FakeBackend backend;
  late AgentController agent;
  Future<void> start(WidgetTester tester, {Widget? child}) async {
    await tester.binding.setSurfaceSize(const Size(1400, 900));
    root = Directory.systemTemp.createTempSync('df_t86_');
    SharedPreferences.setMockInitialValues({'workspace': root.path, 'onboarded': true});
    backend = FakeBackend()..butterflyHome = '${root.path}/butterfly'..sessionRows = [];
    agent = AgentController(preferences: await tester.runAsync(Preferences.load) as Preferences, backend: backend, sessionStore: SessionStore(sessionsDir: root.path));
    await tester.pumpWidget(DreamFlutterApp(controller: agent));
    await tester.runAsync(agent.init);
    await tester.pumpAndSettle();
  }
  Future<void> settle(WidgetTester tester) async {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 40)));
    await tester.pumpAndSettle();
  }
  Future<void> mount(WidgetTester tester, Widget child, {AgentController? owner}) async {
    await tester.pumpWidget(AgentScope(controller: owner ?? agent, child: MaterialApp(theme: buildTheme(Brightness.light), home: Scaffold(body: child))));
    await tester.pumpAndSettle();
  }
  tearDown(() { ConversationGitAdapters.resolve = null; agent.dispose(); root.deleteSync(recursive: true); });

  testWidgets('optional ChatView builders receive the scoped controller and preserve composer and close behavior', (tester) async {
    await start(tester);
    AgentController? emptyOwner, panelOwner;
    agent.setRunPanelOpen(true);
    await mount(tester, ChatView(
      emptyStateBuilder: (_, owner) { emptyOwner = owner; return const Center(child: Text('自定义首页')); },
      detailsPanelBuilder: (_, owner) { panelOwner = owner; return TextButton(onPressed: () => owner.setRunPanelOpen(false), child: const Text('自定义右栏')); },
    ));
    expect(emptyOwner, same(agent)); expect(panelOwner, same(agent));
    expect(find.text('自定义首页'), findsOneWidget); expect(find.byType(ComposerQuote), findsNothing);
    expect(find.byWidgetPredicate((w) => w is TextField && w.decoration?.hintText == '说点什么…'), findsOneWidget);
    await tester.tap(find.text('自定义右栏')); await settle(tester);
    expect(find.text('自定义右栏'), findsNothing);
    final butterfly = (await tester.runAsync(agent.ensureButterfly))!;
    await mount(tester, ChatView(emptyStateBuilder: (_, owner) { emptyOwner = owner; return const Text('蝶君首页'); }), owner: butterfly);
    expect(emptyOwner, same(butterfly)); expect(find.text('蝶君首页'), findsOneWidget);
  });

  testWidgets('default ChatView keeps the workbench body and details', (tester) async {
    await start(tester); agent.setRunPanelOpen(true);
    await mount(tester, const ChatView());
    expect(find.byType(RunPanel), findsOneWidget); expect(find.text('这个对话'), findsOneWidget);
    expect(find.text('标准模式'), findsNothing); expect(find.text('下一条作为新任务'), findsNothing);
    expect(find.text('先问我'), findsOneWidget);
    expect(find.text('提交这些改动'), findsNothing, reason:'no invented Git RPC or repository state');
  });

  testWidgets('composer and side panel fit at 1000 by 800 and 150 percent', (tester) async {
    await start(tester);
    await tester.runAsync(() => agent.openSideChat('需要核对的一段文字')); await settle(tester);
    await tester.binding.setSurfaceSize(const Size(1000,800)); await agent.setZoom(1.5); await settle(tester);
    expect(tester.takeException(), isNull);
    agent.closeSideChat(); await settle(tester);
    expect(tester.takeException(), isNull);
  });

  testWidgets('0.8.1: no title-bar menu; the ring opens the right panel with context and common actions', (tester) async {
    await start(tester); final pi=backend.pis.single;
    pi.extraResponses['get_session_stats'] = {'tokens':{'total':70000,'input':12000,'output':3000,'cacheRead':55000},'cost':0.004,'contextUsage':{'tokens':62000,'contextWindow':1000000,'percent':6.2}};
    pi..startRun('整理报告')..finishRun(); pi.emit({'type':'session_info_changed'}); await settle(tester);
    expect(find.byTooltip('对话菜单'), findsNothing);
    await tester.tap(find.byKey(const ValueKey('context-ring'))); await settle(tester);
    expect(agent.runPanelOpen, isTrue); expect(find.text('这个对话'), findsOneWidget);
    expect(find.text('6.2 万 / 100 万'), findsOneWidget); expect(find.text('缓存命中'), findsOneWidget); expect(find.text('82%'), findsOneWidget);
    final labels=['存成技能','导出 Markdown','归档','删除'];
    for (final label in labels) { expect(find.descendant(of: find.byKey(const ValueKey('panel-actions')), matching: find.text(label)), findsOneWidget); }
    for (final gone in ['定时再做一次','这段对话不记忆']) { expect(find.text(gone), findsNothing); }
    await tester.tap(find.byKey(const ValueKey('panel-compact'))); await settle(tester);
    expect(pi.commands.any((c)=>c['type']=='compact'), isTrue);
  });

  testWidgets('error card retries the actual question and composer can send again', (tester) async {
    await start(tester); final pi=backend.pis.single;
    pi.startRun('核对实验记录');
    final error={'role':'assistant','content':<Json>[],'timestamp':2,'stopReason':'error','errorMessage':'连接中断，请重试'};
    pi.emit({'type':'message_start','message':error}); pi.emit({'type':'message_end','message':error}); pi.finishRun(); await settle(tester);
    expect(find.text('连接中断，请重试'), findsOneWidget); expect(find.text('去设置'), findsOneWidget);
    await tester.enterText(find.byWidgetPredicate((w)=>w is TextField && w.decoration?.hintText=='说点什么…'),'补充信息'); await tester.pump();
    expect(tester.widget<IconButton>(find.byWidgetPredicate((w)=>w is IconButton && w.tooltip=='发送')).onPressed, isNotNull);
    await tester.tap(find.text('重试')); await settle(tester);
    expect(pi.commands.lastWhere((c)=>c['type']=='prompt')['message'], '核对实验记录');
  });

  testWidgets('0.8.1: a timeout says so in plain words, and a retry that recovers leaves no error card behind', (tester) async {
    await start(tester); final pi=backend.pis.single;
    pi.startRun('整理资料');
    final error={'role':'assistant','content':<Json>[],'timestamp':2,'stopReason':'error','errorMessage':'Request timed out.','model':'deepseek-v4.1-flash'};
    pi.emit({'type':'message_start','message':error}); pi.emit({'type':'message_end','message':error});
    pi.emit({'type':'auto_retry_start','attempt':1,'maxAttempts':5,'delayMs':1000,'errorMessage':'Request timed out.'}); for (var i=0;i<5;i++) { await tester.pump(const Duration(milliseconds: 100)); }
    expect(find.text('这次没能完成'), findsNothing, reason: 'no card while the automatic retry is still running');
    final ok={'role':'assistant','content':[{'type':'text','text':'整理好了。'}],'timestamp':3,'stopReason':'stop'};
    pi.emit({'type':'message_start','message':ok}); pi.emit({'type':'message_end','message':ok});
    pi.emit({'type':'auto_retry_end','success':true}); pi.finishRun(); await settle(tester);
    expect(find.text('这次没能完成'), findsNothing); expect(find.textContaining('正在重试'), findsNothing); expect(find.text('整理好了。'), findsOneWidget);
    pi.startRun('再整理一次');
    pi.emit({'type':'message_start','message':error}); pi.emit({'type':'message_end','message':error}); pi.finishRun(); await settle(tester);
    expect(find.text('这次没能完成'), findsOneWidget); expect(find.text('模型太久没有回应，这次请求超时了'), findsOneWidget);
    expect(find.text('Request timed out.'), findsOneWidget, reason: 'the original message stays under the plain words');
    final heights={for (final label in ['重试','换个模型','去设置']) tester.getSize(find.ancestor(of: find.text(label), matching: find.byWidgetPredicate((w)=>w is ButtonStyleButton)).first).height};
    expect(heights.toSet(), hasLength(1), reason: 'the three buttons are one size: $heights');
  });

  testWidgets('0.8.1 C.3: what the model says between tool calls goes into the process chain, not the reply', (tester) async {
    await start(tester); final pi=backend.pis.single;
    pi.startRun('整理这个文件夹');
    final step={'role':'assistant','content':[{'type':'text','text':'我先看一下目录。'},{'type':'toolCall','id':'t1','name':'ls','arguments':{'path':'.'}}],'timestamp':2,'stopReason':'toolUse'};
    pi.emit({'type':'message_start','message':step}); pi.emit({'type':'message_end','message':step});
    pi.emit({'type':'tool_execution_start','toolCallId':'t1','toolName':'ls','args':{'path':'.'}});
    pi.emit({'type':'tool_execution_end','toolCallId':'t1','toolName':'ls','result':{'content':[{'type':'text','text':'a.md'}]},'isError':false});
    final done={'role':'assistant','content':[{'type':'text','text':'整理好了，一共 1 个文件。'}],'timestamp':3,'stopReason':'stop'};
    pi.emit({'type':'message_start','message':done}); pi.emit({'type':'message_end','message':done}); pi.finishRun(); await settle(tester);
    expect(find.text('整理好了，一共 1 个文件。'), findsOneWidget);
    expect(find.text('我先看一下目录。'), findsNothing, reason: 'the narration is inside the collapsed chain');
    await tester.tap(find.descendant(of: find.byType(WorkBlock), matching: find.byType(InkWell)).first); await settle(tester);
    expect(find.text('我先看一下目录。'), findsOneWidget);
  });

  testWidgets('quote card preserves typed text and sends real quoted content', (tester) async {
    await start(tester);
    final input = find.byWidgetPredicate((w) => w is TextField && w.decoration?.hintText == '说点什么…');
    await tester.enterText(input, '请解释'); agent.quoteInComposer('结论 A'); await settle(tester);
    expect(tester.widget<TextField>(input).controller!.text, '请解释'); expect(find.byType(ComposerQuote), findsOneWidget);
    await tester.tap(find.byTooltip('发送')); await settle(tester);
    final message = backend.pis.single.commands.lastWhere((c) => c['type'] == 'prompt')['message'];
    expect(message, contains('> 结论 A')); expect(message, contains('请解释')); expect(agent.active!.composerQuote, isNull);
  });

  testWidgets('unified search groups real results and discards a response after clear', (tester) async {
    await start(tester);
    final delayed = Completer<Object?>();
    backend.handlers['search.all'] = (_) => delayed.future;
    final input = find.byKey(const ValueKey('sidebar-search'));
    expect(find.byTooltip('清除搜索'), findsNothing);
    await tester.enterText(input, '旧查询'); await tester.pump(const Duration(milliseconds: 350));
    await tester.tap(find.byTooltip('清除搜索')); await tester.pump();
    delayed.complete({'conversations': [{'title': '过期结果'}]}); await settle(tester);
    expect(find.text('过期结果'), findsNothing); expect(find.byTooltip('清除搜索'), findsNothing);
    backend.handlers['search.all'] = (_) => {'conversations': [{'title': '报告对话', 'path': 'report.jsonl', 'snippet': '【报告】'}], 'files': [{'title': '报告.md', 'path': 'report.md'}], 'memories': [{'id': 'm1', 'title': '报告偏好', 'target': {'itemId': 'm1', 'page': 'memory'}}]};
    await tester.enterText(input, '报告'); await tester.pump(const Duration(milliseconds: 350)); await settle(tester);
    for (final title in ['对话','产物','记忆','报告对话','报告.md','报告偏好']) { expect(find.text(title), findsWidgets); }
    expect(backend.callsTo('search.all').last, {'query': '报告', 'cwd': root.path});
    await tester.tap(find.text('报告偏好')); await settle(tester);
    expect(agent.section, AppSection.memory);
  });

  testWidgets('deleting asks first, then goes to the recycle bin, and recycle restore sends the owning batch', (tester) async {
    await start(tester);
    backend.handlers['sessions.delete'] = (_) => {'deleted': true, 'batchId': 'batch-1'};
    await mount(tester, Builder(builder: (context) => TextButton(onPressed: () => deleteConversation(context, agent, 'old.jsonl', title: '旧报告'), child: const Text('删除测试'))));
    await tester.tap(find.text('删除测试')); await settle(tester);
    expect(find.text('删除「旧报告」？'), findsOneWidget);
    await tester.tap(find.text('取消')); await settle(tester);
    expect(backend.callsTo('sessions.delete'), isEmpty);
    await tester.tap(find.text('删除测试')); await settle(tester);
    await tester.tap(find.widgetWithText(FilledButton, '删除')); await settle(tester);
    expect(backend.callsTo('sessions.delete').single['path'], 'old.jsonl');
    expect(find.text('已移到回收站'), findsOneWidget);
    backend.handlers['sessions.recycleBin'] = (_) => [{'batchId': 'batch-2', 'session': {'title': '已删除的报告'}}];
    await mount(tester, Builder(builder: (context) => TextButton(onPressed: () => showConversationRecycleBin(context), child: const Text('打开回收站'))));
    await tester.tap(find.text('打开回收站')); await settle(tester);
    await tester.tap(find.text('恢复')); await settle(tester);
    expect(backend.callsTo('sessions.restore').last['batchId'], 'batch-2');
  });

  testWidgets('a persisted search target scrolls a long scaled conversation to the matching entry', (tester) async {
    await start(tester);
    final history=<Json>[
      for(var i=0;i<30;i++) ...[
        {'role':'user','content': i==0?'目标问题':'后续问题 $i','timestamp':i*2+1,'entryId':'q-$i'},
        {'role':'assistant','content':[{'type':'text','text': List.filled(5,'第 $i 次回复，保留阅读位置与上下文。').join('\n\n')}],'stopReason':'stop','timestamp':i*2+2,'entryId':'a-$i'},
      ],
    ];
    backend.pis.single.messages=history;
    agent.transcript.loadHistory(history.map(AgentMessage.fromJson));
    await tester.runAsync(agent.active!.refreshEntryIds);
    await agent.setZoom(1.25); agent.setRunPanelOpen(false); await settle(tester);
    final list=find.byKey(const ValueKey('conversation-list'));
    final position=tester.state<ScrollableState>(find.descendant(of:list,matching:find.byType(Scrollable)).first).position;
    expect(position.maxScrollExtent,greaterThan(position.viewportDimension*3),reason:'the fixture must require real scrolling');
    expect(position.pixels,closeTo(position.maxScrollExtent,2),reason:'a newly opened conversation starts at its end');
    final viewport=tester.getRect(list);
    Finder target() => find.descendant(of:find.byType(ChatRowView), matching:find.text('目标问题'));
    // The title bar and sidebar legitimately repeat the first question. A lazy
    // row may also stay built in the cache: construction is not visibility.
    bool targetVisible() => target().evaluate().isNotEmpty && tester.getRect(target()).overlaps(viewport);
    expect(targetVisible(),isFalse,reason:'the target message must start outside the viewport');
    agent.entryTarget.value='q-0'; await tester.pumpAndSettle();
    expect(target(), findsOneWidget);
    expect(position.pixels,lessThan(position.viewportDimension),reason:'the jump must move away from the end to the persisted first entry');
    expect(viewport.contains(tester.getCenter(target())),isTrue,reason:'the message itself, not its title, must be visible at 125 percent');
  });

  testWidgets('historical memory references use the version before this reply', (tester) async {
    await start(tester); backend.pis.single.sessionId = 'session-memory';
    await tester.runAsync(agent.active!.refreshEntryIds);
    backend.handlers['memory.snapshots'] = (_) => [{'createdAt': 500, 'itemVersions': {'m1': 2}}, {'createdAt': 2000, 'itemVersions': {'m1': 3}}];
    backend.handlers['memory.item'] = (_) => {'item': {'version': 3, 'content': '今天的内容'}, 'versions': [{'version': 2, 'item': {'content': '当时的内容'}}]};
    final reply = AssistantItem('historical')..timestamp = 1000;
    final rows = await tester.runAsync(() => replyMemoryReferences(agent, [reply]));
    expect(rows!.map((row) => row['content']), ['当时的内容']);
  });

  testWidgets('memory correction receipt belongs to this reply, pending stays hidden and undo conflict stays visible', (tester) async {
    await start(tester);
    backend.handlers['memory.corrections'] = (_) => [
      {'entryId':'answer-1','status':'applied','batchId':'correct-batch','changes':[{'before':{'content':'旧内容'},'after':{'content':'更正后的内容'},'undoable':true}]},
      {'entryId':'another-answer','status':'applied','batchId':'wrong-batch','changes':[]},
      {'entryId':'answer-1','status':'pending','batchId':null,'changes':[]},
    ];
    backend.handlers['memory.undoBatch'] = (_) => {'batchId':null,'undone':[],'conflicts':[{'itemId':'m1','reason':'这条记忆之后又改过，没有覆盖'}]};
    await mount(tester, ReplyMemoryCorrections(replies:[AssistantItem('answer')..entryId='answer-1'])); await settle(tester);
    expect(find.text('已更新记忆'), findsOneWidget);
    await tester.tap(find.text('查看')); await settle(tester);
    expect(find.text('旧内容'), findsOneWidget); expect(find.text('更正后的内容'), findsOneWidget);
    await tester.tap(find.text('关闭')); await settle(tester);
    await tester.tap(find.text('撤销')); await settle(tester);
    expect(backend.callsTo('memory.undoBatch').single['batchId'], 'correct-batch');
    expect(find.textContaining('不能撤销'), findsOneWidget); expect(find.text('已更新记忆'), findsOneWidget);
    backend.handlers['memory.undoBatch'] = (_) => {'batchId':'undo-1','undone':['op-1'],'conflicts':[]};
    await tester.tap(find.text('撤销')); await settle(tester);
    expect(find.text('已更新记忆'), findsNothing);
  });

  testWidgets('Git never commits until confirmation and keeps the prepared head and selected paths', (tester) async {
    await start(tester); final bridge = TestGitBridge(); final prepared = await bridge.inspect(root.path, []);
    await mount(tester, ConversationCommitEditor(bridge: bridge, prepared: prepared, cwd: root.path));
    expect(bridge.commits, isEmpty);
    await tester.enterText(find.byType(TextField), '修改后的说明');
    await tester.tap(find.text('确认提交')); await settle(tester);
    expect(bridge.commits.single, {'cwd': root.path, 'paths': ['report.md'], 'message': '修改后的说明', 'head': 'before'});
    expect(find.text('已提交 abcdef1'), findsOneWidget);
  });

  testWidgets('Git error keeps editable confirmation and never claims success', (tester) async {
    await start(tester); final bridge = TestGitBridge()..fail = true;
    await mount(tester, ConversationCommitEditor(bridge: bridge, prepared: await bridge.inspect(root.path, []), cwd: root.path));
    await tester.tap(find.text('确认提交')); await settle(tester);
    expect(find.textContaining('文件已变化'), findsOneWidget); expect(find.textContaining('已提交'), findsNothing);
    expect(find.byType(TextField), findsOneWidget);
  });

  testWidgets('presence reports the viewed slot, another page and loss of foreground without repeats', (tester) async {
    await start(tester); agent.reportConversationPresence();
    expect(backend.callsTo('notifications.presence').last['slotId'], agent.active!.slotId);
    final count = backend.callsTo('notifications.presence').length;
    agent.reportConversationPresence(); expect(backend.callsTo('notifications.presence').length, count);
    agent.showSection(AppSection.memory); await settle(tester);
    expect(backend.callsTo('notifications.presence').last['slotId'], isNull);
    agent.setWindowFocused(false); expect(backend.callsTo('notifications.presence').last['foreground'], false);
  });

  testWidgets("0.8.3: the big butterfly folds away at the first words; a small one stays at the reply's start", (tester) async {
    await start(tester); final pi=backend.pis.single;
    Future<void> pumps() async { for (var i=0;i<6;i++) { await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5))); await tester.pump(const Duration(milliseconds: 100)); } }
    double markOpacity() => tester.widget<AnimatedOpacity>(find.ancestor(of: find.byKey(const ValueKey('reply-mark')), matching: find.byType(AnimatedOpacity)).first).opacity;
    pi.startRun('你是谁');
    final empty={'role':'assistant','content':<Json>[],'timestamp':2,'stopReason':'pending'};
    pi.emit({'type':'message_start','message':empty}); await pumps();
    expect(find.byType(ConversationPresence), findsOneWidget, reason: 'before the first words the big butterfly stands in for the reply');
    expect(markOpacity(), 0);
    pi.emit({'type':'message_update','assistantMessageEvent':{'type':'text_start','contentIndex':0}});
    pi.emit({'type':'message_update','assistantMessageEvent':{'type':'text_delta','contentIndex':0,'delta':'我是蝶君里的助手。'}}); await pumps();
    expect(find.textContaining('我是蝶君里的助手', findRichText: true), findsWidgets, reason: 'the words arrived');
    await pumps(); // the fold takes a moment after the words arrive
    expect(find.byType(ConversationPresence), findsNothing, reason: 'it folds away once the reply has words');
    expect(markOpacity(), 1, reason: "and the small butterfly sits at the reply's start");
    final done={'role':'assistant','content':[{'type':'text','text':'我是蝶君里的助手。'}],'timestamp':3,'stopReason':'stop'};
    pi.emit({'type':'message_end','message':done}); pi.finishRun(); await settle(tester);
    expect(find.byKey(const ValueKey('reply-mark')), findsOneWidget, reason: 'it stays when the reply is done, like an avatar');
    expect(markOpacity(), 1);
  });
  testWidgets('0.8.3: a long message you sent is folded to ten lines and opens with a click', (tester) async {
    await start(tester); final pi=backend.pis.single;
    final long=List.generate(30, (i)=>'第 ${i+1} 行，这是一段很长的输入。').join('\n');
    pi.startRun(long); pi.finishRun(); await settle(tester);
    Text bubble() => tester.widget<Text>(find.descendant(of: find.byKey(const ValueKey('conversation-list')), matching: find.textContaining('第 1 行')));
    expect(find.text('展开全文'), findsOneWidget);
    expect(bubble().maxLines, 10);
    await tester.tap(find.text('展开全文')); await settle(tester);
    expect(find.text('收起'), findsOneWidget);
    expect(bubble().maxLines, isNull);
    await tester.tap(find.text('收起')); await settle(tester);
    expect(bubble().maxLines, 10);
    pi.startRun('短的一句'); pi.finishRun(); await settle(tester);
    expect(find.text('展开全文'), findsOneWidget, reason: 'the short one has no 展开全文 of its own');
  });
}
