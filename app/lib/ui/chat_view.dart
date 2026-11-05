import 'package:desktop_drop/desktop_drop.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart' show Transcript;

import '../state/agent_controller.dart';
import '../state/preferences.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'composer.dart';
import 'common.dart';
import 'context_dialog.dart';
import 'library_page.dart' show showTemplateEditor;
import 'markdown_view.dart' show FileLinks;
import 'message_widgets.dart';
import 'motion.dart';
import 'providers_page.dart' show ProvidersPage;
import 'run_summary.dart';
import 'schedules.dart' show showScheduleEditor;
import 'sidebar.dart' show WorkspaceSwitcher;
import 'window_frame.dart' show ResizeHandle;

/// Takes files dropped anywhere on the conversation (not just on the input
/// box) and hands them to the input box.
class _FileDropArea extends StatefulWidget {
  const _FileDropArea({required this.enabled, required this.onDrop, required this.builder});

  final bool enabled;
  final ValueChanged<List<String>> onDrop;
  final Widget Function(bool dragging) builder;

  @override
  State<_FileDropArea> createState() => _FileDropAreaState();
}

class _FileDropAreaState extends State<_FileDropArea> {
  var _dragging = false;

  @override
  Widget build(BuildContext context) => DropTarget(
    enable: widget.enabled && showsOnScreen(context),
    onDragEntered: (_) => setState(() => _dragging = true),
    onDragExited: (_) => setState(() => _dragging = false),
    onDragDone: (details) {
      setState(() => _dragging = false);
      widget.onDrop([for (final f in details.files) f.path]);
    },
    child: widget.builder(_dragging),
  );
}

/// The conversation: title bar, messages and the input box, with the run
/// panel on the right when there is room.
class ChatView extends StatelessWidget {
  const ChatView({super.key});

  /// Below this width the details panel stays closed.
  static const _panelMinWidth = 600.0;

  /// The conversation keeps at least this much beside a docked panel; narrower, the panel floats over it.
  static const _dockedChatWidth = 640.0;

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final incognito = agent.active?.incognito ?? false;
    // The latest card of the conversation on screen runs live.
    agent.cardStage.setLatest(latestCardId(agent.transcript));
    return LayoutBuilder(
      builder: (context, constraints) {
        final roomForPanel = constraints.maxWidth >= _panelMinWidth && !incognito;
        final showPanel = roomForPanel && agent.runPanelOpen;
        // The details open on request (0.4, design option 3): beside the conversation when the
        // window has room for both, sliding over it on a narrow window.
        final panelWidth = agent.panelWidth;
        final docked = showPanel && constraints.maxWidth - panelWidth >= _dockedChatWidth;
        return Stack(
          children: [
            Positioned.fill(
              right: docked ? panelWidth + 6 : 0,
              child: _FileDropArea(
                enabled: agent.isReady,
                onDrop: agent.dropFiles,
                builder: (dragging) => Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (agent.backendProblem != null && agent.status != ConnectionStatus.missingRuntime)
                      _ProblemBanner(status: ConnectionStatus.crashed, detail: agent.backendProblem!, reconnecting: true)
                    else if (agent.status == ConnectionStatus.crashed || agent.status == ConnectionStatus.missingRuntime)
                      _ProblemBanner(status: agent.status, detail: agent.statusDetail),
                    for (final run in agent.interruptedRuns.take(3)) _InterruptedRunCard(run: run),
                    if (incognito)
                      Container(
                        margin: const EdgeInsets.fromLTRB(AppTokens.padLg, AppTokens.pad, AppTokens.padLg, 0),
                        padding: const EdgeInsets.symmetric(horizontal: AppTokens.pad, vertical: 6),
                        decoration: BoxDecoration(color: context.colors.accentSoft, borderRadius: BorderRadius.circular(context.radius)),
                        child: Row(
                          children: [
                            Icon(Icons.visibility_off_outlined, size: 16, color: context.colors.muted),
                            const SizedBox(width: AppTokens.gap),
                            Text('无痕对话：极简模式，不保存记录，也不读写长期记忆。关掉后内容就没了。', style: context.text.bodySmall?.copyWith(color: context.colors.muted)),
                          ],
                        ),
                      ),
                    Expanded(
                      child: agent.status == ConnectionStatus.starting && agent.transcript.items.isEmpty
                          ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                          : agent.transcript.items.isEmpty
                          ? const _EmptyState()
                          : const _MessageList(),
                    ),
                    if (agent.isReady && agent.stats.contextKnown && agent.stats.contextPercent >= 85 && !agent.isCompacting)
                      _ContextWarning(percent: agent.stats.contextPercent),
                    Composer(dragging: dragging),
                  ],
                ),
              ),
            ),
            if (showPanel)
              Positioned(
                top: 0,
                bottom: 0,
                right: 0,
                child: _DetailsPanel(maxWidth: constraints.maxWidth - 160, floating: !docked),
              ),
          ],
        );
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Details panel
// ---------------------------------------------------------------------------

/// The details of the conversation (run, files, cost, actions) sliding in over
/// it from the right; its width is dragged on its left edge and remembered.
class _DetailsPanel extends StatefulWidget {
  const _DetailsPanel({required this.maxWidth, required this.floating});

  /// Leaves some of the conversation in view on a narrow window.
  final double maxWidth;

  /// Over the conversation (a shadow sets it apart) rather than beside it.
  final bool floating;

  @override
  State<_DetailsPanel> createState() => _DetailsPanelState();
}

class _DetailsPanelState extends State<_DetailsPanel> {
  double? _width;

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final max = widget.maxWidth.clamp(Preferences.panelWidths.min, Preferences.panelWidths.max);
    final width = (_width ?? agent.panelWidth).clamp(Preferences.panelWidths.min, max);
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 1, end: 0),
      duration: AppTokens.medium,
      curve: Curves.easeOutCubic,
      builder: (context, t, child) => FractionalTranslation(translation: Offset(t, 0), child: child),
      child: DecoratedBox(
        decoration: BoxDecoration(
          boxShadow: widget.floating ? [BoxShadow(color: Colors.black.withValues(alpha: 0.14), blurRadius: 28, offset: const Offset(-10, 0))] : null,
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ResizeHandle(
              width: width,
              min: Preferences.panelWidths.min,
              max: max,
              leftEdge: true,
              onChanged: (w) => setState(() => _width = w),
              onDone: (w) async {
                await agent.setPanelWidth(w);
                if (mounted) setState(() => _width = null);
              },
            ),
            RunPanel(
              key: ValueKey('panel-${agent.currentSessionPath}'),
              width: width,
              sessionFile: agent.currentSessionPath,
              onClose: () => agent.setRunPanelOpen(false),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// The first screen of a new conversation
// ---------------------------------------------------------------------------

class _EmptyState extends StatelessWidget {
  const _EmptyState();

  static const _ideas = [
    (Icons.summarize_outlined, '整理一份周报', '把工作区里本周的资料整理成周报，列出要点和待办。', '把工作区里本周的资料整理成一份周报，列出要点和待办。'),
    (Icons.folder_open_outlined, '看看这个文件夹', '读一读工作区里的文件，说说各自是做什么的。', '读一读当前工作区里的文件，告诉我里面都有什么、各自是做什么的。'),
    (Icons.route_outlined, '规划一件事', '先问清目标和时间，再给出分步计划。', '帮我规划一件事：先问我目标和时间，再给出分步计划。'),
  ];

  static const _butterflyIdeas = [
    (Icons.table_chart_outlined, '处理一份表格', '把表格拖进来，让蝶君统计并画图。', '我会拖进一份表格。请统计主要指标、画几张图，把结果和图放进 outbox。'),
    (Icons.code, '试一段代码', '不放心的代码，先在沙箱里跑跑看。', '帮我在沙箱里试一下这段代码，告诉我它做了什么、有没有问题：\n'),
    (Icons.travel_explore_outlined, '查个资料', '上网查资料，整理成一页笔记。', '帮我查一下这个主题的资料，整理成一页 Markdown 笔记放进 outbox：'),
  ];

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final agent = AgentScope.of(context);
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(32),
        child: FadeSlideIn(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const ButterflyMark(size: 120, veins: true),
              const SizedBox(height: 20),
              Text('今天想做点什么？', style: context.text.headlineSmall?.copyWith(fontSize: 26)),
              const SizedBox(height: 10),
              Text(
                agent.sandbox
                    ? '蝶君在自己的沙箱里干活，装软件、跑代码都不用你批准，也碰不到你电脑上的文件。\n拖进来的文件会复制一份给它；做好的东西放进 outbox，在「工作」里查看和保存。'
                    : 'Agent 会在工作区里读写文件、运行命令，改动的文件会列在右边。',
                textAlign: TextAlign.center,
                style: context.text.bodyMedium?.copyWith(color: colors.muted, height: 1.6),
              ),
              const SizedBox(height: 28),
              if (!agent.onboarded && !agent.sandbox) ...[const _FirstRunGuide(), const SizedBox(height: 20)],
              Wrap(
                spacing: 12,
                runSpacing: 12,
                alignment: WrapAlignment.center,
                children: [
                  for (final (icon, title, subtitle, prompt) in agent.sandbox ? _butterflyIdeas : _ideas)
                    SizedBox(
                      width: 210,
                      child: Material(
                        color: colors.card,
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(context.radiusLg), side: BorderSide(color: colors.border)),
                        child: InkWell(
                          borderRadius: BorderRadius.circular(context.radiusLg),
                          onTap: () => agent.insertIntoComposer(prompt),
                          child: Padding(
                            padding: const EdgeInsets.all(14),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Icon(icon, size: 18, color: colors.accent),
                                const SizedBox(height: 8),
                                Text(title, style: context.serif(context.text.bodyMedium).copyWith(fontWeight: FontWeight.w600)),
                                const SizedBox(height: 4),
                                Text(subtitle, style: context.text.bodySmall?.copyWith(color: colors.muted, height: 1.6)),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                ],
              ),
              if (!agent.sandbox) ...[const SizedBox(height: 24), const WorkspaceSwitcher(compact: true)],
            ],
          ),
        ),
      ),
    );
  }
}

/// 「开始之前」: three things to check on first use (a model, the
/// workspace, a first task). Shown on the empty conversation until
/// dismissed; it never blocks anything.
class _FirstRunGuide extends StatelessWidget {
  const _FirstRunGuide();

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final model = agent.model;
    final hasModel = model != null && agent.models.isNotEmpty;
    final folder = agent.workspace.isEmpty ? '未选择' : p.basename(agent.workspace);
    Widget step(int n, bool done, String title, String detail, Widget? action) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          Container(
            width: 22,
            height: 22,
            alignment: Alignment.center,
            decoration: BoxDecoration(shape: BoxShape.circle, color: done ? colors.accent : null, border: Border.all(color: done ? colors.accent : colors.muted)),
            child: done
                ? Icon(Icons.check, size: 13, color: colors.onAccent)
                : Text('$n', style: context.text.labelSmall?.copyWith(color: colors.muted)),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: context.text.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
                Text(detail, style: context.text.bodySmall?.copyWith(color: colors.muted)),
              ],
            ),
          ),
          ?action,
        ],
      ),
    );
    return Container(
      width: 520,
      padding: const EdgeInsets.fromLTRB(18, 14, 12, 10),
      decoration: BoxDecoration(color: colors.card, border: Border.all(color: colors.border), borderRadius: BorderRadius.circular(context.radiusLg)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('开始之前', style: context.serif(context.text.titleMedium).copyWith(fontSize: 16)),
          const SizedBox(height: 6),
          step(
            1,
            hasModel,
            hasModel ? '已连接模型：${model.name}' : '连接一个模型',
            hasModel ? '换模型在输入框右下角；服务商和 Key 在设置里。' : '在设置里添加服务商和 API Key，Agent 才能开始工作。',
            TextButton(
              onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const ProvidersPage())),
              child: Text(hasModel ? '管理' : '去添加'),
            ),
          ),
          step(
            2,
            agent.workspace.isNotEmpty,
            '工作区：$folder',
            'Agent 在这个文件夹里读写文件、运行命令。',
            TextButton(onPressed: () => WorkspaceSwitcher.pickFolder(context), child: const Text('换一个文件夹')),
          ),
          step(3, false, '试一个任务', '点下面任意一张卡片，或者直接在输入框里说。', null),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton(onPressed: agent.finishOnboarding, child: const Text('知道了')),
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Message list with stick-to-bottom scrolling
// ---------------------------------------------------------------------------

class _MessageList extends StatefulWidget {
  const _MessageList();

  @override
  State<_MessageList> createState() => _MessageListState();
}

class _MessageListState extends State<_MessageList> {
  final _scroll = _BottomAnchoredController();
  Transcript? _shown;
  int _sends = 0;

  /// Rows that were there before: only rows new while it runs slide in. A row
  /// scrolled away is built again when it comes back, and it played its
  /// entrance again, which looked like the conversation refreshing (v0.3.3 test).
  final Set<String> _seen = {};

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final transcript = agent.transcript;
    final rows = ChatRow.fromItems(transcript.items);
    // Another conversation opens at its end, wherever the last one was scrolled to.
    if (!identical(transcript, _shown)) {
      _shown = transcript;
      _scroll.stick = true;
      _seen
        ..clear()
        ..addAll(rows.map((r) => r.key));
    }
    // Sending (or queueing) a message goes back to the end to show it.
    final sends = agent.active?.sends ?? 0;
    if (sends != _sends) {
      _sends = sends;
      // The list may not lay out again by itself (nothing in it changed yet).
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _scroll.toEnd();
      });
    }
    final fresh = {for (final row in rows) if (_seen.add(row.key)) row.key};
    final queued = transcript.queuedSteering;
    // The messages' text registers with the selection area directly, not
    // through the list. The list's own selection handling adds the scroll
    // offset unscaled to scaled positions, so under interface zoom a drag
    // selected text further down the more the list was scrolled, or nothing
    // at all (v0.3.2 test: dragging over the first paragraph selected the third).
    final list = SelectionArea(
      child: Builder(
        builder: (context) {
          final registrar = SelectionContainer.maybeOf(context)!;
          return SelectionContainer.disabled(
            child: ListView.builder(
              controller: _scroll,
              padding: const EdgeInsets.symmetric(vertical: 24),
              itemCount: rows.length + (queued.isEmpty ? 0 : 1),
              itemBuilder: (context, index) {
                final child = index < rows.length
                    ? FadeSlideIn(
                        key: ValueKey(rows[index].key),
                        animate: transcript.isRunning && fresh.contains(rows[index].key),
                        child: ChatRowView(row: rows[index], transcript: transcript),
                      )
                    : QueuedMessages(messages: queued);
                return _AnchoredRow(
                  controller: _scroll,
                  child: SelectionRegistrarScope(
                    registrar: registrar,
                    child: Center(
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: AppTokens.contentMaxWidth + 56),
                        child: Padding(padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 6), child: child),
                      ),
                    ),
                  ),
                );
              },
            ),
          );
        },
      ),
    );
    final cwd = agent.active?.workspace;
    final body = cwd == null ? list : FileLinks(baseDir: cwd, reveal: agent.revealFile, open: agent.openFile, child: list);
    return Stack(
      children: [
        Positioned.fill(child: body),
        Positioned(
          right: 24,
          bottom: 12,
          child: ValueListenableBuilder<bool>(
            valueListenable: _scroll.following,
            builder: (context, following, _) => following ? const SizedBox.shrink() : _ToEndButton(onPressed: _scroll.toEnd),
          ),
        ),
      ],
    );
  }
}

/// Shown while the reader is away from the end of the conversation.
class _ToEndButton extends StatelessWidget {
  const _ToEndButton({required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Tooltip(
      message: '回到底部，并跟着新内容',
      child: Material(
        color: colors.card,
        shape: CircleBorder(side: BorderSide(color: colors.border)),
        elevation: 2,
        shadowColor: Colors.black26,
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onPressed,
          child: Padding(
            padding: const EdgeInsets.all(8),
            child: Icon(Icons.arrow_downward_rounded, size: 18, color: colors.ink, semanticLabel: '回到底部'),
          ),
        ),
      ),
    );
  }
}

/// Keeps the conversation pinned to its end while the reader is there.
///
/// The pin is applied during layout, in the same frame the content or the
/// viewport changes. Following the end with a jump after the frame (as before)
/// painted one frame out of place each time a message arrived, a queued
/// message turned into a real one or the input box changed height, which read
/// as the window shaking (extra test 7).
///
/// Any scroll by the reader (wheel, drag, scrollbar, keys) that leaves the end
/// lets go at once; only reaching the very end again, or the 「回到底部」 button,
/// takes it back. (v0.3.2 test: with an 80-pixel slack, one wheel notch while
/// a reply streamed stayed inside it and was pulled straight back down.)
class _BottomAnchoredController extends ScrollController {
  _BottomAnchoredController() {
    // Listeners hear every scroll (drag, wheel, scrollbar, jumpTo) but not the
    // layout-time pin, which uses correctPixels.
    addListener(() {
      if (hasClients) stick = position.maxScrollExtent - position.pixels < _slack;
    });
  }

  /// Whether the reader is at the end (the button shows when they are not).
  final following = ValueNotifier<bool>(true);

  bool get stick => following.value;
  set stick(bool value) => following.value = value;

  /// Rounding room only: a reader one wheel notch up is reading, not following.
  static const _slack = 2.0;

  /// The 「回到底部」 button: back to the end, and follow it from there.
  void toEnd() {
    stick = true;
    if (hasClients) jumpTo(position.maxScrollExtent);
  }

  /// How much rows wholly above the view grew in this layout (see [_AnchoredRow]).
  double _anchor = 0;

  void _anchorBy(double delta) => _anchor += delta;

  @override
  void dispose() {
    following.dispose();
    super.dispose();
  }

  @override
  ScrollPosition createScrollPosition(ScrollPhysics physics, ScrollContext context, ScrollPosition? oldPosition) =>
      _BottomAnchoredPosition(this, physics: physics, context: context, oldPosition: oldPosition);
}

class _BottomAnchoredPosition extends ScrollPositionWithSingleContext {
  _BottomAnchoredPosition(this._owner, {required super.physics, required super.context, super.oldPosition});

  final _BottomAnchoredController _owner;

  @override
  bool applyContentDimensions(double minScrollExtent, double maxScrollExtent) {
    // A reader away from the end keeps the text in front of them: rows above
    // the view that changed height move the offset by as much.
    final anchor = _owner._anchor;
    _owner._anchor = 0;
    if (anchor != 0 && !_owner.stick && hasPixels) {
      // correctBy, not correctPixels: a fling in progress carries on from here.
      correctBy(anchor);
      super.applyContentDimensions(minScrollExtent, maxScrollExtent);
      return false;
    }
    final settled = super.applyContentDimensions(minScrollExtent, maxScrollExtent);
    if (_owner.stick && hasPixels && pixels != maxScrollExtent && activity is! DragScrollActivity && activity is! BallisticScrollActivity) {
      correctPixels(maxScrollExtent);
      return false; // lay out again at the new offset, before painting
    }
    return settled;
  }
}

/// One row of the conversation that tells the list when it changes height
/// while wholly above the view.
///
/// Rows scrolled away are built again when they come back: a card opened
/// short and grew to its full height, an image appeared once decoded, a folded
/// step lost its state. Everything below moved down, so a reader scrolled up
/// saw the conversation jump (v0.3.3 test: 「时不时往上弹」). The list now
/// moves its offset by the same amount, like scroll anchoring in browsers.
/// A row on screen is left alone: it is what the reader is looking at.
class _AnchoredRow extends SingleChildRenderObjectWidget {
  const _AnchoredRow({required this.controller, required super.child});

  final _BottomAnchoredController controller;

  @override
  RenderObject createRenderObject(BuildContext context) => _RenderAnchoredRow(controller);

  @override
  void updateRenderObject(BuildContext context, _RenderAnchoredRow renderObject) => renderObject.controller = controller;
}

class _RenderAnchoredRow extends RenderProxyBox {
  _RenderAnchoredRow(this.controller);

  _BottomAnchoredController controller;
  double? _height;

  @override
  void performLayout() {
    super.performLayout();
    final before = _height;
    _height = size.height;
    if (before == null || before == size.height || controller.stick) return;
    // The list's own child that holds this row, and the list.
    RenderObject? item = this;
    while (item != null && item.parentData is! SliverMultiBoxAdaptorParentData) {
      item = item.parent;
    }
    final list = item?.parent;
    if (item == null || list is! RenderSliver) return;
    final top = (item.parentData! as SliverMultiBoxAdaptorParentData).layoutOffset;
    if (top != null && top + before <= list.constraints.scrollOffset + 0.5) controller._anchorBy(size.height - before);
  }
}

/// What can be done with the conversation, in plain sight in the details panel
/// (0.4, test 27: they were hidden in the title bar's 「⋯」): turn it into a skill
/// or template, carry on at set times, see or refresh the memory it was given.
class SessionActions extends StatelessWidget {
  const SessionActions({super.key});

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final hasContent = agent.isReady && !(agent.active?.isPristine ?? true);
    final remembers = !(agent.active?.incognito ?? false) && agent.coreSettings['memoryEnabled'] != false;
    Widget action(String id, IconData icon, String label, String tip, bool enabled) => Tooltip(
      message: tip,
      child: OutlinedButton.icon(
        onPressed: enabled ? () => _run(context, id) : null,
        style: OutlinedButton.styleFrom(
          alignment: Alignment.centerLeft,
          minimumSize: const Size(0, 36),
          padding: const EdgeInsets.symmetric(horizontal: 10),
          side: BorderSide(color: context.colors.border),
          backgroundColor: context.colors.card,
        ),
        icon: Icon(icon, size: 16),
        label: Text(label, overflow: TextOverflow.ellipsis),
      ),
    );
    final buttons = [
      action('skill', Icons.auto_fix_high_outlined, '存成技能', '把这次的做法整理成可复用的技能', hasContent && !agent.isRunning),
      action('template', Icons.post_add_outlined, '存为模板', '把最后一条请求存成任务模板', hasContent),
      action('schedule', Icons.schedule, '定时接着做', '按时间在这个会话里继续，比如每天汇报进度', hasContent && agent.active?.sessionPath != null && !(agent.active?.incognito ?? false)),
      action('snapshots', Icons.psychology_alt_outlined, '用到的记忆', '看这个会话带上的记忆快照', remembers && agent.activeSessionId != null),
      action('refresh', Icons.refresh, '刷新记忆快照', '下一条消息带上最新的记忆', remembers && hasContent),
    ];
    return LayoutBuilder(
      builder: (context, constraints) {
        final half = (constraints.maxWidth - 8) / 2;
        return Wrap(spacing: 8, runSpacing: 8, children: [for (final b in buttons) SizedBox(width: half, child: b)]);
      },
    );
  }

  Future<void> _run(BuildContext context, String action) async {
    final agent = AgentScope.read(context);
    switch (action) {
      case 'skill':
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('正在用辅助模型整理这次的做法，大约需要几十秒…'), behavior: SnackBarBehavior.floating, width: 520),
        );
        await agent.draftSkillFromSession();
      case 'template':
        final draft = await agent.draftTemplateFromSession();
        if (draft == null || !context.mounted) return;
        final saved = await showTemplateEditor(
          context,
          name: draft['name'] as String? ?? '',
          description: draft['description'] as String? ?? '',
          body: draft['body'] as String? ?? '',
        );
        if (saved && context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('模板已保存，可以在「技能」页运行，或在输入框里输入 /模板名。'), behavior: SnackBarBehavior.floating, width: 520),
          );
        }
      case 'schedule':
        final path = agent.active?.sessionPath;
        if (path == null) return;
        if (await showScheduleEditor(context, session: path) && context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('定时任务已保存，可以在「任务 › 定时」里查看和修改。'), behavior: SnackBarBehavior.floating, width: 520),
          );
        }
      case 'refresh':
        await agent.refreshMemorySnapshot();
      case 'snapshots':
        final snapshots = await agent.memorySnapshots();
        if (!context.mounted) return;
        await showTextDialog(
          context,
          title: '这个会话用到的记忆',
          text: snapshots.isEmpty
              ? '这个会话还没有带上记忆快照（可能是记忆为空，或者还没发出第一条消息）。'
              : [for (final s in snapshots) s['content'] as String? ?? ''].join('\n\n────────\n\n'),
        );
    }
  }
}

// ---------------------------------------------------------------------------
// Banners and empty state
// ---------------------------------------------------------------------------

class _ProblemBanner extends StatelessWidget {
  const _ProblemBanner({required this.status, required this.detail, this.reconnecting = false});

  final ConnectionStatus status;
  final String detail;

  /// The core connection dropped and the controller is reconnecting by itself.
  final bool reconnecting;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final crashed = status == ConnectionStatus.crashed;
    return Container(
      margin: const EdgeInsets.fromLTRB(AppTokens.padLg, AppTokens.pad, AppTokens.padLg, 0),
      padding: const EdgeInsets.all(AppTokens.pad),
      decoration: BoxDecoration(
        color: colors.danger.withValues(alpha: 0.08),
        border: Border.all(color: colors.danger.withValues(alpha: 0.4)),
        borderRadius: BorderRadius.circular(context.radius),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.error_outline, color: colors.danger, size: 20),
          const SizedBox(width: AppTokens.pad),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(reconnecting ? '后台连接中断' : crashed ? '会话已断开' : '后台服务没有启动', style: context.text.titleSmall),
                const SizedBox(height: 4),
                SelectableText(
                  detail,
                  style: context.text.bodySmall?.copyWith(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback),
                ),
              ],
            ),
          ),
          if (crashed && !reconnecting) ...[
            const SizedBox(width: AppTokens.pad),
            OutlinedButton.icon(
              onPressed: AgentScope.read(context).restart,
              icon: const Icon(Icons.refresh, size: 16),
              label: const Text('重新打开'),
            ),
          ],
        ],
      ),
    );
  }
}

/// A run the core was doing when it last stopped (crash, reboot): offer to
/// pick it up again or dismiss it.
class _InterruptedRunCard extends StatelessWidget {
  const _InterruptedRunCard({required this.run});

  final InterruptedRun run;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final agent = AgentScope.read(context);
    final what = (run.prompt ?? '').replaceAll(RegExp(r's+'), ' ').trim();
    return Container(
      margin: const EdgeInsets.fromLTRB(AppTokens.padLg, AppTokens.pad, AppTokens.padLg, 0),
      padding: const EdgeInsets.symmetric(horizontal: AppTokens.pad, vertical: AppTokens.gap),
      decoration: BoxDecoration(
        color: colors.warning.withValues(alpha: 0.08),
        border: Border.all(color: colors.warning.withValues(alpha: 0.4)),
        borderRadius: BorderRadius.circular(context.radius),
      ),
      child: Row(
        children: [
          Icon(Icons.history_toggle_off, color: colors.warning, size: 20),
          const SizedBox(width: AppTokens.pad),
          Expanded(
            child: Text(
              what.isEmpty ? '有一个任务在后台停止时被中断了' : '任务被中断：$what',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          TextButton(onPressed: () => agent.dismissInterrupted(run), child: const Text('忽略')),
          const SizedBox(width: AppTokens.gap),
          FilledButton.tonal(onPressed: () => agent.resumeInterrupted(run), child: const Text('继续')),
        ],
      ),
    );
  }
}

class _ContextWarning extends StatelessWidget {
  const _ContextWarning({required this.percent});

  final double percent;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: AppTokens.contentMaxWidth),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(AppTokens.padLg + 8, 4, AppTokens.padLg + 8, 0),
          child: Row(
            children: [
              Icon(Icons.warning_amber_rounded, size: 16, color: colors.warning),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  '上下文已用 ${percent.toStringAsFixed(0)}%，快满了。可以压缩较早的对话，或者开一个新会话。',
                  style: context.text.bodySmall?.copyWith(color: colors.warning),
                ),
              ),
              TextButton(onPressed: () => showContextDialog(context), child: const Text('管理上下文')),
            ],
          ),
        ),
      ),
    );
  }
}
