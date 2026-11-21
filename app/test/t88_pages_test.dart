import 'package:dreamflutter/main.dart';
import 'package:dreamflutter/state/agent_controller.dart';
import 'package:dreamflutter/ui/attention_page.dart';
import 'package:dreamflutter/ui/settings_controls.dart';
import 'package:dreamflutter/ui/setup_wizard.dart';
import 'package:dreamflutter/ui/spending_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 't88_fixture.dart';

void main(){
  test('attention action labels describe approval, adoption, service and promotion',(){
    expect(attentionActionLabel({'kind':'approval'},'allow'),'允许');
    expect(attentionActionLabel({'kind':'proposal','data':{'proposalKind':'skill'}},'allow'),'采用');
    expect(attentionActionLabel({'kind':'proposal'},'reject'),'不要');
    expect(attentionActionLabel({'kind':'proposal','data':{'proposalKind':'mcp'}},'allow'),'连接');
    expect(attentionActionLabel({'kind':'memory','data':{'why':'promote_global'}},'allow'),'用到所有项目');
    expect(attentionActionLabel({'kind':'memory','data':{'why':'promote_global'}},'reject'),'只留在这个项目');
  });
  late T88Fixture f;
  Future<void> start(WidgetTester t,{Widget? home})async{f=(await t.runAsync(T88Fixture.create))!;await t.binding.setSurfaceSize(const Size(1000,800));addTearDown(()async{await t.pumpWidget(const SizedBox());await t.runAsync(f.dispose);});await t.pumpWidget(DreamFlutterApp(controller:f.agent,home:home));await t.pumpAndSettle();}
  test('money keeps unknown and estimated amounts and currencies distinct',(){expect(spendingAmount([{'requests':2,'amounts':{'USD':.3,'CNY':2},'amountSources':{'price_estimate':1,'missing':1}}]),'\$0.30 / ¥2.00（含估算） · 1 笔金额未知');expect(spendingAmount([{'requests':1,'amounts':{}}]),'未知');expect(spendingAmount([]),'—');});
  testWidgets('attention immediate and delayed actions use backend receipts, undo restores row',(t)async{
    await start(t);f.agent.showSection(AppSection.tasks);await t.pumpAndSettle();expect(find.byType(AttentionPage),findsOneWidget);expect(find.text('现在需要你'),findsOneWidget);expect(find.text('有空看看'),findsOneWidget);
    await t.tap(find.text('允许').first);await t.pump();await t.pump(const Duration(milliseconds:300));expect(find.text('撤销'),findsNothing);expect(f.backend.callsTo('attention.resolve').single['id'],'approval:a');
    await t.tap(find.text('采用'));await t.pump();await t.pump(const Duration(milliseconds:300));expect(find.text('撤销'),findsOneWidget);await t.tap(find.text('撤销'));await t.pumpAndSettle();expect(find.text('采用「整理文献」技能'),findsOneWidget);expect(f.backend.callsTo('attention.undo').length,1);
  });
  testWidgets('attention shows one empty state until a real group has work', (t) async {
    await start(t);
    final item = f.now.single;
    f.now.clear();
    f.later.clear();
    await t.runAsync(f.agent.attention.refresh);
    f.agent.showSection(AppSection.tasks);
    await t.pumpAndSettle();

    final page = find.byType(AttentionPage);
    Finder pageText(String value) => find.descendant(of: page, matching: find.text(value));
    expect(pageText('案头'), findsOneWidget);
    expect(pageText('等你处理'), findsOneWidget);
    expect(pageText('没有待处理的事项'), findsOneWidget);
    expect(pageText('现在需要你'), findsNothing);
    expect(pageText('有空看看'), findsNothing);

    f.now.add(item);
    await t.runAsync(f.agent.attention.refresh);
    await t.pumpAndSettle();
    expect(pageText('没有待处理的事项'), findsNothing);
    expect(pageText('现在需要你'), findsOneWidget);
    expect(pageText('运行项目的检查'), findsOneWidget);
    expect(pageText('有空看看'), findsNothing);
  });
  testWidgets('seven settings groups, search advanced settings, blur save and inline error',(t)async{
    await start(t);f.agent.showSection(AppSection.settings);await t.pumpAndSettle();
    final groups=find.byType(DropdownButtonFormField<String>);
    if(groups.evaluate().isNotEmpty){await t.tap(groups);await t.pumpAndSettle();}
    for(final name in ['通用','模型','工作台','蝶君','记忆','数据与安全','关于与更新']){expect(find.text(name),findsWidgets);}
    await t.tap(find.text('通用').last);await t.pumpAndSettle();
    final nameField=find.descendant(of:find.byKey(const ValueKey('userName')),matching:find.byType(TextField));
    await t.enterText(nameField,'小周');await t.pump();await t.tap(find.widgetWithText(TextField,'搜索设置'));await t.pumpAndSettle();expect(f.backend.settings['userName'],'小周');
    await t.enterText(find.widgetWithText(TextField,'搜索设置'),'记忆频率');await t.pumpAndSettle();expect(find.text('什么时候记'),findsWidgets);
    await t.enterText(find.widgetWithText(TextField,'搜索设置'),'每天花费上限');await t.pumpAndSettle();await t.tap(find.byType(MenuAnchor).last);await t.pumpAndSettle();await t.tap(find.text('自定义…'));await t.pumpAndSettle();await t.enterText(find.descendant(of:find.byType(AutoSaveField),matching:find.byType(TextField)).last,'-1');await t.pump();await t.tap(find.widgetWithText(TextField,'搜索设置'));await t.pumpAndSettle();expect(find.textContaining('请输入有效'),findsOneWidget);
  });
  testWidgets('wizard preserves the name and project folder when going back', (t) async {
    var completed = false;
    await start(t);
    await t.pumpWidget(DreamFlutterApp(controller: f.agent, home: SetupWizard(
      status: {'dataRoot': f.root.path}, initialStep: 2, onComplete: () => completed = true,
    )));
    await t.pumpAndSettle();
    final name = find.widgetWithText(TextField, '称呼');
    final folder = find.widgetWithText(TextField, '文件夹');
    await t.enterText(name, '小周');
    await t.tap(find.text('下一步'));
    await t.pumpAndSettle();
    await t.enterText(folder, f.root.path);
    await t.tap(find.text('上一步'));
    await t.pumpAndSettle();
    expect(t.widget<TextField>(name).controller!.text, '小周');
    await t.tap(find.text('下一步'));
    await t.pumpAndSettle();
    expect(t.widget<TextField>(folder).controller!.text, f.root.path);
    await t.tap(find.text('开始使用'));
    await t.pumpAndSettle();
    expect(completed, isTrue);
    expect(f.backend.callsTo('setup.complete').single, {
      'dataRoot': f.root.path, 'userName': '小周', 'defaultWorkspace': f.root.path,
    });
  });
}
