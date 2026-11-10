import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../theme.dart';

void closeShellDrawer(BuildContext context) {
  final scaffold = Scaffold.maybeOf(context);
  if (scaffold?.isDrawerOpen ?? false) scaffold!.closeDrawer();
}

// inbox.list already includes tool approvals; do not count live dialogs twice.
int shellPendingCount(AgentController agent) => agent.attention.available ? agent.attention.total : agent.pendingInbox + agent.pendingMemories + agent.pendingProposals;

/// Parent first, descendants immediately below; orphan and cyclic rows stay reachable.
List<SidebarEntry> orderSidebarEntries(List<SidebarEntry> entries) {
  final result = <SidebarEntry>[];
  final visited = <String>{};
  final sorted = [...entries]
    ..sort((a, b) {
      final pin = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
      return pin != 0 ? pin : b.modifiedAt.compareTo(a.modifiedAt);
    });
  void visit(SidebarEntry entry) {
    if (!visited.add(entry.path.toLowerCase())) return;
    result.add(entry);
    for (final child in sorted) {
      if (child.parentSession != null &&
          SessionStore.samePath(child.parentSession!, entry.path)) { visit(child); }
    }
  }

  for (final entry in sorted) {
    if (!entries.any(
      (p) =>
          entry.parentSession != null &&
          SessionStore.samePath(p.path, entry.parentSession!),
    )) { visit(entry); }
  }
  for (final entry in sorted) {
    visit(entry);
  }
  return result;
}

class ShellCount extends StatelessWidget {
  const ShellCount({super.key, required this.count});
  final String count;

  @override
  Widget build(BuildContext context) => AnimatedSwitcher(
    duration: AppTokens.motion(context, AppTokens.medium),
    switchInCurve: AppTokens.curve,
    switchOutCurve: AppTokens.curve,
    transitionBuilder: (child, animation) => ScaleTransition(
      scale: animation,
      child: FadeTransition(opacity: animation, child: child),
    ),
    child: count.isEmpty ? const SizedBox.shrink(key: ValueKey('empty')) : Container(
      key: ValueKey(count),
      constraints: const BoxConstraints(minWidth: 22),
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: context.colors.accentSoft,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        count,
        textAlign: TextAlign.center,
        style: context.text.labelSmall?.copyWith(color: context.colors.accent),
      ),
    ),
  );
}

/// Animate only inserted/removed rows; streaming updates keep existing rows still.
class ShellAnimatedList extends StatefulWidget {
  const ShellAnimatedList({super.key, required this.children});
  final List<Widget> children;
  @override
  State<ShellAnimatedList> createState() => _ShellAnimatedListState();
}

class _ShellAnimatedListState extends State<ShellAnimatedList> {
  final _key = GlobalKey<AnimatedListState>();
  late final _rows = [...widget.children];

  Widget _transition(Widget child, Animation<double> animation) => SizeTransition(
    sizeFactor: animation.drive(CurveTween(curve: AppTokens.curve)), alignment: Alignment.topLeft, child: FadeTransition(opacity: animation.drive(CurveTween(curve: AppTokens.curve)), child: child),
  );

  @override
  void didUpdateWidget(ShellAnimatedList old) {
    super.didUpdateWidget(old);
    final duration = AppTokens.motion(context, AppTokens.medium);
    void remove(int index) {
      final removed = _rows.removeAt(index);
      _key.currentState!.removeItem(index, (context, animation) => _transition(removed, animation), duration: duration);
    }
    for (var i = 0; i < widget.children.length; i++) {
      final next = widget.children[i];
      if (i < _rows.length && _rows[i].key == next.key) { _rows[i] = next; continue; }
      final existing = _rows.indexWhere((r) => r.key == next.key, i);
      if (existing >= 0) remove(existing);
      _rows.insert(i, next);
      _key.currentState!.insertItem(i, duration: duration);
    }
    while (_rows.length > widget.children.length) { remove(_rows.length - 1); }
  }

  @override
  Widget build(BuildContext context) => AnimatedList(
    key: _key, initialItemCount: _rows.length,
    itemBuilder: (context, index, animation) => _transition(_rows[index], animation),
  );
}

class PoeticPageTitle extends StatelessWidget {
  const PoeticPageTitle(this.name, {super.key});
  final String name;
  static const titles = {
    '记忆': '记下的事',
    '技能与模板': '蝶园',
    '技能': '蝶园',
    '任务': '这一笔等你点头',
    '等你处理': '这一笔等你点头',
    '设置': '一方天地',
  };

  @override
  Widget build(BuildContext context) {
    final poetic = titles[name];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          poetic ?? name,
          style: poetic == null
              ? context.text.titleLarge
              : context
                    .handwriting(context.text.headlineSmall)
                    .copyWith(fontSize: 28),
          maxLines: 2,
        ),
        if (poetic != null)
          Text(
            name == '任务'
                ? '等你处理'
                : name == '技能与模板'
                ? '技能'
                : name,
            style: context.text.bodySmall?.copyWith(
              color: context.colors.muted,
            ),
          ),
      ],
    );
  }
}

/// Navigation motion without discarding the already opened pages.
class ShellPageMotion extends StatefulWidget {
  const ShellPageMotion({super.key, required this.page, required this.child});
  final Object page;
  final Widget child;
  @override
  State<ShellPageMotion> createState() => _ShellPageMotionState();
}

class _ShellPageMotionState extends State<ShellPageMotion>
    with SingleTickerProviderStateMixin {
  late final _motion = AnimationController(
    vsync: this,
    duration: AppTokens.slow,
    value: 1,
  );
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context) || !TickerMode.valuesOf(context).enabled) { _motion.stop(); _motion.value = 1; }
  }
  @override
  void didUpdateWidget(ShellPageMotion old) {
    super.didUpdateWidget(old);
    if (old.page != widget.page && !MediaQuery.disableAnimationsOf(context)) { _motion.forward(from: 0); }
  }

  @override
  void dispose() {
    _motion.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (MediaQuery.disableAnimationsOf(context)) return widget.child;
    final animation = CurvedAnimation(parent: _motion, curve: AppTokens.curve);
    return FadeTransition(
      opacity: animation,
      child: SlideTransition(
        position: Tween(
          begin: const Offset(0, .012),
          end: Offset.zero,
        ).animate(animation),
        child: widget.child,
      ),
    );
  }
}
