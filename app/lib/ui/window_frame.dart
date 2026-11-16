import 'dart:async';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:window_manager/window_manager.dart';
import 'package:pi_rpc/pi_rpc.dart' show SessionStore;

import '../state/agent_controller.dart';
import '../theme.dart';
import 'butterfly_motion.dart';
import 'agent_scope.dart';
import 'proto_icon.dart';
import 'sidebar.dart' show sidebarGoalStatuses;

/// The workspace menu of the title bar; the sidebar's switch button and
/// Ctrl+O open the same menu (0.4: where to switch workspaces must be obvious).
final workspaceMenu = MenuController();

/// Opens the workspace menu, showing the workbench first when another page is up.
void openWorkspaceMenu(AgentController agent) {
  final main = agent.main;
  if (main.section != AppSection.chat) {
    main.showSection(AppSection.chat);
    WidgetsBinding.instance.addPostFrameCallback((_) => workspaceMenu.open());
  } else {
    workspaceMenu.open();
  }
}

/// Asks for a folder and makes it the workspace.
Future<void> pickWorkspaceFolder(AgentController agent) async {
  final directory = await getDirectoryPath(
    initialDirectory: agent.workspace.isEmpty ? null : agent.workspace,
    confirmButtonText: '设为工作区',
  );
  if (directory != null) await agent.setWorkspace(directory);
}

/// The window's title bar. Two forms (T-143, 2026-11-16 user: 照原型改):
///
/// * [contentOnly] — on the main window, over the page column only (the sidebar runs to the top of
///   the window, as in the 1.0 prototype). It carries the prototype's page header: on a conversation
///   「标题 · 工作区 · 记忆开」 (蝶君: 「标题 · 在推进」), 分支 and the details toggle; nothing on a fresh
///   conversation or the other pages, whose own calligraphy titles say where you are. The window's
///   own buttons sit at its right end.
/// * otherwise — the mark and name with the window buttons, for the setup pages and full pages
///   pushed over the window (channel / model group editors).
///
/// The blank part drags the window and double-clicks to maximize (the real window only).
class AppTitleBar extends StatefulWidget {
  const AppTitleBar({
    super.key, required this.windowButtons, this.brandOnly = false, this.contentOnly = false,
    this.captionOnly = false, this.showCaptionButtons = true, this.captionInset = 0,
    this.active = true, this.leading,
  });

  /// The real window: drag to move, double-click to maximize, and the caption buttons (tests leave them off).
  final bool windowButtons;
  final bool brandOnly;
  final bool contentOnly;
  final bool captionOnly;
  final bool showCaptionButtons;
  final double captionInset;
  final bool active;

  /// Before the header (the 「展开侧栏」 button while the sidebar is folded away).
  final Widget? leading;

  static const height = 48.0;
  static const captionWidth = 138.0;

  /// Set by [DreamFlutterApp]: whether this is the real window (its own caption buttons).
  static bool realWindow = false;

  @override
  State<AppTitleBar> createState() => _AppTitleBarState();
}

class _AppTitleBarState extends State<AppTitleBar> with WindowListener {
  var _maximized = false;
  bool get _hasCaption => widget.windowButtons && widget.showCaptionButtons;

  @override
  void initState() {
    super.initState();
    if (!widget.captionOnly) HardwareKeyboard.instance.addHandler(_onKey);
    if (_hasCaption) {
      windowManager.addListener(this);
      windowManager.isMaximized().then((value) {
        if (mounted) setState(() => _maximized = value);
      });
    }
  }

  @override
  void dispose() {
    if (!widget.captionOnly) HardwareKeyboard.instance.removeHandler(_onKey);
    if (_hasCaption) windowManager.removeListener(this);
    super.dispose();
  }

  @override
  void onWindowMaximize() => setState(() => _maximized = true);

  @override
  void onWindowUnmaximize() => setState(() => _maximized = false);

  /// Ctrl+O: the workspace menu (Esc closes it, also when the keyboard opened it and focus is elsewhere).
  bool _onKey(KeyEvent event) {
    if (!widget.active) return false;
    if (event is KeyDownEvent && event.logicalKey == LogicalKeyboardKey.escape && workspaceMenu.isOpen) {
      workspaceMenu.close();
      return true;
    }
    if (!widget.contentOnly) return false;
    if (event is! KeyDownEvent || event.logicalKey != LogicalKeyboardKey.keyO) return false;
    final keys = HardwareKeyboard.instance;
    if (!keys.isControlPressed || keys.isAltPressed || keys.isShiftPressed || keys.isMetaPressed) return false;
    final agent = AgentScope.read(context).main;
    if (agent.workspace.isEmpty && agent.recentWorkspaces.isEmpty) return false;
    openWorkspaceMenu(agent);
    return true;
  }

  List<Widget> _captionButtons(Brightness brightness) => [
    if (_hasCaption) ...[
      WindowCaptionButton.minimize(brightness: brightness, onPressed: windowManager.minimize),
      _maximized
          ? WindowCaptionButton.unmaximize(brightness: brightness, onPressed: windowManager.unmaximize)
          : WindowCaptionButton.maximize(brightness: brightness, onPressed: windowManager.maximize),
      WindowCaptionButton.close(brightness: brightness, onPressed: windowManager.close),
    ],
  ];

  @override
  Widget build(BuildContext context) {
    if (widget.captionOnly) {
      return SizedBox(width: AppTitleBar.captionWidth, height: AppTitleBar.height,
        child: Row(children: _captionButtons(Theme.of(context).brightness)),
      );
    }
    return widget.contentOnly ? _content(context) : _brand(context);
  }

  Widget _drag(Widget child) => widget.windowButtons ? DragToMoveArea(child: child) : child;

  /// The setup pages and pushed full pages: the mark and name, the window buttons.
  Widget _brand(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final brightness = Theme.of(context).brightness;
    // Setup: the brand heads a sidebar-wide column (prototype). A pushed page: just the brand.
    final screen = MediaQuery.sizeOf(context).width;
    final zoom = agent.zoom;
    final besideSidebar = widget.brandOnly && screen / zoom >= 760;
    final sideWidth = agent.sidebarWidth.clamp(180.0, screen / zoom * 0.36) * zoom;
    final brand = _drag(
      Padding(
        padding: const EdgeInsets.only(left: 16, right: 12),
        child: Row(
          mainAxisSize: besideSidebar ? MainAxisSize.max : MainAxisSize.min,
          children: [
            ListenableBuilder(listenable: agent, builder: (context, _) => ButterflyAvatar(size: 26, activity: butterflyActivity(agent))),
            const SizedBox(width: 10),
            Flexible(child: Text('DreamFlutter', maxLines: 1, softWrap: false, overflow: TextOverflow.fade, style: context.serif(context.text.titleSmall).copyWith(fontSize: 17, fontWeight: FontWeight.w700, color: colors.ink))),
            const SizedBox(width: 6),
            Text('梦蝶', maxLines: 1, softWrap: false, style: context.text.bodySmall?.copyWith(fontSize: 13, color: colors.muted)),
          ],
        ),
      ),
    );
    return Material(
      color: colors.background,
      child: SizedBox(
        height: AppTitleBar.height,
        child: Row(children: [
          if (besideSidebar)
            Container(
              width: sideWidth + 0.5,
              decoration: BoxDecoration(color: colors.sidebar, border: Border(right: BorderSide(color: colors.border, width: 0.5))),
              alignment: Alignment.centerLeft,
              child: brand,
            )
          else
            brand,
          Expanded(child: _drag(const SizedBox.expand())),
          ..._captionButtons(brightness),
        ]),
      ),
    );
  }

  /// The main window's page header (prototype 02-chat / 03-chat-butterfly).
  Widget _content(BuildContext context) {
    final agent = AgentScope.of(context).main;
    final colors = context.colors;
    final brightness = Theme.of(context).brightness;
    final butterfly = agent.butterfly;
    final onButterfly = agent.section == AppSection.butterfly;
    // Whose conversation is on screen: 蝶君's on its page, the workbench's otherwise.
    final AgentController? talking = switch (agent.section) {
      AppSection.chat => agent,
      AppSection.butterfly => butterfly,
      _ => null,
    };
    final muted = context.text.bodySmall?.copyWith(fontSize: 12.5, color: colors.muted);
    Widget dot() => Padding(padding: const EdgeInsets.symmetric(horizontal: 7), child: Text('·', style: muted));
    Widget header(AgentController c) {
      if (c.transcript.items.isEmpty) return const SizedBox.shrink();
      final parts = <Widget>[Flexible(child: _Title(text: c.sessionTitle))];
      if (c.sandbox) {
        final goal = goalStatusWord(c);
        if (goal != null) parts.addAll([const SizedBox(width: 8), Container(width: 6, height: 6, decoration: BoxDecoration(color: goal.$2 ? colors.success : colors.ochre, shape: BoxShape.circle)), const SizedBox(width: 5), Text(goal.$1, style: muted)]);
      } else {
        if (c.workspace.isNotEmpty) {
          final name = c.workspace.split(RegExp(r'[\\/]')).where((s) => s.isNotEmpty).lastOrNull ?? c.workspace;
          parts.addAll([dot(), Flexible(child: Tooltip(message: name, child: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: muted)))]);
        }
        parts.addAll([dot(), Text(c.coreSettings['memoryEnabled'] == false ? '记忆关' : '记忆开', style: muted)]);
      }
      return Row(mainAxisSize: MainAxisSize.min, children: parts);
    }

    return Material(
      color: Colors.transparent,
      child: SizedBox(
        height: AppTitleBar.height,
        child: Row(children: [
          if (widget.leading != null) Padding(padding: const EdgeInsets.only(left: 8), child: widget.leading!),
          const SizedBox(width: 20),
          // The header over the drag area: the blank part moves the window, and the buttons after
          // it sit at the right edge.
          Expanded(
            child: Stack(children: [
              Positioned.fill(child: _drag(const SizedBox.expand())),
              Align(
                alignment: Alignment.centerLeft,
                child: talking == null ? const SizedBox.shrink() : ListenableBuilder(listenable: Listenable.merge([talking, sidebarGoalStatuses]), builder: (context, _) => header(talking)),
              ),
            ]),
          ),
          // 「分支」只在对话有内容时出现（原型首页顶上是空的）。
          if (agent.section == AppSection.chat && !agent.butterflySpace && agent.transcript.items.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(right: 6),
              child: TextButton.icon(
                onPressed: agent.active == null || agent.active!.isRunning || agent.active!.incognito ? null : () => agent.forkAfterReply(null),
                style: TextButton.styleFrom(
                  foregroundColor: colors.ink, disabledForegroundColor: colors.muted, backgroundColor: colors.card,
                  padding: const EdgeInsets.symmetric(horizontal: 10), minimumSize: const Size(0, 30), tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  textStyle: const TextStyle(fontSize: 13),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8), side: BorderSide(color: colors.border.withValues(alpha: .6))),
                ),
                icon: const ProtoIcon('branch', size: 14),
                label: const Text('分支'),
              ),
            ),
          if (talking != null)
            ListenableBuilder(
              listenable: talking,
              builder: (context, _) {
                final incognito = talking.active?.incognito ?? false;
                final open = talking.runPanelOpen && !incognito;
                return IconButton(
                  tooltip: incognito ? '无痕对话没有详情' : (open ? '收起详情' : (onButterfly ? '详情：任务进度' : '详情：这个对话')),
                  isSelected: open,
                  onPressed: incognito ? null : () => talking.setRunPanelOpen(!open),
                  style: IconButton.styleFrom(foregroundColor: open ? colors.accent : colors.ink2, backgroundColor: open ? colors.accentSoft : null, minimumSize: const Size(30, 30), fixedSize: const Size(30, 30), padding: EdgeInsets.zero, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8))),
                  icon: const ProtoIcon('panel'),
                );
              },
            ),
          SizedBox(width: 6 + widget.captionInset),
          ..._captionButtons(brightness),
        ]),
      ),
    );
  }
}

/// 蝶君's conversation status for the header (「在推进」 with a green dot, or 「暂停了」…), or null.
(String, bool)? goalStatusWord(AgentController c) {
  final path = c.currentSessionPath;
  if (path == null) return null;
  final status = sidebarGoalStatuses.value.entries.where((e) => SessionStore.samePath(e.key, path)).firstOrNull?.value;
  return switch (status) {
    'running' => ('在推进', true), 'queued' => ('排队中', true), 'reviewing' => ('等你验收', false),
    'paused' => ('暂停了', false), 'blocked' || 'uncertain' => ('卡住了', false), _ => null,
  };
}

class _Title extends StatelessWidget {
  const _Title({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) => Text(
    text,
    maxLines: 1,
    overflow: TextOverflow.ellipsis,
    style: context.text.bodyMedium?.copyWith(fontSize: 13, fontWeight: FontWeight.w500, color: context.colors.ink),
  );
}

/// A strip on the edge of a column the user drags to resize it; [onDone] saves the width.
class ResizeHandle extends StatefulWidget {
  const ResizeHandle({super.key, required this.width, required this.min, required this.max, required this.onChanged, required this.onDone, this.leftEdge = false});

  final double width;
  final double min;
  final double max;

  /// The handle is on the column's left edge (the panel on the right grows when dragged left).
  final bool leftEdge;
  final ValueChanged<double> onChanged;
  final ValueChanged<double> onDone;

  @override
  State<ResizeHandle> createState() => _ResizeHandleState();
}

class _ResizeHandleState extends State<ResizeHandle> {
  double? _dragging;
  var _hovered = false;

  @override
  Widget build(BuildContext context) {
    final active = _hovered || _dragging != null;
    return MouseRegion(
      cursor: SystemMouseCursors.resizeColumn,
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: GestureDetector(
        behavior: HitTestBehavior.translucent,
        onHorizontalDragStart: (_) => setState(() => _dragging = widget.width),
        onHorizontalDragUpdate: (details) {
          final next = ((_dragging ?? widget.width) + (widget.leftEdge ? -details.delta.dx : details.delta.dx));
          _dragging = next;
          widget.onChanged(next.clamp(widget.min, widget.max));
        },
        onHorizontalDragEnd: (_) {
          final width = (_dragging ?? widget.width).clamp(widget.min, widget.max);
          setState(() => _dragging = null);
          widget.onDone(width);
        },
        child: SizedBox(
          width: 6,
          child: Center(
            child: AnimatedContainer(
              duration: AppTokens.motion(context, AppTokens.fast),
              curve: AppTokens.curve,
              width: active ? 2 : 0,
              color: Theme.of(context).colorScheme.primary.withValues(alpha: 0.5),
            ),
          ),
        ),
      ),
    );
  }
}
