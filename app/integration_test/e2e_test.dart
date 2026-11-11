// v0.8 / T91: nine design flows, production UI + Core + scripted Faux model.
// No channel/key copying, public network, paid model, user data, or real WSL.
// PowerShell (app/): ./tool/test.ps1 integration_test/e2e_test.dart --device-id=windows
import 'dart:io';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/state/preferences.dart';
import 'package:dreamflutter/ui/conversation_cards.dart';
import 'package:dreamflutter/ui/conversation_controls.dart';
import 'package:dreamflutter/ui/garden_page.dart';
import 'package:dreamflutter/ui/memory_details.dart';
import 'package:dreamflutter/ui/motion.dart' show MotionSwitchTile;
import 'package:dreamflutter/ui/sidebar.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'support/t91_harness.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  void scenario(String id,String title,Future<void> Function(WidgetTester,T91Harness) body) {
    testWidgets('T91-$id $title',(tester) async {
      final h=(await tester.runAsync(T91Harness.start))!;
      addTearDown(()=>h.close(tester));
      await h.mount(tester);
      try {await body(tester,h);await h.shot(tester,'${id}_passed');}
      catch(e) {await h.shot(tester,'${id}_failed');rethrow;}
    });
  }
  Finder nav(String text)=>['工作台','蝶君','等你处理','新对话'].contains(text)?find.descendant(of:find.byType(Sidebar),matching:find.text(text)).first:find.byTooltip(text).first;
  Json tool(String name,Json args)=>{'name':name,'arguments':args};
  /// 0.8.1: conversation actions live in the right panel's 常用操作, not a title-bar menu.
  Future<void> menu(WidgetTester tester,T91Harness h,String label) async {if(find.byKey(const ValueKey('panel-actions')).evaluate().isEmpty)await h.tap(tester,find.byTooltip(RegExp('^详情')).first);final b=find.descendant(of:find.byKey(const ValueKey('panel-actions')),matching:find.text(label));await tester.ensureVisible(b);await h.tap(tester,b);}
  String reply(AgentController a)=>a.transcript.items.whereType<AssistantItem>().lastOrNull?.parts.whereType<TextPart>().map((p)=>p.text).join()??'';

  scenario('4.3','工作台开始：工作区、新对话、输入、模型及无痕',(tester,h) async {
    await h.tap(tester,find.byType(SidebarWorkspaceButton));
    await h.tap(tester,find.text(p.basename(h.info['other'] as String)).last);
    expect(h.agent.workspace,h.info['other']);
    await h.tap(tester,find.byType(SidebarWorkspaceButton));
    await h.tap(tester,find.text(p.basename(h.workspace)).last);
    await h.tap(tester,nav('新对话'));
    expect(h.composer,findsOneWidget);expect(find.byTooltip('无痕'),findsOneWidget);expect(find.byKey(const ValueKey('ask-before-acting')),findsOneWidget);
    expect(find.text('标准模式'),findsNothing);expect(find.text('极简模式'),findsNothing);
    h.agent.dropFiles([p.join(h.workspace,'notes.md')]);await h.settle(tester);
    expect(find.textContaining('notes.md'),findsWidgets);
    await h.script([{'tools':[tool('read',{'file_path':'notes.md'})]},{'text':'我看到了实验记录，可以开始整理。'}]);await h.send(tester,'读取附件，告诉我能不能开始整理。');
    expect(reply(h.agent),contains('可以开始整理'));expect(h.agent.currentSessionPath,isNotNull);
    await h.tap(tester,find.byTooltip('无痕'));await h.wait(tester,()=>h.agent.active?.incognito==true);
    await h.script([{'text':'这次只在无痕对话里回答。'}]);await h.send(tester,'只回答这一次。');
    expect(h.agent.currentSessionPath,isNull);expect(h.agent.active!.incognito,true);
  });

  scenario('4.4','过程、允许/拒绝、停止及出错重试',(tester,h) async {
    await h.agent.setApprovalMode(ApprovalMode.changes);
    await h.script([{'tools':[tool('write',{'file_path':'approved.txt','content':'批准后的内容'})]},{'text':'已按允许写入。'}]);
    await h.send(tester,'请写 approved.txt。',finish:false);
    await h.wait(tester,()=>find.byType(ConversationApprovalCard).evaluate().isNotEmpty);
    expect(File(p.join(h.workspace,'approved.txt')).existsSync(),false);
    expect(find.text('拒绝'),findsWidgets);await h.shot(tester,'4.4_approval');
    await h.tap(tester,find.widgetWithText(FilledButton,'允许'));
    await h.wait(tester,()=>!h.agent.isRunning&&reply(h.agent).contains('已按允许'));
    expect(File(p.join(h.workspace,'approved.txt')).readAsStringSync(),'批准后的内容');
    await h.script([{'tools':[tool('write',{'file_path':'rejected.txt','content':'不该出现'})]},{'text':'这次没有写入。'}]);
    await h.send(tester,'尝试写 rejected.txt。',finish:false);
    await h.wait(tester,()=>h.agent.active!.pendingDialogs.isNotEmpty);
    await h.tap(tester,find.widgetWithText(OutlinedButton,'拒绝').last);await h.wait(tester,()=>!h.agent.isRunning);
    expect(File(p.join(h.workspace,'rejected.txt')).existsSync(),false);
    await h.script([{'delayMs':10000,'text':'这段应被停止'}]);await h.send(tester,'慢一点回答。',finish:false);
    await h.wait(tester,()=>h.agent.isRunning);await h.tap(tester,find.byTooltip('停止'));await h.wait(tester,()=>!h.agent.isRunning);
    await h.script([{'error':'T91 模型连接中断，请重试'}]);await h.send(tester,'试一下错误回执。');
    await h.wait(tester,()=>find.byType(ConversationErrorCard).evaluate().isNotEmpty);
    expect(find.text('重试'),findsWidgets);expect(find.byTooltip('发送'),findsOneWidget);
    await h.script([{'text':'重试后恢复。'}]);await h.tap(tester,find.text('重试').last);await h.wait(tester,()=>reply(h.agent).contains('重试后恢复')&&!h.agent.isRunning);
  });

  scenario('4.5','拿结果：回复操作、右栏改动、真实隔离Git提交、上下文和常用操作',(tester,h) async {
    await h.script([{'tools':[tool('read',{'file_path':'report.md'})]},{'tools':[tool('write',{'file_path':'report.md','content':'# 实验小结\n\n三组实验结果一致。\n'})]},{'text':'小结已经完成。'}]);
    await h.send(tester,'将实验记录整理成 report.md。');
    await h.hoverAnswer(tester);
    for(final label in ['复制','重新生成','从这里重来']){expect(find.byTooltip(label),findsWidgets);}
    await h.tap(tester,find.byTooltip(RegExp('^详情')).first);
    expect(find.text('这个对话'),findsWidgets);expect(find.textContaining('report.md'),findsWidgets);
    await h.script([{'text':'整理实验小结'}]);await h.tap(tester,find.text('提交这些改动'));
    await h.wait(tester,()=>find.text('确认提交').evaluate().isNotEmpty);
    final draft=find.byWidgetPredicate((w)=>w is TextField&&w.decoration?.labelText=='提交说明');
    await h.wait(tester,()=>tester.widget<TextField>(draft).enabled==true);
    await tester.enterText(draft,'T91 isolated result');await h.tap(tester,find.text('确认提交'));
    await h.wait(tester,()=>find.textContaining('已提交').evaluate().isNotEmpty);
    expect(asJsonMap(await h.rpc('test.inspect'))['head'],'T91 isolated result');
    await h.tap(tester,find.widgetWithText(TextButton,'关闭').last);
    expect(find.byTooltip('对话菜单'),findsNothing);
    expect(find.byKey(const ValueKey('panel-context')),findsOneWidget);
    for(final text in ['存成技能','导出 Markdown','归档','删除']){expect(find.descendant(of:find.byKey(const ValueKey('panel-actions')),matching:find.text(text)),findsOneWidget);}
  });

  scenario('4.6','选中文字引用与问一下，主对话隔离、带回和侧栏缩进',(tester,h) async {
    await h.script([{'text':'第一段：实验结果需要复测。\n\n第二段：请保留原始数据。'}]);await h.send(tester,'给我两段实验建议。');
    final original=h.agent.currentSessionPath!;final before=File(original).readAsStringSync();
    Future<void> select() async {
      final text=find.textContaining('第一段：实验结果需要复测',findRichText:true).last;await tester.ensureVisible(text);
      final box=tester.getRect(text);final mouse=await tester.startGesture(box.topLeft+const Offset(2,9),kind:PointerDeviceKind.mouse);
      await mouse.moveTo(box.topLeft+const Offset(220,9));await mouse.up();await h.settle(tester);
    }
    await select();await h.tap(tester,find.text('引用').last);expect(find.byType(ComposerQuote),findsOneWidget);
    await h.tap(tester,find.byTooltip('移除引用'));await select();await h.tap(tester,find.text('问一下').last);
    await h.wait(tester,()=>h.agent.sideChat?.isReady==true);
    await h.script([{'text':'复测能排除偶然误差。'}]);
    final input=find.byWidgetPredicate((w)=>w is TextField&&(w.decoration?.hintText??'').startsWith('就这段问点什么'));
    await tester.enterText(input,'为什么需要复测？');await h.tap(tester,find.byTooltip('在问一下里发送'));
    await h.wait(tester,()=>h.agent.sideChat!.items.whereType<AssistantItem>().isNotEmpty&&!h.agent.sideChat!.runtime.isRunning);
    expect(File(original).readAsStringSync(),before);expect(h.agent.sideChat!.runtime.sessionPath,isNotNull);
    await h.tap(tester,find.text('带回去'));expect(find.byType(ComposerQuote),findsOneWidget);
    await h.tap(tester,find.text('关掉'));expect(h.agent.sideChat,isNull);
    await h.agent.refreshSessions();await h.settle(tester);
    expect(h.agent.sidebar.any((entry)=>entry.isSideConversation),true);
  });

  // 0.8.2 (user test): 蝶君 is a conversation. A greeting gets a reply, not a plan; a task starts
  // in the same reply; nothing lands in 等你处理 unless 蝶君 really asks.
  scenario('4.7','蝶君对话：打招呼直接回复，交办直接开工',(tester,h) async {
    await h.tap(tester,nav('蝶君'));await h.wait(tester,()=>h.agent.butterfly?.isReady==true);
    final worker=h.agent.butterfly!;
    await h.script([{'text':'你好，我是蝶君。有什么要交给我的？'}]);
    await h.send(tester,'你好',owner:worker);
    expect(reply(worker),contains('我是蝶君'));
    var attention=asJsonMap(await h.rpc('attention.list'));
    expect((attention['now'] as List).where((row)=>asJsonMap(asJsonMap(row)['origin'])['role']=='butterfly'),isEmpty,reason:'a greeting is not something to approve');
    await h.script([{'text':'我会汇总本周的实验记录：先读记录，再整理结论。'},{'delayMs':300,'text':'任务已经汇总完成。'}]);
    await h.send(tester,'汇总本周的实验记录。',owner:worker);
    await h.wait(tester,()=>!worker.isRunning&&reply(worker).isNotEmpty);
    attention=asJsonMap(await h.rpc('attention.list'));
    expect((attention['now'] as List).where((row)=>asJsonMap(asJsonMap(row)['origin'])['role']=='butterfly'),isEmpty);
    await h.shot(tester,'4.7_conversation');
  });

  scenario('4.8','蝶君缺信息才问、交付、继续修改与定时详情',(tester,h) async {
    await h.tap(tester,nav('蝶君'));await h.wait(tester,()=>h.agent.butterfly?.isReady==true);final worker=h.agent.butterfly!;
    final out=p.join(h.home,'t91-delivery.md');
    await h.script([
      {'tools':[tool('ask_user_question',{'questions':[{'id':'where','question':'资料在哪里？'}]})]},
      {'tools':[tool('write',{'file_path':out,'content':'# 交付小结\n\n三组结果一致。'})]},
      {'text':'已交付实验小结，保留了复测待办。'},
    ]);
    await h.send(tester,'帮我整理那份资料。',finish:false,owner:worker);
    Json? question;
    for(var i=0;i<200&&question==null;i++){
      final now=(asJsonMap(await h.rpc('attention.list'))['now'] as List).map(asJsonMap).where((row)=>row['kind']=='question');
      question=now.firstOrNull;
      if(question==null)await h.settle(tester);
    }
    expect(question,isNotNull,reason:'蝶君 asks only when something it cannot infer is missing');
    await h.shot(tester,'4.8_waiting');
    await h.rpc('attention.resolve',{'id':question!['id'],'action':'answer','response':{'value':'本周的实验记录。'}});
    await h.wait(tester,()=>!worker.isRunning&&reply(worker).contains('已交付'));
    final tasks=(await h.rpc('butterfly.tasks') as List).cast<Map>();expect(tasks.first['status'],'completed');
    expect(File(out).existsSync(),true);
    final path=worker.currentSessionPath;await h.script([{'text':'已在原小结补充下一步复测计划。'}]);await h.send(tester,'在原来的基础上补上复测计划。',owner:worker);expect(worker.currentSessionPath,path);
    // Arrange an existing approved, bound schedule via the real contract.
    // Adopting a new model-proposed schedule belongs to the T88 workflow.
    final schedule=asJsonMap(await h.rpc('schedules.fromSession',{'slotId':worker.active!.slotId,'trigger':{'type':'interval','everyMs':3600000}}));
    expect(schedule['sessionFile'],path);
    await h.shot(tester,'4.8_delivery_and_continue');
    expect(find.byTooltip('详情：任务进度'),findsOneWidget,reason:'T91-P04: removed exchange/work tabs must not hide the task-progress entry');
    await h.tap(tester,find.byTooltip('详情：任务进度'));
    await h.wait(tester,()=>find.textContaining('下次 ').evaluate().isNotEmpty);
    await h.shot(tester,'t93_4.8_details_light');
    await h.agent.setThemeMode(ThemeMode.dark);await h.shot(tester,'t93_4.8_details_dark');
    await h.agent.setThemeMode(ThemeMode.light);
    await h.tap(tester,find.text('暂停').last);expect(((await h.rpc('schedules.list') as List).single as Map)['status'],'paused');
    await h.tap(tester,find.text('删除').last);await h.tap(tester,find.widgetWithText(FilledButton,'删除'));
    expect(await h.rpc('schedules.list'),isEmpty);
  });

  scenario('4.10','统一搜索三类、归档、回收站及恢复',(tester,h) async {
    await h.script([{'tools':[tool('write',{'file_path':'找回实验.md','content':'# 找回实验\n\n保留第二组复测结果。'})]},{'text':'找回实验的结果已经保存。'}]);await h.send(tester,'整理找回实验的记录。');
    await h.rpc('memory.save',{'content':'找回实验要保留原始数据','scope':'workspace','cwd':h.workspace});
    final path=h.agent.currentSessionPath!;
    final search=find.descendant(of:find.byType(Sidebar),matching:find.byWidgetPredicate((w)=>w is TextField&&w.decoration?.hintText=='搜索'));
    await tester.enterText(search,'找回实验');await h.wait(tester,()=>find.text('产物').evaluate().isNotEmpty);
    for(final group in ['对话','产物','记忆']){expect(find.descendant(of:find.byType(Sidebar),matching:find.text(group)),findsWidgets);}
    final results=asJsonMap(await h.rpc('search.all',{'query':'找回实验','cwd':h.workspace}));for(final key in ['conversations','files','memories']){expect(results[key],isNotEmpty);}
    await h.tap(tester,find.byTooltip('清除搜索'));
    await menu(tester,h,'归档');
    await h.wait(tester,()=>h.agent.archivedSessions.any((entry)=>SessionStore.samePath(entry.path,path)));
    // The 「已归档」 note sits over the sidebar's foot for a moment: open the page directly.
    h.agent.showSection(AppSection.settings);await h.settle(tester);await h.tap(tester,find.byKey(const ValueKey('settings-nav-归档/回收')));
    await h.wait(tester,()=>find.text('放回列表').evaluate().isNotEmpty);
    await h.tap(tester,find.text('放回列表').first);
    await h.wait(tester,()=>!h.agent.archivedSessions.any((entry)=>SessionStore.samePath(entry.path,path)));
    h.agent.showSection(AppSection.chat);await h.agent.openSession(path);await h.settle(tester);
    await menu(tester,h,'删除');
    if(find.widgetWithText(FilledButton,'删除').evaluate().isNotEmpty)await h.tap(tester,find.widgetWithText(FilledButton,'删除'));
    await h.wait(tester,()=>!File(path).existsSync());
    h.agent.showSection(AppSection.settings);await h.settle(tester);await h.tap(tester,find.byKey(const ValueKey('settings-nav-归档/回收')));
    await h.wait(tester,()=>find.text('恢复').evaluate().isNotEmpty);await h.tap(tester,find.text('恢复').first);
    await h.wait(tester,()=>File(path).existsSync());
  });

  scenario('4.11','记忆三组、原地编辑、删除撤销、最近与对话纠正回执',(tester,h) async {
    final saved=asJsonMap(await h.rpc('memory.save',{'content':'实验周报每周三发','scope':'workspace','cwd':h.workspace,'kind':'background'}));final item=asJsonMap(saved['item']);
    await h.rpc('memory.save',{'content':'偏好简短回答','scope':'global','kind':'background'});
    await h.tap(tester,nav('记忆'));await h.wait(tester,()=>find.byKey(ValueKey('memory-content-${item['id']}')).evaluate().isNotEmpty);
    for(final group in ['关于你','关于这个项目','蝶君自己的']){expect(find.text(group),findsOneWidget);}
    final input=find.byKey(ValueKey('memory-content-${item['id']}'));
    await tester.enterText(input,'实验周报每周五发');await h.tap(tester,find.text('记下的事'));
    await h.wait(tester,()=>tester.widget<TextField>(input).controller!.text=='实验周报每周五发');
    expect(asJsonMap(asJsonMap(await h.rpc('memory.item',{'id':item['id']}))['item'])['content'],'实验周报每周五发');
    final row=find.ancestor(of:input,matching:find.byType(MemoryEditableEntry));
    await h.tap(tester,find.descendant(of:row,matching:find.byIcon(Icons.delete_outline)));
    await h.tap(tester,find.text('撤销').last);await h.wait(tester,()=>input.evaluate().isNotEmpty);
    await h.tap(tester,find.text('最近'));await h.wait(tester,()=>find.textContaining('实验周报').evaluate().isNotEmpty);
    await h.tap(tester,nav('工作台'));
    await h.script([{'tools':[tool('memory_update',{'id':item['id'],'content':'实验周报每周四发','explicit':true})]},{'text':'已改为每周四发实验周报。'}]);await h.send(tester,'这条不对，我的实验周报每周四发。');
    await h.hoverAnswer(tester);await h.wait(tester,()=>find.text('已更新记忆').evaluate().isNotEmpty);
    final receipts=(await h.rpc('memory.corrections',{'sessionId':h.agent.activeSessionId}) as List).cast<Map>();expect(receipts.single['status'],'applied');
    final receiptRow=find.ancestor(of:find.text('已更新记忆'),matching:find.byType(Row)).first;
    await h.tap(tester,find.descendant(of:receiptRow,matching:find.text('撤销')));
    expect(asJsonMap(asJsonMap(await h.rpc('memory.item',{'id':item['id']}))['item'])['content'],'实验周报每周五发');
  });

  scenario('4.12','蝶园合并技能、服务测试与工具开关、链接待确认及新对话草稿',(tester,h) async {
    final seeded=asJsonMap(await h.rpc('test.library'));
    await h.tap(tester,nav('技能'));await h.wait(tester,()=>find.text('实验周报').evaluate().isNotEmpty);
    expect(find.text('任务模板'),findsNothing);expect(find.text('MCP 服务'),findsNothing);expect(find.text('可用'),findsNothing);expect(find.text('已停用'),findsNothing);
    final list=find.descendant(of:find.byType(GardenPage),matching:find.byType(Scrollable)).first;
    await tester.scrollUntilVisible(find.text('lab-notes'),220,scrollable:list);
    await h.tap(tester,find.text('lab-notes').first);await h.tap(tester,find.text('测试连接'));
    await h.wait(tester,()=>find.text('连接成功').evaluate().isNotEmpty);expect(find.text('read_notes'),findsOneWidget);
    await h.tap(tester,find.text('read_notes'));
    final servers=asJsonMap(await h.rpc('mcp.list',{'cwd':h.workspace}))['servers'] as List;expect((((servers.single as Map)['tools'] as List).single as Map)['enabled'],false);
    final toolTile=find.ancestor(of:find.text('read_notes'),matching:find.byType(MotionSwitchTile));
    final displayedAfterDisable=tester.widget<MotionSwitchTile>(toolTile).value;
    await h.shot(tester,'4.12_tool_after_disable');
    await h.agent.setThemeMode(ThemeMode.dark);await h.shot(tester,'t93_4.12_tool_dark');
    expect(tester.widget<MotionSwitchTile>(toolTile).value,false);
    await h.agent.setThemeMode(ThemeMode.light);
    await h.tap(tester,find.text('read_notes'));
    expect(tester.widget<MotionSwitchTile>(toolTile).value,true);
    final enabledServers=asJsonMap(await h.rpc('mcp.list',{'cwd':h.workspace}))['servers'] as List;
    expect((((enabledServers.single as Map)['tools'] as List).single as Map)['enabled'],true);
    await h.tap(tester,find.text('蝶君能用'));
    expect(((asJsonMap(await h.rpc('mcp.list',{'cwd':h.workspace}))['servers'] as List).single as Map)['butterflyAllowed'],true);
    await h.tap(tester,find.text('新建'));await h.tap(tester,find.text('从链接导入'));
    await tester.enterText(find.byWidgetPredicate((w)=>w is TextField&&w.decoration?.labelText=='链接'),seeded['url'] as String);await h.tap(tester,find.widgetWithText(FilledButton,'导入'));
    await h.wait(tester,()=>find.byType(AlertDialog).evaluate().isEmpty);
    await tester.scrollUntilVisible(find.text('link-check'),-220,scrollable:list);await h.tap(tester,find.text('link-check').first);
    expect(find.text('去等你处理'),findsOneWidget);expect(find.text('采用'),findsNothing);expect(find.text('等你确认'),findsWidgets);
    final imported=(await h.rpc('skills.list',{'cwd':h.workspace}) as List).cast<Map>().firstWhere((row)=>row['name']=='link-check');expect(imported['enabled'],false);expect(imported['trust'],'untrusted');
    await h.rpc('skills.import',{'folder':seeded['folder']});
    expect((await h.rpc('proposals.list',{'status':'pending'}) as List),hasLength(2));
    await h.tap(tester,find.text('新建'));await h.tap(tester,find.text('让它帮我做'));
    expect(h.agent.section,AppSection.chat);expect(h.agent.active!.editorText,'帮我做一个技能：');
    expect(h.agent.active!.isPristine,true);
    await h.script([{'tools':[tool('skill_register',{'name':'agent-check','description':'核对实验引用','content':'---\nname: agent-check\ndescription: 核对实验引用\n---\nCheck references.'})]},{'text':'已准备好技能，等你确认后再启用。'}]);
    await h.send(tester,'帮我做一个核对实验引用的技能。');
    expect((await h.rpc('proposals.list',{'status':'pending'}) as List),hasLength(3));
    expect(displayedAfterDisable,false,reason:'T91-P05: the tool switch must reflect the saved disabled state, not stale connection-test results');
    // The sandbox script trial and adopting the proposal remain explicit T88/WSL boundaries.
  });
}
