import 'dart:async';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'common.dart' show showsOnScreen;

class ConversationMenuAnchor extends StatefulWidget {
  const ConversationMenuAnchor({super.key, required this.agent});
  final AgentController agent;
  @override
  State<ConversationMenuAnchor> createState() => _ConversationMenuAnchorState();
}

class _ConversationMenuAnchorState extends State<ConversationMenuAnchor> {
  var _memoryOff = false;
  Future<void> _load() async {
    final id = widget.agent.activeSessionId;
    if (id == null) return;
    try {
      final result = asJsonMap(await widget.agent.backend.call('memory.sessionMode', {'sessionId': id}));
      if (mounted && id == widget.agent.activeSessionId) setState(() => _memoryOff = result['mode'] == 'off');
    } catch (_) {}
  }
  @override
  Widget build(BuildContext context) {
    final agent = widget.agent;
    final saved = agent.active?.incognito != true && agent.currentSessionPath != null;
    final content = saved && !(agent.active?.isPristine ?? true);
    void action(String value) => agent.requestConversationAction(value);
    return MenuAnchor(
      onOpen: _load,
      menuChildren: [
        MenuItemButton(onPressed: content && !agent.isRunning ? () => action('skill') : null, child: const Text('把这次做法存成技能')),
        MenuItemButton(onPressed: content ? () => action('schedule') : null, child: const Text('定时再做一次')),
        CheckboxMenuButton(value: _memoryOff, onChanged: saved ? (value) => action(value == true ? 'memory_off' : 'memory_on') : null, child: const Text('这段对话不记忆')),
        MenuItemButton(onPressed: content ? () => action('export') : null, child: const Text('导出')),
        MenuItemButton(onPressed: saved ? () => action('archive') : null, child: const Text('归档')),
        const Divider(height: 8),
        MenuItemButton(onPressed: agent.active == null ? null : () => action('delete'), child: Text('删除', style: TextStyle(color: context.colors.danger))),
      ],
      builder: (context, menu, _) => IconButton(tooltip: '对话菜单', onPressed: () => menu.isOpen ? menu.close() : menu.open(), icon: const Icon(Icons.more_horiz, size: 20)),
    );
  }
}

/// The title strip has no Navigator. Actions are handled inside the owning chat.
class ConversationActionHost extends StatefulWidget {
  const ConversationActionHost({super.key, required this.child});
  final Widget child;
  @override
  State<ConversationActionHost> createState() => _ConversationActionHostState();
}

class _ConversationActionHostState extends State<ConversationActionHost> {
  StreamSubscription<String>? _subscription;
  bool _busy = false;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _subscription ??= AgentScope.read(context).conversationActions.listen((action) {
      if (mounted && showsOnScreen(context)) unawaited(_run(action));
    });
  }
  @override
  void dispose() { _subscription?.cancel(); super.dispose(); }
  Future<void> _run(String action) async {
    if (_busy) return;
    _busy = true;
    final agent = AgentScope.read(context);
    try {
      switch (action) {
        case 'skill':
          await agent.draftSkillFromSession();
        case 'schedule':
          await showDialog<void>(context: context, builder: (_) => AgentScope(controller: agent, child: const _RepeatConversation()));
        case 'memory_off' || 'memory_on':
          final id = agent.activeSessionId;
          if (id != null) await agent.backend.call('memory.setSessionMode', {'sessionId': id, 'mode': action == 'memory_off' ? 'off' : 'normal'});
        case 'export':
          final path = agent.currentSessionPath;
          if (path == null) return;
          final file = await getSaveLocation(suggestedName: '${agent.sessionTitle.replaceAll(RegExp(r'[\\/:*?"<>|]'), '_')}.md', acceptedTypeGroups: [const XTypeGroup(label: 'Markdown', extensions: ['md'])]);
          if (file != null) await agent.exportSession(path, 'markdown', file.path);
        case 'archive':
          final path = agent.currentSessionPath;
          if (path != null) await agent.setArchived(path, true);
        case 'delete':
          if (agent.active?.incognito == true) { await agent.newSession(); }
          else if (agent.currentSessionPath case final path?) { if (mounted) await deleteConversation(context, agent, path); }
      }
    } catch (error) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(SessionRuntime.describeError(error))));
    } finally { _busy = false; }
  }
  @override
  Widget build(BuildContext context) => widget.child;
}

Future<void> deleteConversation(BuildContext context, AgentController agent, String path) async {
  Json? receipt;
  if (!await agent.deleteSession(path, onReceipt: (value) => receipt = value) || !context.mounted) return;
  final batchId = receipt?['batchId'];
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(
    content: const Text('已删除'),
    action: batchId is! String ? null : SnackBarAction(label: '撤销', onPressed: () async {
      try { await agent.backend.call('sessions.restore', {'batchId': batchId}); await agent.refreshSessions(); }
      catch (error) { if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(SessionRuntime.describeError(error)))); }
    }),
  ));
}

Future<void> showConversationRecycleBin(BuildContext context) {
  final agent = AgentScope.read(context);
  return showDialog<void>(context: context, builder: (_) => AgentScope(controller: agent, child: const _RecycleBin()));
}

class _RecycleBin extends StatefulWidget {
  const _RecycleBin();
  @override
  State<_RecycleBin> createState() => _RecycleBinState();
}

class _RecycleBinState extends State<_RecycleBin> {
  List<Json>? _rows;
  String? _error;
  String? _restoring;
  late final _agent = AgentScope.read(context);
  @override
  void initState() { super.initState(); unawaited(_load()); }
  Future<void> _load() async {
    try {
      final result = jsonRows(await _agent.backend.call('sessions.recycleBin'));
      if (mounted) setState(() { _rows = result; _error = null; });
    } catch (error) { if (mounted) setState(() => _error = SessionRuntime.describeError(error)); }
  }
  Future<void> _restore(String id) async {
    setState(() => _restoring = id);
    try { await _agent.backend.call('sessions.restore', {'batchId': id}); await _agent.refreshSessions(); await _load(); }
    catch (error) { if (mounted) setState(() => _error = SessionRuntime.describeError(error)); }
    finally { if (mounted) setState(() => _restoring = null); }
  }
  @override
  Widget build(BuildContext context) {
    final seen = <String>{};
    final rows = (_rows ?? const []).where((r) => r['batchId'] is String && seen.add(r['batchId'] as String)).toList();
    return AlertDialog(title: const Text('回收站'), content: SizedBox(width: 520, child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, children: [
      if (_error != null) Text(_error!, style: TextStyle(color: context.colors.danger)),
      if (_rows == null && _error == null) const LinearProgressIndicator(),
      if (_rows != null && rows.isEmpty) const Text('回收站是空的'),
      for (final row in rows) ListTile(
        contentPadding: EdgeInsets.zero,
        title: Text(asJsonMap(row['session'])['title'] as String? ?? '新对话', maxLines: 2, overflow: TextOverflow.ellipsis),
        trailing: TextButton(onPressed: _restoring == null ? () => _restore(row['batchId'] as String) : null, child: Text(_restoring == row['batchId'] ? '正在恢复…' : '恢复')),
      ),
    ]))), actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('关闭'))]);
  }
}

class _RepeatConversation extends StatefulWidget {
  const _RepeatConversation();
  @override
  State<_RepeatConversation> createState() => _RepeatConversationState();
}

class _RepeatConversationState extends State<_RepeatConversation> {
  String? _slot;
  @override
  void initState() { super.initState(); _slot = AgentScope.read(context).active?.slotId; }
  late final _name = TextEditingController(text: AgentScope.read(context).sessionTitle);
  var _frequency = 'once';
  var _time = const TimeOfDay(hour: 9, minute: 0);
  var _date = DateTime.now().add(const Duration(days: 1));
  var _weekday = DateTime.monday;
  var _saving = false;
  String? _error;
  @override
  void dispose() { _name.dispose(); super.dispose(); }
  Future<void> _save() async {
    final agent = AgentScope.read(context);
    if (_slot == null || agent.active?.slotId != _slot) { setState(() => _error = '对话已变化，请重新打开'); return; }
    final at = DateTime(_date.year, _date.month, _date.day, _time.hour, _time.minute);
    if (_frequency == 'once' && !at.isAfter(DateTime.now())) { setState(() => _error = '请选择未来的时间'); return; }
    setState(() { _saving = true; _error = null; });
    try {
      await agent.backend.call('schedules.fromSession', {
        'slotId': _slot, 'name': _name.text.trim(),
        'trigger': _frequency == 'once' ? {'type': 'once', 'at': at.millisecondsSinceEpoch} : {'type': 'cron', 'cron': '${_time.minute} ${_time.hour} * * ${_frequency == 'daily' ? '*' : _weekday % 7}'},
      });
      if (mounted) Navigator.pop(context);
    } catch (error) { if (mounted) setState(() { _saving = false; _error = SessionRuntime.describeError(error); }); }
  }
  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('定时再做一次'),
    content: SizedBox(width: 400, child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      TextField(controller: _name, decoration: const InputDecoration(labelText: '名称')),
      const SizedBox(height: 16),
      DropdownButtonFormField<String>(initialValue: _frequency, decoration: const InputDecoration(labelText: '重复'), items: const [DropdownMenuItem(value: 'once', child: Text('只做一次')), DropdownMenuItem(value: 'daily', child: Text('每天')), DropdownMenuItem(value: 'weekly', child: Text('每周'))], onChanged: _saving ? null : (value) => setState(() => _frequency = value!)),
      if (_frequency == 'weekly') DropdownButtonFormField<int>(initialValue: _weekday, items: [for (var i = 1; i <= 7; i++) DropdownMenuItem(value: i, child: Text(['周一','周二','周三','周四','周五','周六','周日'][i-1]))], onChanged: _saving ? null : (value) => setState(() => _weekday = value!)),
      if (_frequency == 'once') TextButton(onPressed: () async { final value = await showDatePicker(context: context, initialDate: _date, firstDate: DateTime.now(), lastDate: DateTime.now().add(const Duration(days: 3650))); if (mounted && value != null) setState(() => _date = value); }, child: Text('${_date.year}-${_date.month}-${_date.day}')),
      TextButton(onPressed: () async { final value = await showTimePicker(context: context, initialTime: _time); if (mounted && value != null) setState(() => _time = value); }, child: Text(_time.format(context))),
      if (_error != null) Text(_error!, style: TextStyle(color: context.colors.danger)),
    ]))),
    actions: [TextButton(onPressed: _saving ? null : () => Navigator.pop(context), child: const Text('取消')), FilledButton(onPressed: _saving ? null : _save, child: Text(_saving ? '正在创建…' : '创建'))],
  );
}
