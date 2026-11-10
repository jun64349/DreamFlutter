import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/conversation_git.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/ui/conversation_controls.dart';
import 'package:dreamflutter/ui/message_widgets.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../test/fake_backend.dart';

class _PreviewGit implements ConversationGitBridge {
  @override
  Future<ConversationGitState> inspect(String cwd, List<String> changedPaths) async => const ConversationGitState(isRepository: true, head: 'fixture-head', paths: ['report.md'], suggestedMessage: '整理实验结论与下一步验证');
  @override
  Future<ConversationGitState> prepare(String cwd, List<String> paths) => inspect(cwd, paths);
  @override
  Future<String> diff(String cwd, String path) async => '-实验结论待补充\n+已加入三组实验的对比与下一步验证';
  @override
  Future<String> commit(String cwd, {required List<String> paths, required String message, required String? expectedHead, String? expectedFingerprint, List<String>? expectedPaths}) async => throw StateError('视觉测试不会执行提交');
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('T-86 conversation native light dark and scaled states', (tester) async {
    final report = FlutterError.onError;
    FlutterError.onError = (details) { debugPrint(details.toString()); report?.call(details); };
    addTearDown(() => FlutterError.onError = report);
    final root = Directory.systemTemp.createTempSync('df_t86_look_');
    final file = File(p.join(root.path, 'report.md'))..writeAsStringSync('# 实验小结\n\n三组实验结果已完成对比。\n\n下一步验证温度对测量值的影响。');
    final backend = FakeBackend()..sessionRows = [];
    SharedPreferences.setMockInitialValues({'workspace': root.path, 'onboarded': true});
    final now = DateTime.now().millisecondsSinceEpoch;
    final history = <Json>[
      {'role':'user','content':'把今天的实验记录整理成小结，保留结论和下一步。','timestamp':now-15000,'entryId':'question'},
      {'role':'assistant','content':[{'type':'thinking','thinking':'先整理观测数据，再核对结论。'},{'type':'toolCall','id':'read-1','name':'read','arguments':{'path':'notes.md'}}],'timestamp':now-14000,'stopReason':'toolUse','entryId':'read'},
      {'role':'toolResult','toolCallId':'read-1','toolName':'read','content':[{'type':'text','text':'三组数据与实验记录。'}],'isError':false,'timestamp':now-13000},
      {'role':'assistant','content':[{'type':'toolCall','id':'edit-1','name':'edit','arguments':{'path':file.path,'oldText':'实验结论待补充','newText':'已加入三组实验的对比与下一步验证'}}],'timestamp':now-12000,'stopReason':'toolUse','entryId':'edit'},
      {'role':'toolResult','toolCallId':'edit-1','toolName':'edit','content':[{'type':'text','text':'已修改 report.md'}],'isError':false,'timestamp':now-11000},
      {'role':'assistant','content':[{'type':'text','text':'已经整理好了。\n\n## 实验小结\n\n三组实验的测量结果总体一致。第二组在高温时波动稍大，暂时保留为待验证的观察。\n\n下一步会核对温度记录，再补一组对照实验。小结保存在 `report.md`。'}],'timestamp':now-10000,'stopReason':'stop','entryId':'answer','model':'test-model'},
    ];
    backend.onLaunch = (pi) { pi.messages = pi.target.sideQuote == null ? List.of(history) : []; pi.sessionId = 't86-session'; };
    backend.handlers['runs.list'] = (_) => [{'id':'run-1','status':'done','files':[file.path],'startedAt':now-15000,'endedAt':now-10000}];
    backend.handlers['tasks.forSession'] = (_) => {'id':'task-1'};
    backend.handlers['artifacts.list'] = (_) => [{'path':file.path,'exists':true}];
    backend.handlers['memory.corrections'] = (params) => params['entryId'] == 'answer' ? [{'entryId':'answer','status':'applied','batchId':'memory-batch','changes':[{'itemId':'m1','before':{'content':'实验结果只保留结论'},'after':{'content':'实验小结保留结论和下一步'},'undoable':true}]}] : [];
    backend.handlers['memory.snapshots'] = (_) => [{'createdAt':now-16000,'itemVersions':{'m1':1}}];
    backend.handlers['memory.item'] = (_) => {'item':{'version':1,'content':'实验小结保留结论和下一步'}};
    backend.handlers['search.all'] = (_) => {'conversations':[{'title':'今天的实验记录','snippet':'整理【实验】记录','path':'experiment.jsonl'}],'files':[{'title':'report.md','snippet':'三组【实验】结果','path':file.path}],'memories':[{'title':'实验小结保留结论和下一步','id':'m1','target':{'page':'memory','itemId':'m1'}}]};
    backend.handlers['sessions.recycleBin'] = (_) => [{'batchId':'deleted-1','session':{'title':'上周的草稿'}}];
    final agent = AgentController(preferences: await Preferences.load(), backend: backend, sessionStore: SessionStore(sessionsDir: root.path));
    AgentController? guideAgent;
    ConversationGitAdapters.resolve = (_) => _PreviewGit();
    final key = GlobalKey();
    final navigator = GlobalKey<NavigatorState>();
    final shots = Directory(p.join(Directory.current.path, 'build', 't86_shots'))..createSync(recursive:true);
    addTearDown(() async { await tester.pumpWidget(const SizedBox()); ConversationGitAdapters.resolve = null; guideAgent?.dispose(); agent.dispose(); root.deleteSync(recursive:true); });
    Future<void> wait() async {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds:150)));
      for (var i=0;i<6;i++) { await tester.pump(const Duration(milliseconds:100)); }
      expect(tester.takeException(), isNull);
    }
    Future<void> shot(String name) async {
      await wait();
      await tester.runAsync(() async {
        final boundary = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        final image = await boundary.toImage(pixelRatio:1);
        final bytes = await image.toByteData(format:ui.ImageByteFormat.png);
        File(p.join(shots.path,'$name.png')).writeAsBytesSync(bytes!.buffer.asUint8List()); image.dispose();
      });
    }
    await tester.binding.setSurfaceSize(const Size(1400,900));
    await tester.pumpWidget(RepaintBoundary(key:key,child:DreamFlutterApp(controller:agent,navigatorKey:navigator)));
    await tester.runAsync(agent.init);
    await tester.runAsync(() => agent.openSession(p.join(root.path, 'conversation.jsonl'))); await wait();
    var pi = backend.pis.last;
    for (final dark in [false,true]) {
      final color=dark?'dark':'light';
      await agent.setThemeMode(dark?ThemeMode.dark:ThemeMode.light); await agent.setZoom(1);
      await tester.binding.setSurfaceSize(const Size(1400,900));
      agent.setRunPanelOpen(false); await wait();
      final mouse=await tester.createGesture(kind:PointerDeviceKind.mouse); await mouse.addPointer(location:Offset.zero);
      await mouse.moveTo(tester.getCenter(find.textContaining('三组实验的测量结果',findRichText:true).first));
      await shot('reply_$color');
      await tester.tap(find.byTooltip('它参考了哪些记忆').last); await shot('references_$color');
      await tester.tap(find.text('关闭').last); await wait();
      await tester.tap(find.widgetWithText(TextButton,'查看').last); await shot('correction_$color');
      await tester.tap(find.text('关闭').last); await wait();
      agent.quoteInComposer('第二组在高温时波动稍大'); agent.setRunPanelOpen(true); await shot('changes_quote_$color');
      await tester.tap(find.widgetWithText(ListTile,'report.md')); await shot('diff_$color');
      await tester.tap(find.text('关闭').last); await wait();
      await tester.tap(find.text('提交这些改动')); await shot('git_confirm_fixture_$color');
      await tester.tap(find.text('取消').last); await wait();
      // T-90: a modified file is listed only under 改了的文件, so a preview exists only for generated files.
      if (find.byTooltip('预览').evaluate().isNotEmpty) { await tester.tap(find.byTooltip('预览').first); await shot('preview_$color'); await tester.tap(find.text('关闭').last); await wait(); }
      agent.setRunPanelOpen(false); agent.clearComposerQuote(); await wait();
      pi.extraResponses['get_session_stats'] = {'tokens':{'total':176000},'contextUsage':{'tokens':176000,'contextWindow':200000,'percent':88}};
      pi.emit({'type':'session_info_changed'}); await wait(); expect(find.text('上下文已用 88%'),findsOneWidget); await shot('context_warning_$color');
      pi.extraResponses.remove('get_session_stats'); pi.emit({'type':'session_info_changed'}); await wait();
      await tester.tap(find.byTooltip('对话菜单')); await shot('menu_$color');
      await tester.tap(find.text('定时再做一次')); await shot('schedule_$color');
      await tester.tap(find.text('取消').last); await wait();
      final scope = tester.element(find.byType(ChatRowView).last);
      unawaited(showConversationContext(scope)); await shot('context_$color'); await tester.tap(find.text('关闭').last); await wait();
      await tester.enterText(find.byKey(const ValueKey('sidebar-search')),'实验'); await tester.pump(const Duration(milliseconds:350)); await shot('search_$color');
      await tester.tap(find.byTooltip('清除搜索')); await wait();
      await tester.tap(find.text('回收站')); await shot('recycle_$color'); await tester.tap(find.text('关闭').last); await wait();
      // Actual protocol events drive the live states, never a pretend progress timer.
      pi.startRun('再检查一下温度记录。');
      final thinking = <String,dynamic>{'role':'assistant','content':[{'type':'thinking','thinking':'逐项核对温度与测量时间。'}],'timestamp':now+1000};
      pi.emit({'type':'message_start','message':thinking}); await shot('thinking_$color');
      final tool = <String,dynamic>{'role':'assistant','content':[{'type':'toolCall','id':'live-edit','name':'edit','arguments':{'path':file.path,'description':'补充温度记录的核对结果','oldText':'待核对','newText':'温度记录已核对'}}],'timestamp':now+2000};
      pi.emit({'type':'message_end','message':thinking}); pi.emit({'type':'message_start','message':tool}); pi.emit({'type':'message_end','message':tool});
      pi.emit({'type':'tool_execution_start','toolCallId':'live-edit','toolName':'edit','args':tool['content'][0]['arguments']});
      pi.emit({'type':'extension_ui_request','id':'approval-$color','method':'select','title':'Agent 请求执行操作\n\n修改文件：${file.path}','options':['允许','本会话内总是允许「edit」','在此工作区总是允许「edit」','拒绝']});
      await shot('approval_$color');
      final work=find.byType(WorkBlock).last;
      await tester.tap(find.descendant(of:work,matching:find.byType(InkWell)).first); await shot('process_expanded_$color');
      await tester.tap(find.text('拒绝').last); pi.finishRun(); await wait();
      final error={'role':'assistant','content':<Json>[],'timestamp':now+3000,'stopReason':'error','errorMessage':'连接中断，请检查网络后重试。'};
      pi.emit({'type':'message_start','message':error}); pi.emit({'type':'message_end','message':error}); await shot('error_$color');
      await tester.runAsync(() => agent.openSideChat('第二组在高温时波动稍大')); await wait();
      await tester.binding.setSurfaceSize(const Size(1000,800)); await agent.setZoom(1.5); await shot('side_150_$color');
      agent.closeSideChat(); agent.setRunPanelOpen(false); await wait();
      await shot('chat_150_$color');
      await agent.setZoom(1); await tester.binding.setSurfaceSize(const Size(1400,900));
      await tester.runAsync(() => agent.openSideChat('第二组在高温时波动稍大')); await wait();
      final sidePi = backend.pis.last; sidePi.startRun('这说明什么？');
      final sideAnswer = {'role':'assistant','content':[{'type':'text','text':'需要补一组温度一致的对照实验。'}],'timestamp':now+4000,'stopReason':'stop'};
      sidePi.emit({'type':'message_start','message':sideAnswer}); sidePi.emit({'type':'message_end','message':sideAnswer}); sidePi.finishRun(); await wait();
      agent.bringBackSideChat(); agent.closeSideChat(); agent.setRunPanelOpen(false); expect(agent.active!.composerQuote,'需要补一组温度一致的对照实验。'); await shot('returned_quote_$color'); agent.clearComposerQuote();
      // Reload the same recorded conversation so both themes start identically.
      agent.transcript.loadHistory(history.map(AgentMessage.fromJson));
      pi.messages = List.of(history);
      await agent.setRunPanelOpen(true); await agent.setRunPanelOpen(false); await wait();
      await mouse.removePointer();
    }
    // The old first-use guide remains until T-88 replaces it; check its copy too.
    await tester.pumpWidget(const SizedBox());
    SharedPreferences.setMockInitialValues({'workspace':root.path});
    guideAgent = AgentController(preferences:await Preferences.load(),backend:FakeBackend()..sessionRows=[],sessionStore:SessionStore(sessionsDir:root.path));
    await tester.pumpWidget(RepaintBoundary(key:key,child:DreamFlutterApp(controller:guideAgent)));
    await tester.runAsync(guideAgent.init);
    for(final dark in [false,true]) { await guideAgent.setThemeMode(dark?ThemeMode.dark:ThemeMode.light); await shot('first_guide_${dark?'dark':'light'}'); }
  });
}
