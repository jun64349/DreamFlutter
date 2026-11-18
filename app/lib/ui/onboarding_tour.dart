import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:path/path.dart' as p;

import '../state/agent_controller.dart';
import '../state/installation.dart';
import '../state/onboarding.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'guide_page.dart';

/// Marks a place a lesson step can light up (state/onboarding.dart). Costs nothing when no lesson runs.
/// One place can be built more than once (the workbench and 蝶君 pages are both kept alive): the one
/// on screen is the one whose page has its tickers on (home_page.dart's TickerMode, Visibility).
class TourAnchor extends StatefulWidget {
  const TourAnchor(this.id, {super.key, required this.child});
  final String id;
  final Widget child;
  static final _places = <String, Set<_TourAnchorState>>{};

  /// The render box of the place on screen, if one is built.
  static RenderBox? boxFor(String id) {
    for (final place in _places[id] ?? const <_TourAnchorState>{}) {
      if (!place.mounted || !place._onScreen) continue;
      final box = place.context.findRenderObject();
      if (box is RenderBox && box.attached && box.hasSize && _shown(box)) return box;
    }
    return null;
  }

  /// Not on a page an IndexedStack keeps behind the current one, nor in a hidden Offstage.
  static bool _shown(RenderObject box) {
    RenderObject child = box;
    for (var parent = box.parent; parent != null; child = parent, parent = parent.parent) {
      if (parent is RenderIndexedStack && parent.getChildrenAsList().indexOf(child as RenderBox) != parent.index) return false;
      if (parent is RenderOffstage && parent.offstage) return false;
    }
    return true;
  }

  @override
  State<TourAnchor> createState() => _TourAnchorState();
}

class _TourAnchorState extends State<TourAnchor> {
  bool _onScreen = true;

  @override
  void initState() {
    super.initState();
    TourAnchor._places.putIfAbsent(widget.id, () => {}).add(this);
  }

  @override
  void didUpdateWidget(TourAnchor old) {
    super.didUpdateWidget(old);
    if (old.id != widget.id) {
      TourAnchor._places[old.id]?.remove(this);
      TourAnchor._places.putIfAbsent(widget.id, () => {}).add(this);
    }
  }

  @override
  void dispose() {
    TourAnchor._places[widget.id]?.remove(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    _onScreen = TickerMode.valuesOf(context).enabled;
    return widget.child;
  }
}

/// The files of lesson 4, copied into <data>/练习 (user 2026-11-18: in the data folder).
const practiceFiles = ['销售记录.xlsx', '读书笔记.md', '会议纪要.md', '旅行计划.md', '图片.png'];

Future<String> preparePracticeFolder({String? dataRoot}) async {
  final folder = Directory(p.join(dataRoot ?? Installation.dataRoot(), '练习'));
  await folder.create(recursive: true);
  for (final name in practiceFiles) {
    final file = File(p.join(folder.path, name));
    if (file.existsSync()) continue;
    final data = await rootBundle.load('assets/practice/$name');
    await file.writeAsBytes(data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes), flush: true);
  }
  return folder.path;
}

/// Over the whole window while a lesson runs: dims all but the step's place and shows the card.
class TourLayer extends StatefulWidget {
  const TourLayer({super.key, required this.agent, this.navigator, required this.child});
  final AgentController agent;
  /// Null: the navigator under this layer (the child MaterialApp.builder gets).
  final GlobalKey<NavigatorState>? navigator;
  final Widget child;
  @override
  State<TourLayer> createState() => _TourLayerState();
}

class _TourLayerState extends State<TourLayer> {
  final _layer = GlobalKey();
  Timer? _follow;
  bool _busy = false;
  RenderBox? _shownBox;

  OnboardingTour get tour => widget.agent.tour;

  @override
  void initState() {
    super.initState();
    tour.addListener(_changed);
    widget.agent.sandboxStatus.addListener(_sandbox);
    _changed();
  }

  @override
  void didUpdateWidget(TourLayer old) {
    super.didUpdateWidget(old);
    if (old.agent != widget.agent) {
      old.agent.tour.removeListener(_changed);
      old.agent.sandboxStatus.removeListener(_sandbox);
      tour.addListener(_changed);
      widget.agent.sandboxStatus.addListener(_sandbox);
    }
  }

  @override
  void dispose() {
    _follow?.cancel();
    tour.removeListener(_changed);
    widget.agent.sandboxStatus.removeListener(_sandbox);
    super.dispose();
  }

  void _sandbox() => tour.check(widget.agent);

  void _changed() {
    // The lit place moves with scrolling, resizing and page changes: follow it while a lesson shows.
    _follow?.cancel();
    if (tour.showing) _follow = Timer.periodic(const Duration(milliseconds: 250), (_) { if (mounted) setState(() {}); });
    if (mounted) setState(() {});
  }

  BuildContext? _navigatorContext() {
    final given = widget.navigator?.currentContext;
    if (given != null) return given;
    BuildContext? found;
    void visit(Element e) {
      if (found != null) return;
      if (e is StatefulElement && e.state is NavigatorState) {
        found = (e.state as NavigatorState).context;
        return;
      }
      e.visitChildren(visit);
    }
    (_layer.currentContext as Element?)?.visitChildren(visit);
    return found;
  }

  /// [ids]: places separated by |, the first one on screen wins ('gateway-add|settings-nav-模型':
  /// the add button once the 模型 page is open, the 模型 item before).
  Rect? _target(String? ids) {
    if (ids == null) return null;
    RenderBox? box;
    for (final id in ids.split('|')) {
      box = TourAnchor.boxFor(id);
      if (box != null) break;
    }
    final layer = _layer.currentContext?.findRenderObject();
    if (box is! RenderBox || layer is! RenderBox || !box.attached || !box.hasSize) return null;
    if (!identical(box, _shownBox)) {
      // A newly lit place half out of its scrolling page (添加渠道 at the foot of 模型) is scrolled in once.
      _shownBox = box;
      final place = box;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (place.attached) place.showOnScreen(duration: const Duration(milliseconds: 250), curve: Curves.easeOut);
      });
    }
    final topLeft = layer.globalToLocal(box.localToGlobal(Offset.zero));
    final bottomRight = layer.globalToLocal(box.localToGlobal(box.size.bottomRight(Offset.zero)));
    final rect = Rect.fromPoints(topLeft, bottomRight).inflate(4);
    final bounds = Offset.zero & layer.size;
    return rect.overlaps(bounds) ? rect.intersect(bounds) : null;
  }

  Future<void> _act(TourStep step) async {
    final agent = widget.agent;
    final lesson = tour.lesson;
    setState(() => _busy = true);
    try {
      switch (step.action) {
        case TourAction.fillComposer:
          final target = lesson == 4 ? (agent.butterfly ?? agent) : agent;
          target.insertIntoComposer(step.fill ?? '');
        case TourAction.practiceFolder:
          final folder = await preparePracticeFolder();
          await agent.setWorkspace(folder);
          agent.showSection(AppSection.chat);
          tour.signal('practice', agent);
        case TourAction.provisionSandbox:
          await agent.backend.call('sandbox.provision');
        case TourAction.later:
          tour.later(agent);
        case null:
          break;
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text('$e')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final step = tour.showing ? tour.currentStep : null;
    final lesson = tour.current;
    final children = <Widget>[Positioned.fill(child: widget.child)];
    if (step != null && lesson != null) {
      final layer = (_layer.currentContext?.findRenderObject() as RenderBox?)?.size;
      final hole = _target(step.anchor);
      final shade = Theme.of(context).brightness == Brightness.dark ? const Color(0x99000000) : const Color(0x6B2B2620);
      if (hole != null && layer != null) {
        // One shade with the hole cut out; four clear blocks around the hole take the clicks there.
        children.addAll([
          Positioned.fill(child: IgnorePointer(child: CustomPaint(painter: _Shade(hole, shade)))),
          Positioned(left: 0, top: 0, right: 0, height: hole.top, child: const _Block()),
          Positioned(left: 0, top: hole.bottom, right: 0, bottom: 0, child: const _Block()),
          Positioned(left: 0, top: hole.top, width: hole.left, height: hole.height, child: const _Block()),
          Positioned(left: hole.right, top: hole.top, right: 0, height: hole.height, child: const _Block()),
          Positioned.fromRect(rect: hole, child: IgnorePointer(child: DecoratedBox(decoration: BoxDecoration(borderRadius: BorderRadius.circular(10), border: Border.all(color: const Color(0xFFF3C76B), width: 2))))),
        ]);
      }
      children.add(_placeCard(_card(context, lesson, step), hole, layer));
    }
    return Stack(key: _layer, children: children);
  }

  Widget _placeCard(Widget card, Rect? hole, Size? layer) {
    const width = 320.0;
    if (hole == null || layer == null) return Positioned(left: 0, right: 0, bottom: 28, child: Center(child: SizedBox(width: width, child: card)));
    final left = (hole.center.dx - width / 2).clamp(12.0, (layer.width - width - 12).clamp(12.0, double.infinity));
    if (layer.height - hole.bottom > 230) return Positioned(left: left, top: hole.bottom + 12, width: width, child: card);
    if (hole.top > 230) return Positioned(left: left, bottom: layer.height - hole.top + 12, width: width, child: card);
    // A big lit place (a whole page): the card sits inside it, at the bottom.
    return Positioned(left: left, bottom: (layer.height - hole.bottom) + 28, width: width, child: card);
  }

  Widget _card(BuildContext context, TourLesson lesson, TourStep step) {
    final colors = context.colors;
    final agent = widget.agent;
    final number = tourLessons.indexOf(lesson) + 1;
    final small = context.text.bodySmall?.copyWith(color: colors.muted, fontSize: 12);
    final sandboxBusy = step.action == TourAction.provisionSandbox && const {'provisioning', 'restart-needed'}.contains(agent.sandboxStatus.value?['state']);
    return Material(
      color: colors.card,
      elevation: 8,
      shadowColor: Colors.black38,
      borderRadius: BorderRadius.circular(12),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 10),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          Text('第 $number 课 · ${tour.step + 1} / ${lesson.steps.length}　${step.title}', style: context.text.bodyMedium?.copyWith(fontWeight: FontWeight.w600, color: colors.ink)),
          const SizedBox(height: 4),
          Text(step.text, style: context.text.bodyMedium?.copyWith(color: colors.ink2, height: 1.6)),
          if (sandboxBusy) ...[
            const SizedBox(height: 8),
            Text('${agent.sandboxStatus.value?['step'] ?? (agent.sandboxStatus.value?['state'] == 'restart-needed' ? '等重启电脑' : '正在建…')}', style: small),
            if (agent.sandboxStatus.value?['state'] == 'provisioning') Padding(padding: const EdgeInsets.only(top: 4), child: LinearProgressIndicator(value: (agent.sandboxStatus.value?['progress'] as num?)?.toDouble())),
          ],
          const SizedBox(height: 10),
          Wrap(spacing: 6, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
            if (step.done == null)
              FilledButton(onPressed: () => tour.advance(agent), child: Text(tour.step + 1 == lesson.steps.length ? (number == tourLessons.length ? '学完了' : '下一课') : '看懂了')),
            if (step.action != null && !sandboxBusy)
              FilledButton(onPressed: _busy ? null : () => _act(step), child: Text(step.actionLabel ?? '')),
            TextButton(onPressed: () => openGuide(_navigatorContext() ?? context, lesson: lesson.guide), child: const Text('看图文说明')),
            TextButton(onPressed: tour.leave, child: const Text('先退出')),
          ]),
        ]),
      ),
    );
  }
}

class _Block extends StatelessWidget {
  const _Block();
  @override
  Widget build(BuildContext context) => GestureDetector(behavior: HitTestBehavior.opaque, onTap: () {});
}

class _Shade extends CustomPainter {
  _Shade(this.hole, this.color);
  final Rect hole;
  final Color color;
  @override
  void paint(Canvas canvas, Size size) {
    final path = Path()
      ..fillType = PathFillType.evenOdd
      ..addRect(Offset.zero & size)
      ..addRRect(RRect.fromRectAndRadius(hole, const Radius.circular(10)));
    canvas.drawPath(path, Paint()..color = color);
  }

  @override
  bool shouldRepaint(_Shade old) => old.hole != hole || old.color != color;
}

/// The sidebar card: how far the five lessons are; gone once they are done or the user said 「不用了」.
class TourProgressCard extends StatelessWidget {
  const TourProgressCard({super.key});

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context).main;
    return ListenableBuilder(listenable: Listenable.merge([agent.tour, agent.sandboxStatus]), builder: (context, _) {
      final tour = agent.tour;
      if (tour.closed || tour.finished) return const SizedBox.shrink();
      final colors = context.colors;
      final done = tour.lesson;
      final small = context.text.bodySmall?.copyWith(fontSize: 12, color: colors.muted);
      final building = tour.lesson == 4 && tour.step == 1 && const {'provisioning', 'restart-needed'}.contains(agent.sandboxStatus.value?['state']);
      final next = building ? '沙箱正在建，好了接着学' : done == 0 && tour.step == 0 ? '约 45 分钟学会' : '第 ${done + 1} 课：${tour.current!.title}';
      Widget link(String label, VoidCallback onTap, {bool strong = false}) => InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(6),
        child: Padding(padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2), child: Text(label, style: context.text.bodySmall?.copyWith(fontSize: 12.5, color: strong ? colors.accent : colors.muted, fontWeight: strong ? FontWeight.w600 : null))),
      );
      // Three short lines: the conversation list above it keeps its room on small windows.
      final progress = ((done + tour.step / tour.current!.steps.length) / tourLessons.length).clamp(0.0, 1.0);
      return Container(
        margin: const EdgeInsets.fromLTRB(10, 4, 10, 0),
        padding: const EdgeInsets.fromLTRB(10, 5, 6, 4),
        decoration: BoxDecoration(color: colors.card, borderRadius: BorderRadius.circular(10), border: Border.all(color: colors.border)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text('入门 5 课 · $done / ${tourLessons.length}', style: context.text.bodyMedium?.copyWith(fontSize: 13, fontWeight: FontWeight.w600, color: colors.ink))),
            link(done == 0 && tour.step == 0 ? '开始 ›' : '继续 ›', () => tour.start(agent), strong: true),
          ]),
          Padding(
            padding: const EdgeInsets.fromLTRB(0, 3, 4, 3),
            child: Container(
              height: 4,
              alignment: Alignment.centerLeft,
              decoration: BoxDecoration(color: colors.sunk, borderRadius: BorderRadius.circular(9)),
              child: FractionallySizedBox(widthFactor: progress, child: DecoratedBox(decoration: BoxDecoration(color: colors.accent, borderRadius: BorderRadius.circular(9)))),
            ),
          ),
          Row(children: [
            Expanded(child: Text(next, style: small, maxLines: 1, overflow: TextOverflow.ellipsis)),
            if (done == 0 && tour.step == 0) link('不用了', tour.close) else link('使用说明', () => openGuide(context, lesson: tour.current!.guide)),
          ]),
        ]),
      );
    });
  }
}
