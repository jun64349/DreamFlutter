import 'dart:async';

import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'common.dart' show formatDate;
import 'conversation_actions.dart';

/// How wide the settings content gets (0.8.2, user test: on a wide window the
/// label sat at the left edge and its value at the right, too far apart to
/// read across). The prototype caps the page at 900 with the 180 nav.
const settingsContentWidth = 760.0;

/// A titled group of settings in one card (0.8.2): the rows inside are
/// separated by hairlines, so the eye can follow a label to its value; the
/// title carries a small butterfly in the theme's colours.
class SettingsCard extends StatelessWidget {
  const SettingsCard({super.key, this.title, required this.children, this.trailing, this.collapsed, this.padded = true});

  final String? title;
  final List<Widget> children;
  final Widget? trailing;

  /// Non-null: the card folds (the 「高级」 card); the value is whether it starts folded.
  final bool? collapsed;

  /// Rows get the card's side padding; false for a widget that brings its own.
  final bool padded;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final rows = <Widget>[];
    for (final (i, child) in children.indexed) {
      if (i > 0) rows.add(Divider(height: 1, thickness: 0.5, indent: 16, endIndent: 16, color: colors.border));
      rows.add(padded ? Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: child) : child);
    }
    final body = Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: rows);
    final card = CardSurface(child: collapsed == null ? Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: body) : _Folding(title: title ?? '高级', initiallyCollapsed: collapsed!, child: body));
    return Padding(
      padding: const EdgeInsets.only(bottom: 22),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (title != null && collapsed == null)
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
              child: Row(children: [
                ButterflyGlyph(size: 13, color: colors.accent.withValues(alpha: 0.75)),
                const SizedBox(width: 8),
                Text(title!, style: context.text.titleSmall?.copyWith(color: colors.ink2, letterSpacing: 0.6)),
                const Spacer(),
                ?trailing,
              ]),
            ),
          card,
        ],
      ),
    );
  }
}

/// The card ground of a group (settings, memory, the right panel): a Material, so the rows'
/// hover and press effects show on it.
class CardSurface extends StatelessWidget {
  const CardSurface({super.key, required this.child, this.radius});
  final Widget child;
  final double? radius;
  @override
  Widget build(BuildContext context) => Material(
    color: context.colors.card,
    clipBehavior: Clip.antiAlias,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(radius ?? context.radius),
      side: BorderSide(color: context.colors.border, width: 0.8),
    ),
    child: child,
  );
}

class _Folding extends StatefulWidget {
  const _Folding({required this.title, required this.initiallyCollapsed, required this.child});
  final String title;
  final bool initiallyCollapsed;
  final Widget child;
  @override
  State<_Folding> createState() => _FoldingState();
}

class _FoldingState extends State<_Folding> {
  late var _open = !widget.initiallyCollapsed;
  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      InkWell(
        onTap: () => setState(() => _open = !_open),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
          child: Row(children: [
            AnimatedRotation(turns: _open ? 0.25 : 0, duration: AppTokens.motion(context, AppTokens.medium), child: Icon(Icons.chevron_right, size: 18, color: colors.muted)),
            const SizedBox(width: 6),
            Text(widget.title, style: context.text.bodyMedium?.copyWith(color: colors.muted)),
          ]),
        ),
      ),
      AnimatedSize(
        duration: AppTokens.motion(context, AppTokens.medium),
        curve: AppTokens.curve,
        alignment: Alignment.topCenter,
        child: _open ? Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [Divider(height: 1, thickness: 0.5, color: colors.border), Padding(padding: const EdgeInsets.only(bottom: 4), child: widget.child)]) : const SizedBox(width: double.infinity),
      ),
    ]);
  }
}

/// 设置 › 归档/回收 (0.8.2, user test: moved here from the sidebar's foot).
class ArchivedConversations extends StatelessWidget {
  const ArchivedConversations({super.key});

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final rows = agent.archivedSessions;
    final muted = context.text.bodySmall?.copyWith(color: context.colors.muted);
    if (rows.isEmpty) return Padding(padding: const EdgeInsets.symmetric(vertical: 14), child: Text('没有归档的对话', style: muted));
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      for (final (i, s) in rows.indexed) ...[
        if (i > 0) Divider(height: 1, thickness: 0.5, color: context.colors.border),
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Row(children: [
            Icon(Icons.inventory_2_outlined, size: 17, color: context.colors.muted),
            const SizedBox(width: 12),
            Expanded(child: Text(s.title, maxLines: 1, overflow: TextOverflow.ellipsis)),
            Text(formatDate(s.modifiedAt.millisecondsSinceEpoch), style: muted),
            const SizedBox(width: 8),
            TextButton(onPressed: () => _run(context, () => agent.setArchived(s.path, false), '已放回对话列表'), child: const Text('放回列表')),
            IconButton(tooltip: '删除', icon: Icon(Icons.delete_outline, size: 18, color: context.colors.danger), onPressed: () => deleteConversation(context, agent, s.path, title: s.title)),
          ]),
        ),
      ],
    ]);
  }

  static Future<void> _run(BuildContext context, Future<void> Function() action, String done) async {
    try {
      await action();
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(done)));
    } catch (e) {
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(SessionRuntime.describeError(e))));
    }
  }
}

/// Deleted conversations, restorable for 30 days.
class RecycledConversations extends StatefulWidget {
  const RecycledConversations({super.key});
  @override
  State<RecycledConversations> createState() => _RecycledConversationsState();
}

class _RecycledConversationsState extends State<RecycledConversations> {
  List<Json>? _rows;
  String? _error, _restoring;
  StreamSubscription<Json>? _events;
  late final AgentController _agent = AgentScope.read(context);

  @override
  void initState() {
    super.initState();
    unawaited(_load());
    _events = _agent.backend.events.listen((e) { if (e['event'] == 'sessions.changed') unawaited(_load()); });
  }

  @override
  void dispose() { _events?.cancel(); super.dispose(); }

  Future<void> _load() async {
    try {
      final result = jsonRows(await _agent.backend.call('sessions.recycleBin'));
      if (mounted) setState(() { _rows = result; _error = null; });
    } catch (error) { if (mounted) setState(() => _error = SessionRuntime.describeError(error)); }
  }

  Future<void> _restore(String id) async {
    setState(() => _restoring = id);
    try {
      await _agent.backend.call('sessions.restore', {'batchId': id});
      await _agent.refreshSessions();
      await _load();
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已恢复到对话列表')));
    } catch (error) { if (mounted) setState(() => _error = SessionRuntime.describeError(error)); }
    finally { if (mounted) setState(() => _restoring = null); }
  }

  @override
  Widget build(BuildContext context) {
    final muted = context.text.bodySmall?.copyWith(color: context.colors.muted);
    final seen = <String>{};
    final rows = (_rows ?? const []).where((r) => r['batchId'] is String && seen.add(r['batchId'] as String)).toList();
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (_error != null) Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text(_error!, style: TextStyle(color: context.colors.danger))),
      if (_rows == null && _error == null) const Padding(padding: EdgeInsets.symmetric(vertical: 14), child: LinearProgressIndicator()),
      if (_rows != null && rows.isEmpty) Padding(padding: const EdgeInsets.symmetric(vertical: 14), child: Text('回收站是空的', style: muted)),
      for (final (i, row) in rows.indexed) ...[
        if (i > 0) Divider(height: 1, thickness: 0.5, color: context.colors.border),
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Row(children: [
            Icon(Icons.delete_outline, size: 17, color: context.colors.muted),
            const SizedBox(width: 12),
            Expanded(child: Text(asJsonMap(row['session'])['title'] as String? ?? '新对话', maxLines: 1, overflow: TextOverflow.ellipsis)),
            if (row['expiresAt'] is num) Text('还能恢复 ${((((row['expiresAt'] as num).toInt() - DateTime.now().millisecondsSinceEpoch) / 86400000).ceil()).clamp(0, 30)} 天', style: muted),
            const SizedBox(width: 8),
            TextButton(onPressed: _restoring == null ? () => _restore(row['batchId'] as String) : null, child: Text(_restoring == row['batchId'] ? '正在恢复…' : '恢复')),
          ]),
        ),
      ],
    ]);
  }
}
