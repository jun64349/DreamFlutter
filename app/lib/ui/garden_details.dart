import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';
import '../state/garden.dart';
import '../state/agent_controller.dart';
import '../state/memory_ui.dart';
import '../theme.dart';
import 'common.dart';
import 'motion.dart';

class GardenStatus extends StatelessWidget {
  const GardenStatus({super.key, required this.entry});
  final GardenEntry entry;
  @override
  Widget build(BuildContext context) => entry.pending ? Text('等你确认', style: context.text.bodySmall?.copyWith(color: context.colors.warning)) : const SizedBox.shrink();
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
    return SingleChildScrollView(child: Container(
      key: ValueKey('garden-detail-${entry.key}'), padding: const EdgeInsets.all(22),
      decoration: BoxDecoration(border: Border.all(color: context.colors.border), borderRadius: BorderRadius.circular(context.radius)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Expanded(child: Text(entry.name, style: context.text.titleLarge)), if (entry.pending) ...[const SizedBox(width: 12), GardenStatus(entry: entry)]]),
        if (entry.description.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 10), child: Text(entry.description, style: context.text.bodyMedium?.copyWith(color: context.colors.muted, height: 1.6))),
        const SizedBox(height: 24),
        _fact(context, '来源', _origin()),
        if ((entry.data['sourceUrl'] as String? ?? '').isNotEmpty) Padding(padding: const EdgeInsets.only(bottom: 16), child: SelectableText(entry.data['sourceUrl'] as String, style: context.text.bodySmall?.copyWith(color: context.colors.muted))),
        _fact(context, '用过', '${entry.data['usageCount'] ?? 0} 次'),
        _fact(context, '最后一次', entry.data['lastUsedAt'] == null ? '还没有' : formatDate((entry.data['lastUsedAt'] as num).toInt())),
        if (entry.pending) Align(alignment: Alignment.centerLeft, child: FilledButton(onPressed: () => garden.agent.main.showSection(AppSection.tasks), child: const Text('去等你处理')))
        else ...[
          if (entry.service) ...[
            const Divider(height: 32),
            MotionSwitchTile(title: const Text('蝶君能用'), value: entry.data['butterflyAllowed'] == true, onChanged: busy ? null : (value) => onAction(() => garden.allowButterfly(entry, value))),
            for (final raw in tools) _tool(context, raw, busy),
          ],
          if (result != null) Padding(padding: const EdgeInsets.symmetric(vertical: 16), child: _result(context, result)),
          const SizedBox(height: 12),
          Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
            OutlinedButton(onPressed: busy ? null : onTry, child: Text(busy ? '正在检查…' : entry.service ? '测试连接' : '试一下')),
            TextButton(onPressed: busy || !entry.editable ? null : () => onAction(() => garden.toggle(entry, !entry.enabled)), child: Text(entry.enabled ? '停用' : '启用')),
            TextButton(style: TextButton.styleFrom(foregroundColor: context.colors.danger), onPressed: onRemove, child: const Text('删除')),
          ]),
        ],
      ]),
    ));
  }
  Widget _fact(BuildContext context, String label, String value) => Padding(padding: const EdgeInsets.only(bottom: 14), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [SizedBox(width: 82, child: Text(label, style: context.text.bodySmall?.copyWith(color: context.colors.muted))), Expanded(child: Text(value, style: context.text.bodySmall))]));
  Widget _tool(BuildContext context, Object? raw, bool busy) {
    final tool = raw is Map ? raw.cast<String,dynamic>() : <String,dynamic>{'name': raw.toString()};
    return MotionSwitchTile(title: Text(tool['name'] as String? ?? ''), value: tool['enabled'] == true, onChanged: busy || !entry.editable || tool['enabled'] is! bool ? null : (value) => onAction(() => garden.toggleTool(entry, tool['name'] as String, value)));
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
