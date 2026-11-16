import 'dart:io';

import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import '../state/garden.dart';
import '../state/agent_controller.dart';
import '../state/memory_ui.dart';
import '../theme.dart';
import 'common.dart';
import 'motion.dart';
import 'proto_icon.dart';
import 'shell_widgets.dart';

class GardenStatus extends StatelessWidget {
  const GardenStatus({super.key, required this.entry});
  final GardenEntry entry;
  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final generated = !entry.service && entry.enabled && entry.data['sourceKind'] == 'agent';
    final label = generated ? '它整理的' : entry.status;
    final fg = entry.pending ? colors.ochre : generated ? colors.accent : entry.enabled ? colors.success : colors.muted;
    final bg = entry.pending ? fg.withValues(alpha: .18) : generated ? colors.accentSoft : entry.enabled ? fg.withValues(alpha: .13) : colors.sunk;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
      child: Text(label, style: context.text.bodySmall?.copyWith(fontSize: 11, height: 1.6, color: fg)),
    );
  }
}

class GardenDetails extends StatelessWidget {
  const GardenDetails({super.key, required this.entry, required this.garden, required this.onAction, required this.onRemove, required this.onTry});
  final GardenEntry entry;
  final Garden garden;
  final Future<void> Function(Future<void> Function()) onAction;
  final VoidCallback? onRemove;
  final VoidCallback onTry;
  String _origin() => switch(entry.data['sourceKind']) { 'builtin' => '随软件提供', 'agent' => '它整理的', 'community' => '从社区导入', _ => '你添加的' };
  @override
  Widget build(BuildContext context) {
    final busy = garden.busy.contains(entry.key);
    final result = garden.results[entry.key];
    final tools = entry.data['tools'] as List? ?? result?['toolStates'] as List? ?? result?['tools'] as List? ?? const [];
    final filePath=entry.data['filePath'] as String? ?? '';
    final colors = context.colors;
    final toggleAllowed = !busy && entry.editable;
    // .det：card 底、细线、圆角 14；.hd 标题行、.bd 滚动内容、.ft 底部按钮条。
    return Material(
      key: ValueKey('garden-detail-${entry.key}'),
      color:context.colors.card,
      shape:RoundedRectangleBorder(side: BorderSide(color: context.colors.hairline), borderRadius: BorderRadius.circular(14)),
      clipBehavior:Clip.antiAlias,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(padding: const EdgeInsets.fromLTRB(18, 16, 18, 4), child: Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
          Expanded(child: Row(children: [
            Flexible(child: Text(entry.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: context.serif(context.text.titleLarge).copyWith(fontSize: 18))),
            const SizedBox(width: 10),
            GardenStatus(entry: entry),
          ])),
          if (!entry.pending) ...[
            MotionSwitch(label:'启用 ${entry.name}',value:entry.enabled,onChanged:toggleAllowed?(value)=>onAction(()=>garden.toggle(entry,value)):null),
            MenuAnchor(
              builder: (context, controller, _) => IconButton(
                tooltip: '更多',
                style: IconButton.styleFrom(fixedSize: const Size.square(30), minimumSize: const Size.square(30), padding: EdgeInsets.zero, tapTargetSize: MaterialTapTargetSize.shrinkWrap),
                icon: ProtoIcon('more', color: colors.ink2),
                onPressed: () => controller.isOpen ? controller.close() : controller.open(),
              ),
              menuChildren: [
                MenuItemButton(onPressed: toggleAllowed ? () => onAction(() => garden.toggle(entry, !entry.enabled)) : null, child: Text(entry.enabled ? '停用' : '启用')),
              ],
            ),
          ],
        ])),
        Expanded(child:SingleChildScrollView(padding:const EdgeInsets.fromLTRB(18,4,18,14),child:Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (entry.description.isNotEmpty) Padding(padding: const EdgeInsets.only(bottom: 10), child: Text(entry.description, style: context.text.bodyMedium?.copyWith(fontSize: 13.5, color: colors.ink2, height: 1.6))),
          _fact(context, '来源', _origin()),
          if ((entry.data['sourceUrl'] as String? ?? '').isNotEmpty) Padding(padding: const EdgeInsets.only(bottom: 16), child: SelectableText(entry.data['sourceUrl'] as String, style: context.text.bodySmall?.copyWith(color: context.colors.muted))),
          _fact(context, '用过', '${entry.data['usageCount'] ?? 0} 次${entry.data['lastUsedAt'] is num ? ' · 上次 ${formatDate((entry.data['lastUsedAt'] as num).toInt())}' : ''}'),
          if(!entry.service&&!entry.pending&&filePath.isNotEmpty&&p.basename(filePath).toLowerCase()=='skill.md')Padding(padding:const EdgeInsets.only(top:8),child:SkillSourcePreview(path:filePath)),
          if (entry.service) ...[
            const Divider(height:24),
            MotionSwitchTile(title: const Text('蝶君能用'), value: entry.data['butterflyAllowed'] == true, onChanged: busy ? null : (value) => onAction(() => garden.allowButterfly(entry, value))),
            for (final raw in tools) _tool(context, raw, busy),
          ],
          if (result != null) Padding(padding: const EdgeInsets.symmetric(vertical: 12), child: _result(context, result)),
        ]))),
        Divider(height:1,color:colors.hairline),
        Padding(padding:const EdgeInsets.symmetric(horizontal:18,vertical:10),child:entry.pending?Align(alignment:Alignment.centerLeft,child:ShellButton('去等你处理',kind:ShellButtonKind.primary,onPressed:()=>garden.agent.main.showSection(AppSection.tasks))):Wrap(alignment:WrapAlignment.spaceBetween,spacing:8,runSpacing:8,crossAxisAlignment:WrapCrossAlignment.center,children:[
          ShellButton(busy?'正在检查…':entry.service?'测试连接':'试一下',small:true,onPressed:busy?null:onTry),
          ShellButton('删除',kind:ShellButtonKind.ghost,small:true,onPressed:onRemove),
        ])),
      ]),
    );
  }
  Widget _fact(BuildContext context, String label, String value) => Padding(padding: const EdgeInsets.symmetric(vertical: 2), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
    Text(label, style: context.text.bodySmall?.copyWith(fontSize: 12.5, height: 1.6, color: context.colors.muted)),
    const SizedBox(width: 10),
    Expanded(child: Text(value, textAlign: TextAlign.right, style: context.text.bodySmall?.copyWith(fontSize: 12.5, height: 1.6))),
  ]));
  Widget _tool(BuildContext context, Object? raw, bool busy) {
    final tool = raw is Map ? raw.cast<String,dynamic>() : <String,dynamic>{'name': raw.toString()};
    final writes=tool['readOnly']==false||tool['writes']==true||tool['mutating']==true;
    return MotionSwitchTile(title: Text(tool['name'] as String? ?? ''),subtitle:writes?const Text('改东西，先问我'):null, value: tool['enabled'] == true, onChanged: busy || !entry.editable || tool['enabled'] is! bool ? null : (value) => onAction(() => garden.toggleTool(entry, tool['name'] as String, value)));
  }
  Widget _result(BuildContext context, Json result) {
    final errors = [if (result['error'] != null) result['error'], ...result['errors'] as List? ?? []].join('；');
    final trial = memoryMap(result['scriptTrial']);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(entry.service ? result['ok'] == true ? '连接成功' : '连接没成功' : result['ok'] == true ? '检查通过' : '检查没通过', style: TextStyle(color: result['ok'] == true ? context.colors.success : context.colors.danger)),
      if (errors.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text(errors)),
      if (trial['reason'] != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(trial['reason'].toString())),
      for (final warning in result['warnings'] as List? ?? []) Padding(padding: const EdgeInsets.only(top: 8), child: Text(warning.toString())),
    ]);
  }
}

class SkillSourcePreview extends StatefulWidget {
  const SkillSourcePreview({super.key,required this.path});
  final String path;
  @override State<SkillSourcePreview> createState()=>_SkillSourcePreviewState();
}

class _SkillSourcePreviewState extends State<SkillSourcePreview> {
  late Future<({List<String> files,String text})> _source=_load();
  Future<({List<String> files,String text})> _load()async{
    final file=File(widget.path),folder=file.parent;
    final entities=folder.listSync();
    int order(FileSystemEntity entity) => entity.path == file.path ? 0 : entity is Directory ? 1 : 2;
    entities.sort((a,b){final kind=order(a)-order(b);return kind!=0?kind:a.path.toLowerCase().compareTo(b.path.toLowerCase());});
    var text=await file.readAsString();
    if(text.length>40000)text='${text.substring(0,40000)}\n\n……只显示开头';
    return (files:[for(final entity in entities.take(60))'${p.relative(entity.path,from:folder.path)}${FileSystemEntity.isDirectorySync(entity.path)?'/':''}'],text:text);
  }
  @override void didUpdateWidget(SkillSourcePreview old){super.didUpdateWidget(old);if(old.path!=widget.path)_source=_load();}
  @override Widget build(BuildContext context)=>FutureBuilder<({List<String> files,String text})>(future:_source,builder:(context,snapshot){
    if(snapshot.hasError)return Text('暂时读不到这份技能文件',style:context.text.bodySmall?.copyWith(color:context.colors.muted));
    if(!snapshot.hasData)return const SizedBox(height:80,child:Center(child:CircularProgressIndicator()));
    final source=snapshot.data!;
    final colors=context.colors;
    // .files2：左边 160 的等宽文件树（sunk 底），右边衬线预览（card 底）；SKILL.md 是选中行。
    final files=Container(
      height:120,
      color:colors.sunk,
      padding:const EdgeInsets.symmetric(vertical:8),
      child:ListView(children:[
        for(final name in source.files)
          Container(
            color:name=='SKILL.md'?colors.accentSoft:null,
            padding:const EdgeInsets.symmetric(horizontal:10,vertical:3),
            child:Row(children:[
              ProtoIcon(name.endsWith('/')?'folder':'file',size:13,color:colors.muted),
              const SizedBox(width:6),
              Expanded(child:Text(name,maxLines:1,overflow:TextOverflow.ellipsis,style:context.text.bodySmall?.copyWith(fontSize:12.5,fontFamily:AppTokens.monoFamily,fontFamilyFallback:AppTokens.monoFallback))),
            ]),
          ),
      ]),
    );
    final text=Container(
      height:120,
      color:colors.card,
      padding:const EdgeInsets.symmetric(horizontal:14,vertical:10),
      child:SingleChildScrollView(child:SelectableText(source.text,style:context.serif(context.text.bodySmall).copyWith(fontSize:12.5,height:1.75,color:colors.ink2))),
    );
    final panes=LayoutBuilder(builder:(context,c)=>c.maxWidth<500?Column(children:[files,const SizedBox(height:1),text]):IntrinsicHeight(child:Row(crossAxisAlignment:CrossAxisAlignment.stretch,children:[SizedBox(width:160,child:files),VerticalDivider(width:1,thickness:1,color:colors.hairline),Expanded(child:text)])));
    return ClipRRect(borderRadius:BorderRadius.circular(10),child:panes);
  });
}
