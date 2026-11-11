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
      height: 20,
      constraints: const BoxConstraints(minWidth: 20),
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        color: context.colors.seal,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(
        count,
        textAlign: TextAlign.center,
        style: context.text.labelSmall?.copyWith(color: Colors.white, fontSize: 12, fontFeatures: const [FontFeature.tabularFigures()]),
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
                    .copyWith(fontSize: 34, height: 1.3),
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

// ---------------------------------------------------------------------------
// The 1.0 prototype's building blocks (docs/design/prototype/interaction-v2.html):
// one page column, small section labels, card rows, status pills and the three
// button kinds. Pages use these so they all look the same.
// ---------------------------------------------------------------------------

extension ShellColors on AppColors {
  /// The prototype's --line2: a hairline just darker than the ground.
  Color get hairline => ink.withValues(alpha: 0.07);
}

/// The page column: at most 760 wide, centred, 24 above and below (.col).
class ShellColumn extends StatelessWidget {
  const ShellColumn({super.key, required this.children, this.maxWidth = 760});
  final List<Widget> children;
  final double maxWidth;
  @override
  Widget build(BuildContext context) => LayoutBuilder(builder: (context, box) {
    // Every child takes the full column width, so labels and rows line up on the left.
    final width = box.maxWidth < maxWidth ? box.maxWidth : maxWidth;
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 24),
      children: [
        for (final child in children)
          Center(child: SizedBox(width: width, child: Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: child))),
      ],
    );
  });
}

/// The page title: the poetic name large in the handwriting face, the plain name below (.page-h).
class ShellPageHeader extends StatelessWidget {
  const ShellPageHeader(this.name, {super.key, this.trailing});
  final String name;
  final Widget? trailing;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 18),
    child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
      Expanded(child: PoeticPageTitle(name)),
      ?trailing,
    ]),
  );
}

/// A small group label above a list (.sec): 12, muted, a little letter-spaced.
class ShellSectionLabel extends StatelessWidget {
  const ShellSectionLabel(this.text, {super.key, this.top = 22});
  final String text;
  final double top;
  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.only(top: top, bottom: 8),
    child: Text(text, style: context.text.bodySmall?.copyWith(fontSize: 12, color: context.colors.muted, letterSpacing: 1)),
  );
}

/// A list row on its own card (.row): card ground, hairline border, 12 radius.
class ShellCard extends StatelessWidget {
  const ShellCard({super.key, required this.child, this.onTap, this.selected = false, this.padding = const EdgeInsets.symmetric(horizontal: 14, vertical: 12)});
  final Widget child;
  final VoidCallback? onTap;
  final bool selected;
  final EdgeInsets padding;
  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Material(
        color: colors.card,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12), side: BorderSide(color: selected ? colors.accent : colors.hairline)),
        clipBehavior: Clip.antiAlias,
        child: InkWell(onTap: onTap, hoverColor: colors.accentSoft.withValues(alpha: 0.35), child: Padding(padding: padding, child: child)),
      ),
    );
  }
}

enum ShellTone { neutral, run, wait, ok, bad }

/// A state as a small pill (.st): 进行中 / 等你 / 已完成 / 没做成 / 等你确认.
class ShellStatusChip extends StatelessWidget {
  const ShellStatusChip(this.label, {super.key, this.tone = ShellTone.neutral});
  final String label;
  final ShellTone tone;
  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final fg = switch (tone) { ShellTone.run || ShellTone.wait => colors.ochre, ShellTone.ok => colors.success, ShellTone.bad => colors.seal, ShellTone.neutral => colors.muted };
    final bg = tone == ShellTone.neutral ? colors.hairline : fg.withValues(alpha: tone == ShellTone.ok ? 0.12 : 0.14);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 2),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Container(width: 6, height: 6, decoration: BoxDecoration(color: fg, shape: BoxShape.circle)),
        const SizedBox(width: 5),
        Text(label, style: context.text.bodySmall?.copyWith(fontSize: 12, color: fg)),
      ]),
    );
  }
}

enum ShellButtonKind { primary, normal, ghost }

/// The prototype's buttons (.btn / .btn.pri / .btn.ghost, .sm when [small]).
ButtonStyle shellButtonStyle(BuildContext context, ShellButtonKind kind, {bool small = false}) {
  final colors = context.colors;
  return TextButton.styleFrom(
    foregroundColor: switch (kind) { ShellButtonKind.primary => colors.onAccent, ShellButtonKind.normal => colors.ink, ShellButtonKind.ghost => colors.muted },
    backgroundColor: switch (kind) { ShellButtonKind.primary => colors.accent, ShellButtonKind.normal => colors.card, ShellButtonKind.ghost => Colors.transparent },
    disabledForegroundColor: colors.muted,
    padding: EdgeInsets.symmetric(horizontal: small ? 10 : 14, vertical: small ? 4 : 7),
    minimumSize: Size(0, small ? 28 : 34),
    visualDensity: VisualDensity.standard,
    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
    textStyle: TextStyle(fontSize: small ? 13 : 14),
    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8), side: kind == ShellButtonKind.normal ? BorderSide(color: colors.border) : BorderSide.none),
  );
}

class ShellButton extends StatelessWidget {
  const ShellButton(this.label, {super.key, required this.onPressed, this.kind = ShellButtonKind.normal, this.small = false, this.icon});
  final String label;
  final VoidCallback? onPressed;
  final ShellButtonKind kind;
  final bool small;
  final IconData? icon;
  @override
  Widget build(BuildContext context) => icon == null
      ? TextButton(onPressed: onPressed, style: shellButtonStyle(context, kind, small: small), child: Text(label))
      : TextButton.icon(onPressed: onPressed, style: shellButtonStyle(context, kind, small: small), icon: Icon(icon, size: 16), label: Text(label));
}

/// The 文选 line (.quoteline): a soft accent block with a bar on the left, the source after it.
class ShellQuoteLine extends StatelessWidget {
  const ShellQuoteLine(this.line, this.source, {super.key});
  final String line;
  final String source;
  // 0.8.2 (user test: "没咋对齐"): the boxed, left-barred quote sat off the centred greeting's
  // axis. It is centred now, between two short rules, with its source under it.
  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    Widget rule() => Container(width: 28, height: 0.8, color: colors.accent.withValues(alpha: 0.45));
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 560),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Row(mainAxisSize: MainAxisSize.min, children: [
          rule(),
          const SizedBox(width: 12),
          Flexible(child: Text(line, textAlign: TextAlign.center, style: context.serif(context.text.bodyMedium).copyWith(fontSize: 14, color: colors.ink2, height: 1.6))),
          const SizedBox(width: 12),
          rule(),
        ]),
        const SizedBox(height: 4),
        Text(source, textAlign: TextAlign.center, style: context.text.bodySmall?.copyWith(fontSize: 12, color: colors.muted)),
      ]),
    );
  }
}

/// A clickable example on an empty page (.ex).
class ShellExample extends StatelessWidget {
  const ShellExample(this.text, {super.key, required this.onPressed});
  final String text;
  final VoidCallback? onPressed;
  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return OutlinedButton(
      onPressed: onPressed,
      style: OutlinedButton.styleFrom(
        backgroundColor: colors.card, foregroundColor: colors.ink2,
        side: BorderSide(color: colors.border),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        textStyle: const TextStyle(fontSize: 13.5),
      ),
      child: Text(text),
    );
  }
}

/// The greeting on a home page (.greet): handwriting, ink → accent → ochre.
class ShellGreeting extends StatelessWidget {
  const ShellGreeting(this.text, {super.key, this.size = 38});
  final String text;
  final double size;
  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return ShaderMask(
      blendMode: BlendMode.srcIn,
      shaderCallback: (rect) => LinearGradient(colors: [colors.ink, colors.accent, colors.ochre]).createShader(rect),
      // Letter spacing also follows the last character: the same space on the left keeps it centred.
      child: Padding(padding: EdgeInsets.only(left: size * 0.12), child: Text(text, textAlign: TextAlign.center, style: context.handwriting(context.text.headlineSmall).copyWith(fontSize: size, letterSpacing: size * 0.12, height: 1.4))),
    );
  }
}
