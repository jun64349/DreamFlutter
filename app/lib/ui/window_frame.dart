import 'dart:async';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart' show SessionStore;
import 'package:window_manager/window_manager.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'butterfly_motion.dart';
import 'agent_scope.dart';

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

/// The window's title bar (0.4, the design's option 1 bar on option 3):
/// the mark and name, where you are (工作台 / workspace / conversation), the
/// details toggle and, on the real window, minimize / maximize / close. It sits
/// above the interface zoom and the pages, so it stays put on every page.
class AppTitleBar extends StatefulWidget {
  const AppTitleBar({super.key, required this.windowButtons,this.brandOnly=false});

  /// The real window: drag to move, double-click to maximize, and the caption buttons (tests leave them off).
  final bool windowButtons;
  final bool brandOnly;

  static const height = 48.0;

  @override
  State<AppTitleBar> createState() => _AppTitleBarState();
}

class _AppTitleBarState extends State<AppTitleBar> with WindowListener {
  var _maximized = false;

  @override
  void initState() {
    super.initState();
    HardwareKeyboard.instance.addHandler(_onKey);
    if (widget.windowButtons) {
      windowManager.addListener(this);
      windowManager.isMaximized().then((value) {
        if (mounted) setState(() => _maximized = value);
      });
    }
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_onKey);
    if (widget.windowButtons) windowManager.removeListener(this);
    super.dispose();
  }

  @override
  void onWindowMaximize() => setState(() => _maximized = true);

  @override
  void onWindowUnmaximize() => setState(() => _maximized = false);

  /// Ctrl+O: the workspace menu (Esc closes it, also when the keyboard opened it and focus is elsewhere).
  bool _onKey(KeyEvent event) {
    if (event is KeyDownEvent && event.logicalKey == LogicalKeyboardKey.escape && workspaceMenu.isOpen) {
      workspaceMenu.close();
      return true;
    }
    if (widget.brandOnly) return false;
    if (event is! KeyDownEvent || event.logicalKey != LogicalKeyboardKey.keyO) return false;
    final keys = HardwareKeyboard.instance;
    if (!keys.isControlPressed || keys.isAltPressed || keys.isShiftPressed || keys.isMetaPressed) return false;
    final agent = AgentScope.read(context);
    if (agent.workspace.isEmpty && agent.recentWorkspaces.isEmpty) return false;
    openWorkspaceMenu(agent);
    return true;
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final brightness = Theme.of(context).brightness;
    final butterfly = agent.butterfly;
    final onButterfly = agent.section == AppSection.butterfly;
    // Whose conversation is on screen: 蝶君's on its page, the workbench's otherwise.
    final AgentController? talking = widget.brandOnly ? null : switch (agent.section) {
      AppSection.chat => agent,
      AppSection.butterfly => butterfly,
      _ => null,
    };
    Widget drag(Widget child) => widget.windowButtons ? DragToMoveArea(child: child) : child;

    // 1.0 prototype (interaction-v2.html): the brand heads the sidebar column and the bar over the
    // page only spans the page. The bar sits outside the zoom, so the sidebar's column is scaled here.
    final screen = MediaQuery.sizeOf(context).width;
    final zoom = agent.zoom;
    final besideSidebar = !widget.brandOnly && screen / zoom >= 760;
    final sideWidth = agent.sidebarWidth.clamp(180.0, screen / zoom * 0.36) * zoom;
    final brand = drag(
      Padding(
        padding: const EdgeInsets.only(left: 16, right: 12),
        child: Row(
          mainAxisSize: besideSidebar ? MainAxisSize.max : MainAxisSize.min,
          children: [
            ListenableBuilder(listenable: talking ?? agent, builder: (context, _) => ButterflyAvatar(size: 26, activity: butterflyActivity(talking ?? agent))),
            const SizedBox(width: 10),
            // A narrow sidebar clips the name instead of overflowing the bar.
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
        child: Row(
          children: [
            if (besideSidebar)
              Container(
                width: sideWidth + 0.5,
                decoration: BoxDecoration(color: colors.sidebar, border: Border(right: BorderSide(color: colors.border, width: 0.5))),
                alignment: Alignment.centerLeft,
                child: brand,
              )
            else
              brand,
            Expanded(child: Container(
              decoration: BoxDecoration(border: Border(bottom: BorderSide(color: colors.ink.withValues(alpha: 0.07)))),
              child: Row(children: [
            const SizedBox(width: 14),
            // The breadcrumb over the drag area: the blank part moves the window, and the
            // buttons after it sit at the right edge. (A Flexible breadcrumb beside an Expanded
            // drag area left its unused share as a gap after the window buttons, v0.4.0.)
            Expanded(
              child: Stack(
                children: [
                  Positioned.fill(child: drag(const SizedBox.expand())),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: ValueListenableBuilder<ButterflyTab>(
                      valueListenable: agent.butterflyTab,
                      builder: (context, tab, _) {
                        if(widget.brandOnly)return const SizedBox.shrink();
                        final crumbs = <Widget>[];
                        void sep() => crumbs.add(Padding(padding: const EdgeInsets.symmetric(horizontal: 6), child: Text('/', style: _muted(context))));
                        switch (agent.section) {
                          case AppSection.chat:
                            crumbs.add(Text('工作台', style: _muted(context)));
                            sep();
                            crumbs.add(const _WorkspaceButton());
                            sep();
                            crumbs.add(Flexible(child: _Title(text: agent.sessionTitle)));
                          case AppSection.butterfly:
                            // Its page has 「交流」 and 「工作」 in its own header; here the conversation's title.
                            crumbs.add(Text('蝶君', style: _muted(context)));
                            if (tab == ButterflyTab.talk && butterfly != null) {
                              sep();
                              crumbs.add(Flexible(child: ListenableBuilder(listenable: butterfly, builder: (context, _) => _Title(text: butterfly.sessionTitle))));
                            }
                          case AppSection.tasks:
                            crumbs.add(const _Title(text: '等你处理'));
                          case AppSection.memory:
                            crumbs.add(const _Title(text: '记忆'));
                          case AppSection.library:
                            crumbs.add(const _Title(text: '技能'));
                          case AppSection.spending:
                            crumbs.add(const _Title(text: '花费'));
                          case AppSection.settings:
                            crumbs.add(const _Title(text: '设置'));
                        }
                        return Row(mainAxisSize: MainAxisSize.min, children: crumbs);
                      },
                    ),
                  ),
                ],
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
                    style: IconButton.styleFrom(foregroundColor: open ? colors.accent : colors.muted, backgroundColor: open ? colors.accentSoft : null),
                    icon: const Icon(Icons.view_sidebar_outlined, size: 19),
                  );
                },
              ),
            const SizedBox(width: 6),
            if (widget.windowButtons) ...[
              WindowCaptionButton.minimize(brightness: brightness, onPressed: windowManager.minimize),
              _maximized
                  ? WindowCaptionButton.unmaximize(brightness: brightness, onPressed: windowManager.unmaximize)
                  : WindowCaptionButton.maximize(brightness: brightness, onPressed: windowManager.maximize),
              WindowCaptionButton.close(brightness: brightness, onPressed: windowManager.close),
            ],
              ]),
            )),
          ],
        ),
      ),
    );
  }

  static TextStyle? _muted(BuildContext context) => context.text.bodySmall?.copyWith(fontSize: 13, color: context.colors.muted);
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

/// The workspace in the title bar: a button that opens the list of workspaces.
class _WorkspaceButton extends StatelessWidget {
  const _WorkspaceButton();

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final current = agent.workspace;
    final others = agent.recentWorkspaces.where((w) => !SessionStore.samePath(w, current)).toList();
    final muted = context.text.bodySmall?.copyWith(color: colors.muted);
    Widget row(String path, {required bool selected}) => Row(
      children: [
        Icon(Icons.folder_outlined, size: 18, color: colors.ochre),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(p.basename(path), overflow: TextOverflow.ellipsis, style: context.text.bodyMedium?.copyWith(fontWeight: selected ? FontWeight.w600 : null)),
              Text(path, overflow: TextOverflow.ellipsis, style: muted?.copyWith(fontSize: 11)),
            ],
          ),
        ),
        if (selected) ...[const SizedBox(width: 8), Icon(Icons.check, size: 16, color: colors.accent)],
      ],
    );
    final itemStyle = MenuItemButton.styleFrom(minimumSize: const Size(320, 48), padding: const EdgeInsets.symmetric(horizontal: 10));
    return MenuAnchor(
      controller: workspaceMenu,
      alignmentOffset: const Offset(0, 6),
      style: MenuStyle(
        backgroundColor: WidgetStatePropertyAll(colors.card),
        side: WidgetStatePropertyAll(BorderSide(color: colors.border)),
        shape: WidgetStatePropertyAll(RoundedRectangleBorder(borderRadius: BorderRadius.circular(10))),
        padding: const WidgetStatePropertyAll(EdgeInsets.all(6)),
      ),
      menuChildren: [
        Padding(
          padding: const EdgeInsets.fromLTRB(10, 4, 10, 6),
          child: SizedBox(
            width: 320,
            child: Row(children: [Text('切换工作区', style: context.label), const Spacer(), Text('Ctrl O', style: muted?.copyWith(fontSize: 11))]),
          ),
        ),
        if (current.isNotEmpty) MenuItemButton(style: itemStyle, onPressed: () {}, child: SizedBox(width: 320, child: row(current, selected: true))),
        for (final w in others) MenuItemButton(style: itemStyle, onPressed: () => agent.setWorkspace(w), child: SizedBox(width: 320, child: row(w, selected: false))),
        const Divider(height: 9),
        MenuItemButton(leadingIcon: const Icon(Icons.create_new_folder_outlined, size: 18), onPressed: () => pickWorkspaceFolder(agent), child: const Text('打开文件夹作为工作区…')),
        if (current.isNotEmpty)
          MenuItemButton(leadingIcon: const Icon(Icons.open_in_new, size: 18), onPressed: () => agent.revealInExplorer(current), child: const Text('在资源管理器中显示')),
      ],
      builder: (context, controller, _) => Tooltip(
        message: '工作区：Agent 在这个文件夹里读写文件、执行命令（Ctrl O 切换）',
        child: InkWell(
          borderRadius: BorderRadius.circular(6),
          onTap: () => controller.isOpen ? controller.close() : controller.open(),
          child: Container(
            height: 28,
            padding: const EdgeInsets.only(left: 6, right: 6),
            decoration: BoxDecoration(color: colors.card, border: Border.all(color: colors.border), borderRadius: BorderRadius.circular(6)),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.folder_outlined, size: 16, color: colors.ochre),
                const SizedBox(width: 6),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 220),
                  child: Text(
                    current.isEmpty ? '选择工作区' : p.basename(current),
                    overflow: TextOverflow.ellipsis,
                    style: context.text.bodySmall?.copyWith(fontSize: 13, color: colors.ink),
                  ),
                ),
                const SizedBox(width: 4),
                Icon(Icons.expand_more, size: 16, color: colors.muted),
              ],
            ),
          ),
        ),
      ),
    );
  }
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
