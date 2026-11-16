import 'dart:async';

import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'common.dart' show formatDate;
import 'conversation_actions.dart';
import 'proto_icon.dart';
import 'craft_surface.dart';
import 'painting_background.dart';
import 'shell_widgets.dart' show ShellButton, ShellColors;

/// How wide the settings content gets (0.8.2, user test: on a wide window the
/// label sat at the left edge and its value at the right, too far apart to
/// read across). The prototype caps the page at 900 with the 180 nav.
const settingsContentWidth = 760.0;

/// A titled group of settings in one card (原型 .sh + .card)：节标题 14px 600，
/// 带一只小蝴蝶，与上一节隔 26px；卡片是 card 底、圆角 14、1px line2 描边，
/// 行与行之间是细分隔线，左右内边距 16。
class SettingsCard extends StatelessWidget {
  const SettingsCard({super.key, this.title, required this.children, this.trailing, this.desc, this.collapsed, this.padded = true, this.bare = false});

  final String? title;
  final List<Widget> children;
  final Widget? trailing;

  /// 节标题下面一行小字（原型 .sdesc，如模型组「排在前面的用不了，自动换下一个」）。
  final String? desc;

  /// Non-null: the card folds (the 「高级」 card); the value is whether it starts folded.
  final bool? collapsed;

  /// Rows get the card's side padding; false for a widget that brings its own.
  final bool padded;

  /// 不进卡片：节标题下面直接排内容（原型里白天的主题、夜里的主题两组卡片网格）。
  final bool bare;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final rows = <Widget>[];
    for (final (i, child) in children.indexed) {
      if (i > 0) rows.add(Divider(height: 1, thickness: 1, indent: padded ? 16 : 0, endIndent: padded ? 16 : 0, color: colors.hairline));
      rows.add(padded ? Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: child) : child);
    }
    final body = Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: rows);
    final card = bare
        ? body
        : CardSurface(child: collapsed == null ? Padding(padding: const EdgeInsets.symmetric(vertical: 2), child: body) : _Folding(title: title ?? '高级', initiallyCollapsed: collapsed!, child: body));
    return Padding(
      padding: const EdgeInsets.only(bottom: 26),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (title != null && collapsed == null)
            Padding(
              padding: EdgeInsets.only(bottom: desc == null ? 8 : 4),
              child: Row(children: [
                ButterflyGlyph(size: 14, color: colors.accent),
                const SizedBox(width: 8),
                Text(title!, style: context.text.bodyMedium?.copyWith(fontSize: 14, fontWeight: FontWeight.w600, color: colors.ink)),
                const Spacer(),
                ?trailing,
              ]),
            ),
          if (title != null && collapsed == null && desc != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(desc!, style: context.text.bodySmall?.copyWith(fontSize: 12.5, color: colors.muted)),
            ),
          card,
        ],
      ),
    );
  }
}

/// 节标题右边的「+ 新建…」小链接（原型 .sh 里的 a.lk，13px、常规字重、强调色）。
class SettingsHeadLink extends StatelessWidget {
  const SettingsHeadLink(this.label, {super.key, required this.onPressed});
  final String label;
  final VoidCallback? onPressed;
  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return TextButton.icon(
      onPressed: onPressed,
      style: TextButton.styleFrom(
        foregroundColor: colors.accent,
        disabledForegroundColor: colors.muted,
        padding: const EdgeInsets.symmetric(horizontal: 4),
        minimumSize: const Size(0, 24),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        visualDensity: VisualDensity.compact,
        textStyle: const TextStyle(fontFamily: AppTokens.fontFamily, fontFamilyFallback: AppTokens.fontFallback, fontSize: 13, fontWeight: FontWeight.w400),
      ),
      icon: const ProtoIcon('plus', size: 13),
      label: Text(label),
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
  Widget build(BuildContext context) => CraftCardEdge(child: Material(
    color: context.colors.card,
    clipBehavior: Clip.antiAlias,
    shape: craftSurfaceShape(context, radius: radius ?? 14, borderColor: context.colors.hairline),
    child: child,
  ));
}

/// 原型的 .inset：sunk 底、圆角 10 的内嵌框（一段自介、一个路径、一条空列表提示）。
class V1Inset extends StatelessWidget {
  const V1Inset({super.key, required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
    decoration: BoxDecoration(color: context.colors.sunk, borderRadius: BorderRadius.circular(10)),
    child: DefaultTextStyle(style: context.text.bodySmall!.copyWith(fontSize: 13, color: context.colors.ink2), child: child),
  );
}

/// 原型的 .keycap：快捷键键帽，等宽、强调色。
class V1Keycap extends StatelessWidget {
  const V1Keycap(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: colors.sunk,
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(text, style: TextStyle(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback, fontSize: 12, color: colors.accent)),
    );
  }
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
        // 原型 .lrow：标题一行、日期小字，右边「放回」。
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 10),
          child: Row(children: [
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(s.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: context.text.bodyMedium?.copyWith(fontSize: 13.5, color: context.colors.ink)),
              const SizedBox(height: 2),
              Text(formatDate(s.modifiedAt.millisecondsSinceEpoch), style: muted?.copyWith(fontSize: 12)),
            ])),
            const SizedBox(width: 12),
            ShellButton('放回', small: true, onPressed: () => _run(context, () => agent.setArchived(s.path, false), '已放回对话列表')),
            IconButton(tooltip: '删除', visualDensity: VisualDensity.compact, icon: Icon(Icons.delete_outline, size: 16, color: context.colors.muted), onPressed: () => deleteConversation(context, agent, s.path, title: s.title)),
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
        // 原型 .lrow：标题一行，「几号删除 · 还剩几天」小字，右边「恢复」。
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 10),
          child: Row(children: [
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(asJsonMap(row['session'])['title'] as String? ?? '新对话', maxLines: 1, overflow: TextOverflow.ellipsis, style: context.text.bodyMedium?.copyWith(fontSize: 13.5, color: context.colors.ink)),
              const SizedBox(height: 2),
              Text([
                if (row['deletedAt'] is num) '${formatDate((row['deletedAt'] as num).toInt())} 删除',
                if (row['expiresAt'] is num) '还剩 ${((((row['expiresAt'] as num).toInt() - DateTime.now().millisecondsSinceEpoch) / 86400000).ceil()).clamp(0, 30)} 天',
              ].join(' · '), style: muted?.copyWith(fontSize: 12)),
            ])),
            const SizedBox(width: 12),
            ShellButton(_restoring == row['batchId'] ? '正在恢复…' : '恢复', small: true, onPressed: _restoring == null ? () => _restore(row['batchId'] as String) : null),
          ]),
        ),
      ],
    ]);
  }
}
