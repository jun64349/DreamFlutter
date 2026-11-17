import 'dart:io';

import 'package:desktop_drop/desktop_drop.dart';
import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import '../state/agent_controller.dart';
import '../state/garden.dart';
import '../state/memory_ui.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'common.dart';
import 'garden_details.dart';
import 'motion.dart';
import 'overlay_panel.dart';
import 'proto_icon.dart';
import 'shell_widgets.dart';
import 'notes.dart';

class GardenPage extends StatefulWidget {
  const GardenPage({super.key,this.additionalSkills,this.onClose});
  final Widget? additionalSkills;
  final VoidCallback? onClose;
  @override
  State<GardenPage> createState() => _GardenPageState();
}

class _GardenPageState extends State<GardenPage> {
  late final Garden _garden;
  String? _selected, _error, _removingKey;
  bool _detailOpen = false, _removing = false, _services = false, _dragging = false;
  List<GardenEntry> get _visible => _garden.entries.where((e)=>e.service==_services||e.pending).toList()..sort((a,b)=>(b.pending?1:0)-(a.pending?1:0));
  GardenEntry? get _chosen {
    final rows=_visible.where((e)=>e.key!=_removingKey).toList();
    return rows.where((e)=>e.key==_selected).firstOrNull??rows.where((e)=>!e.pending).firstOrNull??rows.firstOrNull;
  }
  @override
  void initState() { super.initState(); _garden = Garden(AgentScope.read(context))..load(); }
  @override
  void dispose() { _garden.dispose(); super.dispose(); }
  Future<void> _act(Future<void> Function() action) async {
    if (mounted) setState(() => _error = null);
    try { await action(); }
    catch(e) { if (mounted) setState(() => _error = SessionRuntime.describeError(e).replaceAll('MCP', '服务').replaceAll('Agent', '它').replaceAll('模板', '技能')); }
  }
  Future<void> _importFolder([String? chosen]) async {
    final folder = chosen ?? await getDirectoryPath(confirmButtonText: '导入');
    if (folder != null) await _act(() => _garden.importFolder(folder));
  }
  Future<void> _remove(GardenEntry entry) async {
    if (_removing) return;
    setState(() { _removing = true; _removingKey = entry.key; });
    await Future<void>.delayed(AppTokens.motion(context, AppTokens.medium));
    if (!mounted) return;
    await _act(() async {
      final token = await _garden.remove(entry);
      if (!mounted) return;
      setState(() => _detailOpen = false);
      showNote('已删除', action: '撤销', onAction: () => _act(() => _garden.undoRemove(token)));
    });
    if (mounted) setState(() { _removing = false; _removingKey = null; });
  }
  Future<void> _try(GardenEntry entry) async {
    if (!entry.template) { await _act(() => _garden.test(entry)); return; }
    final params = memoryRows(entry.data['params']);
    final values = params.isEmpty ? <String>[] : await showFieldsDialog(context, title: '试一下 ${entry.name}', confirm: '开始', fields: [for (final param in params) FieldSpec(param['name'] as String, initial: param['default'] as String? ?? '')]);
    if (values == null) return;
    await _act(() => _garden.agent.main.runTemplate(entry.name, {for (var i = 0; i < params.length; i++) params[i]['name'] as String: values[i]}));
  }
  void _select(GardenEntry entry) => setState(() { _selected = entry.key; _detailOpen = true; _error = null; });
  @override
  Widget build(BuildContext context) => AnimatedBuilder(animation: _garden, builder: (context, _) => LayoutBuilder(builder: (context, bounds) {
    final wide = bounds.maxWidth >= 680 * (MediaQuery.textScalerOf(context).scale(14) / 14).clamp(1, 1.5);
    final selected = _chosen;
    // 原型 .fp：底是 --bg；.fp-h 放页签，下面 .ph 是书法标题 + 新建，主体是 .two 双栏。
    return Material(color: context.colors.background, child: Align(alignment: Alignment.topCenter, child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 1000), child: Padding(
      padding: const EdgeInsets.fromLTRB(24, 14, 24, 24),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          _tab('技能', 'skills', false),
          if (_garden.servicesSeen) ...[const SizedBox(width: 6), _tab('连接的服务', 'hub', true)],
          const Spacer(),
          if(widget.onClose!=null)OverlayCloseButton(onClose:widget.onClose!),
        ]),
        const SizedBox(height:16),
        Row(crossAxisAlignment: CrossAxisAlignment.end, children: [Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('百工', style: context.handwriting(context.text.headlineSmall).copyWith(fontSize: 32, height: 1.15, letterSpacing: 1.92)),
          Text('技能和连接的服务', style: context.text.bodySmall?.copyWith(fontSize: 12, height: 1.6, color: context.colors.muted)),
        ])), MenuAnchor(
          builder: (context, controller, _) => TextButton(
            onPressed: () => controller.isOpen ? controller.close() : controller.open(),
            style: TextButton.styleFrom(
              foregroundColor: context.colors.ink, backgroundColor: context.colors.sunk,
              padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 5), minimumSize: const Size(0, 30),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(9)),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              textStyle: context.text.bodySmall?.copyWith(fontSize: 13, height: 1.6),
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              ProtoIcon('plus', size: 13, color: context.colors.ink), const SizedBox(width: 6), const Text('新建'),
            ]),
          ),
          menuChildren: [MenuItemButton(onPressed: _importFolder, child: const Text('从文件夹导入')), MenuItemButton(onPressed: () => showDialog<void>(context: context, builder: (_) => _ImportLink(garden: _garden)), child: const Text('从链接导入')), MenuItemButton(onPressed: () => _act(_garden.askForSkill), child: const Text('让它帮我做'))],
        )]),
        const SizedBox(height:18),
        if (_error != null || _garden.error != null) Padding(padding: const EdgeInsets.only(bottom: 16), child: Row(children: [Expanded(child: Text(_error ?? _garden.error!, style: TextStyle(color: context.colors.danger))), TextButton(onPressed: () => _act(_garden.load), child: const Text('重试'))])),
        Expanded(child: _garden.loading ? const Center(child: CircularProgressIndicator()) : wide ? Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          SizedBox(width:300,child:_list()), const SizedBox(width: 16), if (selected != null) Expanded(child: _details(selected)),
        ]) : _detailOpen && selected != null ? Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Align(alignment: Alignment.centerLeft, child: IconButton(tooltip: '返回技能列表', onPressed: () => setState(() => _detailOpen = false), icon: const Icon(Icons.arrow_back))), const SizedBox(height: 8), Expanded(child: _details(selected)),
        ]) : _list()),
      ]),
    ))));
  }));
  Widget _tab(String label, String icon, bool services) {
    final colors = context.colors;
    final selected = _services == services;
    final fg = selected ? colors.ink : colors.muted;
    return Semantics(selected: selected, child: TextButton(
      onPressed: () => setState(() { _services = services; _selected = null; _detailOpen = false; }),
      style: TextButton.styleFrom(
        foregroundColor: fg, backgroundColor: selected ? colors.card : Colors.transparent,
        side: BorderSide(color: selected ? colors.hairline : Colors.transparent),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(9)),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6), minimumSize: Size.zero,
        visualDensity: VisualDensity.standard, tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        textStyle: context.text.bodySmall?.copyWith(fontSize: 13.5, height: 1.6, fontWeight: selected ? FontWeight.w500 : FontWeight.w400),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [ProtoIcon(icon, size: 15, color: fg), const SizedBox(width: 6), Text(label)]),
    ));
  }
  Widget _details(GardenEntry entry) => GardenDetails(entry: entry, garden: _garden, onAction: _act, onRemove: entry.removable && !_removing && !_garden.busy.contains(entry.key) ? () => _remove(entry) : null, onTry: () => _try(entry));
  Widget _list() {
    final rows=_visible.where((e)=>e.key!=_removingKey).toList();
    final pending=rows.where((e)=>e.pending).toList(),regular=rows.where((e)=>!e.pending).toList();
    return ListView(children: [
      // .drop：虚线框，拖文件夹进来或点选一个。
      if(!_services)DropTarget(
        onDragEntered:(_)=>setState(()=>_dragging=true),
        onDragExited:(_)=>setState(()=>_dragging=false),
        onDragDone:(details){setState(()=>_dragging=false);for(final file in details.files){if(FileSystemEntity.isDirectorySync(file.path)){_importFolder(file.path);break;}}},
        child:Material(
          color:_dragging?context.colors.accentSoft:Colors.transparent,
          borderRadius:BorderRadius.circular(12),
          child:InkWell(
            onTap:_importFolder,
            borderRadius:BorderRadius.circular(12),
            child:CustomPaint(
              painter:_DashedRRect(color:context.colors.border,radius:12),
              child:Padding(
                padding:const EdgeInsets.all(12),
                child:Row(mainAxisAlignment:MainAxisAlignment.center,children:[
                  ProtoIcon('folder',size:14,color:context.colors.muted),
                  const SizedBox(width:4),
                  Flexible(child: Text.rich(TextSpan(text: '把技能文件夹拖进来，或者 ', children: [
                    TextSpan(text: '选一个', style: TextStyle(color: context.colors.accent)),
                  ]), textAlign: TextAlign.center, style:context.text.bodySmall?.copyWith(fontSize:12.5,height:1.6,color:context.colors.muted))),
                ]),
              ),
            ),
          ),
        ),
      ),
      if (!_services) const SizedBox(height: 12),
      if(pending.isNotEmpty)...[_heading('等你确认'),MotionRows(children:[for(final entry in pending)_row(entry)])],
      _heading(_services?'连接的服务':'技能'),
      MotionRows(children: [for (final entry in regular) _row(entry)]),
      if(!_services&&widget.additionalSkills!=null)widget.additionalSkills!,
      if (!_services&&!_garden.entries.any((e) => !e.service)) ...[
        for (final example in ['帮我找一个整理参考文献的技能', '帮我做一个每周整理实验记录的技能']) Padding(padding: const EdgeInsets.only(bottom: 8), child: OutlinedButton(onPressed: () => _act(() => _garden.askForSkill(example)), child: Text(example))),
      ],
      if(_services&&rows.isEmpty)Padding(padding:const EdgeInsets.all(12),child:Text('还没有连接的服务',style:context.text.bodySmall?.copyWith(color:context.colors.muted))),
      if(_services&&rows.isNotEmpty)Container(margin:const EdgeInsets.only(top:10),padding:const EdgeInsets.symmetric(horizontal:12,vertical:10),decoration:BoxDecoration(color:context.colors.sunk,borderRadius:BorderRadius.circular(10)),child:Text('想接别的？在对话里说「帮我接上 Notion」',style:context.text.bodySmall?.copyWith(fontSize:12.5,color:context.colors.muted))),
    ]);
  }
  Widget _heading(String label) => Padding(padding: const EdgeInsets.fromLTRB(10,10,10,4), child: Text(label, style: context.text.bodySmall?.copyWith(fontSize: 11.5, height: 1.6, color: context.colors.muted)));
  Widget _row(GardenEntry entry) {
    final selected = _chosen?.key == entry.key;
    final colors = context.colors;
    return Material(
      key: ValueKey(entry.key),
      color: selected ? colors.accentSoft : Colors.transparent,
      borderRadius: BorderRadius.circular(10),
      clipBehavior: Clip.antiAlias,
      child: InkWell(onTap: () => _select(entry), child: Stack(children: [
        if (selected) Positioned(top: 0, bottom: 0, left: 0, child: ColoredBox(color: colors.accent, child: const SizedBox(width: 2))),
        Padding(padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8), child: Row(children: [
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(entry.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: context.text.bodyMedium?.copyWith(fontSize: 13.5, height: 1.6)),
            if (entry.description.isNotEmpty) Text(entry.description, maxLines: 1, overflow: TextOverflow.ellipsis, style: context.text.bodySmall?.copyWith(fontSize: 12, color: colors.muted, height: 1.6)),
          ])),
          const SizedBox(width: 10),
          GardenStatus(entry: entry),
        ])),
      ])),
    );
  }
}

/// .drop 的 1.5px 虚线圆角框。
class _DashedRRect extends CustomPainter {
  _DashedRRect({required this.color, required this.radius});
  final Color color;
  final double radius;
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()..color = color..style = PaintingStyle.stroke..strokeWidth = 1.5;
    final rect = Offset.zero & size;
    final rrect = RRect.fromRectAndRadius(rect.deflate(0.75), Radius.circular(radius));
    final path = Path()..addRRect(rrect);
    // 沿圆角矩形按 5 实 4 虚画线。
    for (final metric in path.computeMetrics()) {
      var distance = 0.0;
      while (distance < metric.length) {
        final next = distance + 5;
        canvas.drawPath(metric.extractPath(distance, next.clamp(0, metric.length)), paint);
        distance = next + 4;
      }
    }
  }
  @override
  bool shouldRepaint(_DashedRRect old) => old.color != color || old.radius != radius;
}

class _ImportLink extends StatefulWidget {
  const _ImportLink({required this.garden});
  final Garden garden;
  @override
  State<_ImportLink> createState() => _ImportLinkState();
}
class _ImportLinkState extends State<_ImportLink> {
  final _url = TextEditingController();
  String? _error;
  bool _busy = false;
  @override
  void dispose() { _url.dispose(); super.dispose(); }
  Future<void> _import() async {
    final value = _url.text.trim(), uri = Uri.tryParse(_url.text.trim());
    if (uri == null || !['http','https'].contains(uri.scheme) || uri.host.isEmpty) { setState(() => _error = '请填完整的网页链接'); return; }
    setState(() { _busy = true; _error = null; });
    try { await widget.garden.importUrl(value); if (mounted) Navigator.pop(context); }
    catch(e) { if (mounted) setState(() { _busy = false; _error = '没有导入：${SessionRuntime.describeError(e)}'; }); }
  }
  @override
  Widget build(BuildContext context) => PopScope(canPop: !_busy, child: AlertDialog(title: const Text('从链接导入'), content: SizedBox(width: 480, child: Column(mainAxisSize: MainAxisSize.min, children: [TextField(controller: _url, autofocus: true, enabled: !_busy, decoration: InputDecoration(labelText: '链接', errorText: _error)), if (_busy) const Padding(padding: EdgeInsets.only(top: 16), child: LinearProgressIndicator())])), actions: [TextButton(onPressed: _busy ? null : () => Navigator.pop(context), child: const Text('取消')), FilledButton(onPressed: _busy ? null : _import, child: const Text('导入'))]));
}
