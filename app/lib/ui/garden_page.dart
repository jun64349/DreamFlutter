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
import 'shell_widgets.dart';

class GardenPage extends StatefulWidget {
  const GardenPage({super.key});
  @override
  State<GardenPage> createState() => _GardenPageState();
}

class _GardenPageState extends State<GardenPage> {
  late final Garden _garden;
  String? _selected, _error, _removingKey;
  bool _detailOpen = false, _removing = false;
  String? get _chosenKey => (_garden.entries.where((e) => e.key == _selected).firstOrNull ?? _garden.entries.firstOrNull)?.key;
  @override
  void initState() { super.initState(); _garden = Garden(AgentScope.read(context))..load(); }
  @override
  void dispose() { _garden.dispose(); super.dispose(); }
  Future<void> _act(Future<void> Function() action) async {
    if (mounted) setState(() => _error = null);
    try { await action(); }
    catch(e) { if (mounted) setState(() => _error = SessionRuntime.describeError(e).replaceAll('MCP', '服务').replaceAll('Agent', '它').replaceAll('模板', '技能')); }
  }
  Future<void> _importFolder() async {
    final folder = await getDirectoryPath(confirmButtonText: '导入');
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
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(duration: const Duration(seconds: 5), content: const Text('已删除'), action: SnackBarAction(label: '撤销', onPressed: () => _act(() => _garden.undoRemove(token)))));
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
    final selected = _garden.entries.where((e) => e.key == _selected).firstOrNull ?? _garden.entries.firstOrNull;
    return Align(alignment: Alignment.topCenter, child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 1040), child: Padding(
      padding: EdgeInsets.fromLTRB(bounds.maxWidth < 600 ? 20 : 28, 28, bounds.maxWidth < 600 ? 20 : 28, 20),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [const Expanded(child: PoeticPageTitle('技能')), MenuAnchor(
          builder: (context, controller, _) => FilledButton.icon(onPressed: () => controller.isOpen ? controller.close() : controller.open(), icon: const Icon(Icons.add, size: 18), label: const Text('新建')),
          menuChildren: [MenuItemButton(onPressed: _importFolder, child: const Text('从文件夹导入')), MenuItemButton(onPressed: () => showDialog<void>(context: context, builder: (_) => _ImportLink(garden: _garden)), child: const Text('从链接导入')), MenuItemButton(onPressed: () => _act(_garden.askForSkill), child: const Text('让它帮我做'))],
        )]),
        const SizedBox(height: 26),
        if (_error != null || _garden.error != null) Padding(padding: const EdgeInsets.only(bottom: 16), child: Row(children: [Expanded(child: Text(_error ?? _garden.error!, style: TextStyle(color: context.colors.danger))), TextButton(onPressed: () => _act(_garden.load), child: const Text('重试'))])),
        Expanded(child: _garden.loading ? const Center(child: CircularProgressIndicator()) : wide ? Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(child: _list()), const SizedBox(width: 28), if (selected != null) Expanded(child: _details(selected)),
        ]) : _detailOpen && selected != null ? Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Align(alignment: Alignment.centerLeft, child: IconButton(tooltip: '返回技能列表', onPressed: () => setState(() => _detailOpen = false), icon: const Icon(Icons.arrow_back))), const SizedBox(height: 8), Expanded(child: _details(selected)),
        ]) : _list()),
      ]),
    )));
  }));
  Widget _details(GardenEntry entry) => GardenDetails(entry: entry, garden: _garden, onAction: _act, onRemove: entry.removable && !_removing && !_garden.busy.contains(entry.key) ? () => _remove(entry) : null, onTry: () => _try(entry));
  Widget _list() => ListView(children: [
    _heading('技能'),
    MotionRows(children: [for (final entry in _garden.entries.where((e) => !e.service && e.key != _removingKey)) _row(entry)]),
    if (!_garden.entries.any((e) => !e.service)) ...[
      for (final example in ['帮我找一个整理参考文献的技能', '帮我做一个每周整理实验记录的技能']) Padding(padding: const EdgeInsets.only(bottom: 8), child: OutlinedButton(onPressed: () => _act(() => _garden.askForSkill(example)), child: Text(example))),
    ],
    if (_garden.servicesSeen) ...[_heading('连接的服务'), MotionRows(children: [for (final entry in _garden.entries.where((e) => e.service && e.key != _removingKey)) _row(entry)])],
  ]);
  Widget _heading(String label) => Padding(padding: EdgeInsets.only(top: label == '技能' ? 0 : 28, bottom: 12), child: Text(label, style: context.text.titleSmall?.copyWith(color: context.colors.muted)));
  Widget _row(GardenEntry entry) => Material(key: ValueKey(entry.key), color: _chosenKey == entry.key ? context.colors.accentSoft : Colors.transparent, borderRadius: BorderRadius.circular(context.radius), child: InkWell(onTap: () => _select(entry), borderRadius: BorderRadius.circular(context.radius), child: Padding(padding: const EdgeInsets.fromLTRB(12, 14, 4, 14), child: Row(children: [
    Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(entry.name, style: context.text.titleSmall), if (entry.description.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 5), child: Text(entry.description, maxLines: 2, overflow: TextOverflow.ellipsis, style: context.text.bodySmall?.copyWith(color: context.colors.muted, height: 1.5)))])),
    const SizedBox(width: 12), if (entry.pending) ...[GardenStatus(entry: entry), const SizedBox(width: 4)], MotionSwitch(label: entry.name, value: entry.enabled, onChanged: !entry.editable || _garden.busy.contains(entry.key) ? null : (value) => _act(() => _garden.toggle(entry, value))),
  ]))));
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
