import 'dart:async';

import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'package:path/path.dart' as p;

import '../state/agent_controller.dart' show AgentController, asJsonMap, jsonRows;
import 'agent_scope.dart';
import 'backup_panel.dart' show formatBytes;

/// G-07 controls in the existing 数据与迁移 category.
class DataStoragePanel extends StatefulWidget {
  const DataStoragePanel({super.key});

  @override
  State<DataStoragePanel> createState() => _DataStoragePanelState();
}

class _DataStoragePanelState extends State<DataStoragePanel> {
  AgentController? _agent;
  StreamSubscription<Json>? _events;
  final _minimum = TextEditingController();
  Json? _data;
  Json? _locations;
  String? _moveId;
  Timer? _poll;
  bool _polling = false;
  String? _error;
  String? _receipt;
  bool _busy = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final agent = AgentScope.read(context);
    if (agent == _agent) return;
    _agent = agent;
    unawaited(_events?.cancel());
    _events = agent.backend.events.listen((event) {
      if (event['event'] == 'memory.storage' || event['event'] == 'settings.changed') unawaited(_load());
    });
    unawaited(_load());
  }

  @override
  void dispose() {
    unawaited(_events?.cancel());
    _minimum.dispose();
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final data = asJsonMap(await _agent!.backend.call('storage.memory', const {}));
      final locations = asJsonMap(await _agent!.backend.call('storage.locations', const {}));
      if (!mounted) return;
      setState(() {
        _data = data;
        _locations = locations;
        final space = asJsonMap(data['space']);
        _minimum.text = ((space['minimumBytes'] as num? ?? 1073741824) / 1073741824).toStringAsFixed(2);
      });
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  Future<void> _move(Json row) async {
    final destination = await showDialog<String>(context: context, builder: (_) => _MoveLocationDialog(label: '${row['label']}'));
    if (destination == null || !mounted) return;
    if (destination.isEmpty) { setState(() => _error = '请输入目标新目录'); return; }
    await _run(() async {
      final result = asJsonMap(await _agent!.backend.call('storage.move', {'kind': row['id'], 'target': destination}));
      if (!mounted) return;
      setState(() { _moveId = result['id'] as String?; _receipt = '后台正在重启并验证搬迁，请稍候…'; });
      _poll?.cancel();
      _poll = Timer.periodic(const Duration(seconds: 1), (_) => _checkMove());
    });
  }

  Future<void> _checkMove() async {
    if (_polling || !_agent!.backend.isConnected) return;
    _polling = true;
    try {
      final data = asJsonMap(await _agent!.backend.call('storage.locations', const {}, const Duration(seconds: 5)));
      final outcome = asJsonMap(data['lastMove']);
      if (!mounted || outcome['id'] != _moveId) return;
      _poll?.cancel();
      setState(() { _moveId = null; _locations = data; _receipt = outcome['ok'] == true
        ? '搬迁完成，已在新位置启动验证。自动备份：${outcome['backup'] ?? ''}${outcome['warning'] == null ? '' : '\n${outcome['warning']}'}'
        : '搬迁失败，已退回原位置：${outcome['error'] ?? ''}'; });
      await _load();
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally { _polling = false; }
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() { _busy = true; _error = null; _receipt = null; });
    try {
      await action();
    } catch (e) {
      if (mounted) setState(() => _error = e is CoreException ? e.message : '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _saveMinimum() async {
    final gib = double.tryParse(_minimum.text);
    if (gib == null || !gib.isFinite || gib < 0 || gib * 1073741824 > 9007199254740991) {
      setState(() => _error = '请输入有效的非负空间阈值（GiB）');
      return;
    }
    await _run(() async {
      await _agent!.backend.call('settings.update', {'memoryMinFreeBytes': (gib * 1073741824).round()});
      await _load();
      if (mounted) setState(() => _receipt = '空间阈值已保存');
    });
  }

  Future<void> _compact() async {
    final ok = await showDialog<bool>(context: context, builder: (context) => AlertDialog(
      title: const Text('压缩记忆历史？'),
      content: const Text('先自动备份数据库，再压缩一年以上的历史版本，每条记忆保留这些旧版本的首尾两版。最近一年的版本和当前记忆保持不变。'),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
        FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('备份并压缩')),
      ],
    ));
    if (ok != true || !mounted) return;
    await _run(() async {
      final result = asJsonMap(await _agent!.backend.call('storage.compactMemory', const {}, const Duration(minutes: 5)));
      await _load();
      if (mounted) setState(() => _receipt = '已删除 ${result['deleted'] ?? 0} 个旧版本。自动备份：${result['backup'] ?? ''}');
    });
  }

  @override
  Widget build(BuildContext context) {
    final data = _data;
    final space = asJsonMap(data?['space']);
    final path = data?['path'] as String?;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (data != null) ...[
        Text('记忆内容约 ${formatBytes(data['logicalBytes'] as num? ?? 0)} · ${data['versions'] ?? 0} 个历史版本'),
        Text('共用数据库（含其他数据和 WAL）：${formatBytes(data['databaseBytes'] as num? ?? 0)}'),
        if (path != null) SelectableText(path),
        if (space['paused'] == true) Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text(
          space['reason'] as String? ?? '磁盘空间不足，记忆写入已暂停', style: TextStyle(color: Theme.of(context).colorScheme.error))),
        if (space['freeBytes'] is num) Text('磁盘剩余：${formatBytes(space['freeBytes'] as num)}'),
      ],
      const SizedBox(height: 12),
      Wrap(spacing: 12, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
        SizedBox(width: 220, child: TextField(controller: _minimum, enabled: !_busy,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          decoration: const InputDecoration(labelText: '暂停写入阈值（GiB）', helperText: '空间恢复后自动继续'))),
        OutlinedButton(onPressed: _busy ? null : _saveMinimum, child: const Text('保存阈值')),
      ]),
      const SizedBox(height: 12),
      Wrap(spacing: 8, runSpacing: 8, children: [
        OutlinedButton(onPressed: _busy || data == null ? null : _compact, child: const Text('压缩历史…')),
        if (path != null) TextButton(onPressed: () => _agent!.revealInExplorer(p.dirname(path)), child: const Text('打开数据库文件夹')),
        TextButton(onPressed: _busy ? null : _load, child: const Text('刷新占用')),
      ]),
      if (_busy) const LinearProgressIndicator(),
      if (_receipt != null) SelectableText(_receipt!),
      if (_error != null) Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
      if (_locations != null) ...[
        const SizedBox(height: 24),
        Text('数据位置', style: Theme.of(context).textTheme.titleMedium),
        const Text('默认分为应用数据、用户内容和缓存。记忆随整个数据库搬迁；产物位于工作区，随工作区管理。旧安装只在主动搬迁时调整位置。'),
        if (_moveId != null) const LinearProgressIndicator(),
        for (final row in jsonRows(_locations!['rows'])) Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${row['label']} · ${row['layer']} · ${formatBytes(row['bytes'] as num? ?? 0)}'),
          SelectableText('${row['path']}'),
          Wrap(spacing: 8, children: [
            TextButton(onPressed: () => _agent!.revealInExplorer('${row['path']}'), child: const Text('打开文件夹')),
            if (row['movable'] == true) OutlinedButton(onPressed: _busy || _moveId != null ? null : () => _move(row), child: Text('修改${row['label']}位置…')),
          ]),
        ])),
        const Text('记忆：逻辑占用见上方，修改位置请使用“修改后台数据库位置”。'),
        if (jsonRows(_locations!['rows']).where((r) => r['id'] == 'database').firstOrNull case final database?)
          TextButton(onPressed: _busy || _moveId != null ? null : () => _move(database), child: const Text('修改记忆位置（随数据库）…')),
        const SizedBox(height: 12),
        const Text('产物（位于工作区，随工作区管理）'),
        for (final artifact in jsonRows(_locations!['artifacts'])) Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          SelectableText('${artifact['path']} · ${artifact['bytes'] is num ? formatBytes(artifact['bytes'] as num) : '占用未知或文件已移走'}'),
          TextButton(onPressed: () => _agent!.revealInExplorer(p.dirname('${artifact['path']}')), child: const Text('打开文件夹')),
        ])),
        if (_locations!['lastMove'] is Map && _moveId == null) SelectableText(asJsonMap(_locations!['lastMove'])['ok'] == true
          ? '上次搬迁已验证：${asJsonMap(_locations!['lastMove'])['path']}${asJsonMap(_locations!['lastMove'])['warning'] == null ? '' : '\n${asJsonMap(_locations!['lastMove'])['warning']}'}'
          : '上次搬迁失败，已回退：${asJsonMap(_locations!['lastMove'])['error']}'),
      ],
    ]);
  }
}

class _MoveLocationDialog extends StatefulWidget {
  const _MoveLocationDialog({required this.label});
  final String label;
  @override
  State<_MoveLocationDialog> createState() => _MoveLocationDialogState();
}

class _MoveLocationDialogState extends State<_MoveLocationDialog> {
  final _target = TextEditingController();
  @override
  void dispose() { _target.dispose(); super.dispose(); }
  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text('搬迁${widget.label}？'),
    content: SizedBox(width: 480, child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Text('先停止相关任务并自动备份，再复制和校验。后台会重启，在新位置启动验证通过后才清理旧文件；失败退回原位置。'),
      const SizedBox(height: 12),
      TextField(controller: _target, autofocus: true, decoration: const InputDecoration(labelText: '目标新目录（绝对路径）', helperText: '父目录需已存在，目标目录不能已存在', helperMaxLines: 2)),
    ])),
    actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
      FilledButton(onPressed: () => Navigator.pop(context, _target.text.trim()), child: const Text('搬迁并重启'))],
  );
}
