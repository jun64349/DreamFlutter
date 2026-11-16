import 'dart:async';
import 'dart:io';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart' show AgentController, asJsonMap;
import '../theme.dart';
import 'agent_scope.dart';
import 'settings_controls.dart' show SettingRow;
import 'settings_layout.dart' show V1Inset;
import 'shell_widgets.dart' show ShellButton;

@visibleForTesting
Future<String?> Function() chooseSecurityAuditDestination = () async =>
    (await getSaveLocation(suggestedName: 'security-audit.jsonl', confirmButtonText: '保存审计'))?.path;

/// User-owned exceptions and local audit in the existing security category.
class SecurityPanel extends StatefulWidget {
  const SecurityPanel({super.key});

  @override
  State<SecurityPanel> createState() => _SecurityPanelState();
}

class _SecurityPanelState extends State<SecurityPanel> {
  AgentController? _agent;
  String? _workspace;
  final _path = TextEditingController();
  List<String> _paths = [];
  List<Json> _events = [];
  bool _busy = false;
  bool _loaded = false;
  String? _error;
  String? _receipt;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final agent = AgentScope.of(context);
    if (_agent == agent && _workspace == agent.workspace) return;
    _agent = agent;
    _workspace = agent.workspace;
    unawaited(_run(_load));
  }

  @override
  void dispose() { _path.dispose(); super.dispose(); }

  Future<void> _run(Future<void> Function() action) async {
    setState(() { _busy = true; _error = null; _receipt = null; });
    try { await action(); }
    catch (error) { if (mounted) setState(() => _error = error is CoreException ? error.message : '$error'); }
    finally { if (mounted) setState(() => _busy = false); }
  }

  Future<void> _load() async {
    final cwd = _workspace;
    if (cwd == null || cwd.isEmpty) { setState(() { _loaded = true; _paths = []; }); return; }
    final paths = asJsonMap(await _agent!.backend.call('security.exceptions', {'cwd': cwd}));
    final audit = asJsonMap(await _agent!.backend.call('security.audit', {'limit': 50}));
    if (!mounted || _workspace != cwd) return;
    setState(() {
      _paths = (paths['paths'] as List? ?? []).cast<String>();
      _events = (audit['events'] as List? ?? []).map(asJsonMap).toList();
      _loaded = true;
    });
  }

  Future<void> _add() async {
    final path = _path.text.trim();
    if (path.isEmpty) { setState(() => _error = '请填写要允许的文件或目录路径'); return; }
    await _run(() async {
      await _agent!.backend.call('security.addException', {'cwd': _workspace, 'path': path});
      _path.clear();
      await _load();
      if (mounted) setState(() => _receipt = '工作区例外已保存');
    });
  }

  Future<void> _export() async {
    await _run(() async {
      final location = await chooseSecurityAuditDestination();
      if (location == null || !mounted) return;
      final result = asJsonMap(await _agent!.backend.call('security.export', const {}));
      await File(location).writeAsString(result['text'] as String? ?? '');
      if (mounted) setState(() => _receipt = '审计已导出：$location');
    });
  }

  // 原型「敏感路径」卡里的两行：路径例外（内嵌框里一条一行，下面加一条）和操作记录（导出、刷新，最近记录可展开）。
  // 卡片的内边距由外面的 SettingsCard 给，这里不再加一层。
  @override
  Widget build(BuildContext context) {
    final workspaceReady = _workspace?.isNotEmpty == true;
    final colors = context.colors;
    final muted = context.text.bodySmall?.copyWith(fontSize: 12.5, color: colors.muted);
    final mono = TextStyle(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback, fontSize: 12.5, color: colors.ink);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      SettingRow('路径例外', desc: workspaceReady ? '这个工作区里可以直接读写的位置' : '先选一个工作区', child: const SizedBox.shrink()),
      V1Inset(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (_loaded && _paths.isEmpty) const Padding(padding: EdgeInsets.symmetric(vertical: 2), child: Text('还没有例外')),
        for (final path in _paths) Row(children: [
          Expanded(child: SelectableText(path, style: mono)),
          IconButton(tooltip: '删除路径例外', visualDensity: VisualDensity.compact, onPressed: _busy ? null : () => _run(() async {
            await _agent!.backend.call('security.removeException', {'cwd': _workspace, 'path': path});
            await _load();
          }), icon: Icon(Icons.close, size: 15, color: colors.muted)),
        ]),
      ])),
      Padding(padding: const EdgeInsets.only(top: 8, bottom: 12), child: Row(children: [
        Expanded(child: TextField(
          controller: _path,
          enabled: !_busy && workspaceReady,
          style: mono,
          decoration: InputDecoration(isDense: true, hintText: '允许的文件或文件夹', hintStyle: muted, filled: true, fillColor: colors.sunk, contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10), border: OutlineInputBorder(borderRadius: BorderRadius.circular(9), borderSide: BorderSide.none)),
          onSubmitted: _busy || !workspaceReady ? null : (_) => _add(),
        )),
        const SizedBox(width: 8),
        ShellButton('添加', small: true, onPressed: _busy || !workspaceReady ? null : _add),
      ])),
      Divider(height: 1, thickness: 0.5, color: colors.border),
      SettingRow('操作记录', desc: _loaded && _events.isEmpty ? '暂无安全审计记录' : '每次读写敏感位置都记一笔', child: Row(mainAxisSize: MainAxisSize.min, children: [
        IconButton(tooltip: '刷新记录', visualDensity: VisualDensity.compact, onPressed: _busy ? null : () => _run(_load), icon: Icon(Icons.refresh, size: 16, color: colors.muted)),
        const SizedBox(width: 4),
        ShellButton('导出审计…', small: true, onPressed: _busy ? null : _export),
      ])),
      if (_events.isNotEmpty) Theme(
        data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
        child: ExpansionTile(
          tilePadding: EdgeInsets.zero,
          shape: const Border(),
          collapsedShape: const Border(),
          iconColor: colors.muted,
          collapsedIconColor: colors.muted,
          title: Text('最近 ${_events.length} 条记录', style: context.text.bodyMedium?.copyWith(fontSize: 13.5, color: colors.ink2)),
          children: [
            for (final event in _events) Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: V1Inset(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('${event['kind']} · ${event['decision']}', style: context.text.bodyMedium?.copyWith(fontSize: 13.5, color: colors.ink)),
                const SizedBox(height: 2),
                SelectableText('${DateTime.fromMillisecondsSinceEpoch((event['time'] as num? ?? 0).toInt()).toLocal()} · ${event['policy']}\n${event['object']}\n${event['reason']}\n运行/请求：${event['runId'] ?? event['requestId'] ?? event['slotId'] ?? '设置操作'}', style: muted),
              ])),
            ),
          ],
        ),
      ),
      if (_busy) LinearProgressIndicator(semanticsLabel: '正在处理安全设置', color: colors.accent, backgroundColor: colors.sunk),
      if (_receipt != null) Padding(padding: const EdgeInsets.only(bottom: 10), child: SelectableText(_receipt!, style: muted)),
      if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 10), child: Text(_error!, style: TextStyle(color: colors.danger))),
    ]);
  }
}
