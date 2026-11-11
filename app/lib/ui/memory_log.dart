import 'dart:async';

import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../state/memory_page_model.dart';
import '../state/memory_ui.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'settings_layout.dart' show CardSurface;
import 'motion.dart';

class MemoryLog extends StatefulWidget {
  const MemoryLog({super.key});
  @override
  State<MemoryLog> createState() => _MemoryLogState();
}

class _MemoryLogState extends State<MemoryLog> {
  late final AgentController _agent;
  List<Json> _days = [], _boundaries = [];
  String? _cursor, _error;
  bool _loading = true, _more = false, _changing = false, _paging = false;
  int _request = 0;
  StreamSubscription<Json>? _events;
  @override
  void initState() {
    super.initState();
    _agent = AgentScope.read(context);
    _load();
    _events = _agent.backend.events.listen((e) {
      if (e['event'] == 'memory.changed' || e['event'] == 'memory.task') {
        unawaited(_load());
      }
    });
  }

  @override
  void dispose() {
    _events?.cancel();
    super.dispose();
  }

  Future<void> _load({bool more = false}) async {
    if (more && _paging) return;
    final request = ++_request;
    if (more) setState(() => _paging = true);
    try {
      final page = memoryMap(
        await _agent.backend.call('memory.log', {
          'days': 7,
          'limit': 50,
          if (more) 'cursor': _cursor,
        }),
      );
      if (!mounted || request != _request) return;
      final days = <String, Map<String, Json>>{};
      for (final day in [
        ...(more ? _days : <Json>[]),
        ...memoryRows(page['days']),
      ]) {
        final entries = days.putIfAbsent(day['day'] as String, () => {});
        for (final entry in memoryRows(day['entries'])) {
          entries[entry['opId'] as String] = entry;
        }
      }
      setState(() {
        _days = [
          for (final day in days.entries)
            {'day': day.key, 'entries': day.value.values.toList()},
        ];
        _boundaries = memoryRows(page['boundaries'])
            .where((b) => b['changed'] == true)
            .toList();
        _cursor = page['cursor'] as String?;
        _more = page['hasMore'] == true && _cursor != null;
        _loading = false;
        _paging = false;
        _error = null;
      });
    } catch (e) {
      if (mounted && request == _request) {
        setState(() {
          _loading = false;
          _paging = false;
          _error = SessionRuntime.describeError(e);
        });
      }
    }
  }

  String _day(Json boundary) {
    final at = boundary['at'] as num?;
    if (at == null) return _days.firstOrNull?['day'] as String? ?? '今天';
    final date = DateTime.fromMillisecondsSinceEpoch(at.toInt());
    return '${date.year}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}';
  }

  Future<void> _undo(String method, Json params) async {
    if (_changing) return;
    setState(() => _changing = true);
    try {
      checkMemoryChange(memoryMap(await _agent.backend.call(method, params)));
      await _load();
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('已撤销')));
      }
    } catch (e) {
      if (mounted) {
        setState(() => _error = '没有撤销：${SessionRuntime.describeError(e)}');
      }
    } finally {
      if (mounted) setState(() => _changing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    final days = {
      ..._days.map((d) => d['day'] as String),
      ..._boundaries.map(_day),
    }.toList()..sort((a, b) => b.compareTo(a));
    return ListView(
      shrinkWrap: true,
      primary: false,
      children: [
        if (_error != null)
          Row(
            children: [
              Expanded(
                child: Text(
                  _error!,
                  style: TextStyle(color: context.colors.danger),
                ),
              ),
              TextButton(onPressed: _load, child: const Text('重试')),
            ],
          ),
      if (days.isEmpty && _error == null)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 40),
            child: Text(
              '最近还没有新的记录',
              style: TextStyle(color: context.colors.muted),
            ),
          ),
        for (final day in days) ...[
          Padding(
            padding: const EdgeInsets.only(top: 22, bottom: 8, left: 4),
            child: Text(
              day,
              style: context.text.titleSmall?.copyWith(
                color: context.colors.muted,
              ),
            ),
          ),
          // 0.8.2: a day is one card, its entries between hairlines.
          CardSurface(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
              child: MotionRows(key: ValueKey(day), children: [for (final (i, entry) in memoryRows(
                _days.where((d) => d['day'] == day).firstOrNull?['entries'],
              ).indexed)
                KeyedSubtree(key: ValueKey(entry['opId']), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [if (i > 0) Divider(height: 1, thickness: 0.5, color: context.colors.border), _entry(entry)])),
              for (final boundary in _boundaries.where((b) => _day(b) == day))
                KeyedSubtree(key: ValueKey('boundary-${boundary['id']}'), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [Divider(height: 1, thickness: 0.5, color: context.colors.border), _boundary(boundary)])),]),
            ),
          ),
        ],
        if (_more)
          Align(
            child: TextButton(
              onPressed: _paging ? null : () => _load(more: true),
              child: const Text('更早的记录'),
            ),
          ),
        const SizedBox(height: 32),
      ],
    );
  }

  Widget _entry(Json entry) {
    final after = memoryMap(entry['after']),
        before = memoryMap(entry['before']);
    final forgotten = [
      'forgotten',
      'withdrawn',
      'ended',
    ].contains(after['status']);
    final label = entry['kind'] == 'purge'
        ? '删掉了'
        : entry['undone'] == true || entry['kind'] == 'undo'
        ? '撤销了'
        : forgotten
        ? '忘记了'
        : entry['kind'] == 'add'
        ? '记住了'
        : '改了';
    return Padding(
      key: ValueKey('memory-log-entry-${entry['opId']}'),
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Container(
            width: 52,
            alignment: Alignment.center,
            margin: const EdgeInsets.only(right: 12),
            padding: const EdgeInsets.symmetric(vertical: 2),
            decoration: BoxDecoration(
              color: (label == '记住了' ? context.colors.success : label == '改了' ? context.colors.ochre : context.colors.muted).withValues(alpha: 0.13),
              borderRadius: BorderRadius.circular(5),
            ),
            child: Text(
              label,
              style: context.text.labelSmall?.copyWith(
                fontSize: 11.5,
                color: label == '记住了' ? context.colors.success : label == '改了' ? context.colors.ochre : context.colors.muted,
              ),
            ),
          ),
          Expanded(
            child: Text(
              (after['content'] ?? before['content'] ?? '一条记忆') as String,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: context.text.bodyMedium?.copyWith(height: 1.55),
            ),
          ),
          if (entry['undoable'] == true)
            TextButton(
              onPressed: _changing
                  ? null
                  : () => _undo('memory.undo', {'opId': entry['opId']}),
              child: const Text('撤销'),
            ),
        ],
      ),
    );
  }

  Widget _boundary(Json row) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 6),
    child: Row(
      children: [
        const Icon(Icons.chat_bubble_outline, size: 16),
        const SizedBox(width: 12),
        Expanded(
          child: Text(
            '换了话题：${memoryMap(row['after'])['prompt'] ?? ''}',
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
        ),
        if (row['undone'] != true)
          TextButton(
            onPressed: _changing
                ? null
                : () => _undo('memory.undoBoundary', {'id': row['id']}),
            child: const Text('撤销'),
          ),
      ],
    ),
  );
}
