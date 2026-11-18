import 'dart:async';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'proto_icon.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

import '../craft_style.dart';
import 'craft_surface.dart';
import '../state/agent_controller.dart';
import '../state/preferences.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'motion.dart';
import 'conversation_actions.dart';
import 'artifact_widgets.dart';
import 'package:window_manager/window_manager.dart' show DragToMoveArea;
import 'window_frame.dart';
import 'shell_widgets.dart';
import 'onboarding_tour.dart';

/// The one sidebar of the window (0.4, design option 3): 工作台 / 蝶君 at the
/// top with new conversation, search and tasks; the conversations of the
/// current workspace (or 蝶君's on its page); user avatar, spending and
/// settings at the bottom. Its width is dragged on its right edge.
class Sidebar extends StatefulWidget {
  const Sidebar({super.key, this.onCollapse});
  final VoidCallback? onCollapse;

  @override
  State<Sidebar> createState() => _SidebarState();
}

class _SidebarState extends State<Sidebar> {
  AgentController? _owner;
  StreamSubscription<Json>? _goalEvents;
  Map<String, String> _goals = {};
  int _goalRequest = 0;
  @override void didChangeDependencies() { super.didChangeDependencies(); final owner = AgentScope.read(context); if (_owner == owner) return; _owner = owner; _goalEvents?.cancel(); _goalEvents = owner.backend.events.listen((e) { if (e['event'] == 'goals.changed') unawaited(_loadGoals()); }); unawaited(_loadGoals()); }
  // The dots ask goals.bySession for exactly the listed conversations (at most 200, newest first).
  List<String> _goalPaths = const [];
  Future<void> _loadGoals() async {
    final request = ++_goalRequest, paths = _goalPaths;
    if (paths.isEmpty) { if (_goals.isNotEmpty) setState(() => _goals = {}); return; }
    try { final result = await _owner!.backend.call('goals.bySession', {'sessionFiles': paths}); if (!mounted || request != _goalRequest || result is! Map) return;
      final goals = asJsonMap(result['goals']);
      setState(() => _goals = {for (final e in goals.entries) if (e.value is Map && (e.value as Map)['kind'] != 'proposal') e.key: '${(e.value as Map)['status']}'});
      sidebarGoalStatuses.value = _goals;
    } catch (_) { /* The existing conversation list remains usable offline. */ }
  }
  void _watchGoalPaths(AgentController? lists) {
    final paths = [for (final e in lists?.sidebar ?? const <SidebarEntry>[]) if (e.path.isNotEmpty && !e.incognito) e.path].take(200).toList();
    if (listEquals(paths, _goalPaths)) return;
    _goalPaths = paths;
    WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted) unawaited(_loadGoals()); });
  }
  @override void dispose() { _goalRequest++; _goalEvents?.cancel(); super.dispose(); }
  /// The width while it is being dragged (saved when the drag ends).
  double? _width;
  final _searching = true;

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final section = agent.section;
    final onButterfly = agent.butterflySpace;
    // Whose conversations are listed: 蝶君's on its page, the workbench's everywhere else.
    final AgentController? lists = onButterfly ? agent.butterfly : agent;
    _watchGoalPaths(lists);
    final usable = agent.status != ConnectionStatus.missingRuntime;
    final width = (_width ?? agent.sidebarWidth).clamp(180.0, MediaQuery.sizeOf(context).width * 0.36);
    final name = (agent.coreSettings['userName'] as String? ?? '').trim();

    return _GoalDots(values: _goals, child: Stack(
      children: [
        SizedBox(
          width: width,
          child: PaintingBackdrop(
            surface: PaintingSurface.sidebar,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // 原型 #side 的 .brand：24 蝴蝶、衬线 18 强调色字标、11.5 「梦蝶」，右边 26 方的收起钮。
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 14, 10, 10),
                  child: Row(children: [
                    const ButterflyMark(size: 24),
                    const SizedBox(width: 8),
                    // 侧栏通到窗口顶部：字标这一块也能拖动窗口（真窗口）。
                    Expanded(child: _dragWindow(Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
                      Flexible(child: Text('DreamFlutter', maxLines: 1, overflow: TextOverflow.fade, softWrap: false, style: context.serif(context.text.titleSmall).copyWith(fontSize: 18, fontWeight: FontWeight.w700, letterSpacing: .2, color: colors.accent))),
                      const SizedBox(width: 8),
                      Text('梦蝶', style: context.text.bodySmall?.copyWith(fontSize: 11.5, color: colors.muted)),
                    ]))),
                    _SideIconButton(
                      tooltip: '收起侧栏（Ctrl + B）',
                      icon: 'side',
                      onPressed: widget.onCollapse ?? () => closeShellDrawer(context),
                    ),
                  ]),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
                  child: TourAnchor('place-switch', child: _PlaceSwitch(
                    butterfly: onButterfly,
                    workbench: !onButterfly,
                    onWorkbench: () => agent.showSection(AppSection.chat),
                    onButterfly: () => agent.openButterfly(),
                    butterflyBusy: (agent.butterfly?.backgroundRunning ?? 0) + ((agent.butterfly?.isRunning ?? false) ? 1 : 0) > 0 && !onButterfly,
                    workbenchBusy: agent.backgroundRunning > 0 && section != AppSection.chat,
                  )),
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      TourAnchor('nav-new', child: _NavRow(
                        icon: 'plus',
                        label: '新对话',
                        onTap: usable && lists != null
                            ? () {
                                lists.newSession();
                                agent.showSection(onButterfly ? AppSection.butterfly : AppSection.chat);
                                if (onButterfly) agent.butterflyTab.value = ButterflyTab.talk;
                              }
                            : null,
                      )),
                      TourAnchor('nav-attention', child: _NavRow(
                        icon: 'inbox',
                        label: '等你处理',
                        selected: section == AppSection.tasks,
                        badge: shellPendingCount(agent) == 0 ? null : '${shellPendingCount(agent)}',
                        onTap: () => agent.showSection(AppSection.tasks),
                      )),
                      if (onButterfly) _NavRow(icon: 'cal', label: '日程', selected: section == AppSection.schedules, onTap: () => agent.showSection(AppSection.schedules)),
                      // 原型：记忆、技能右边是淡色「新 N」，不是红色角标（红色只给「等你处理」）。
                      _NavRow(icon: 'memory', label: '记忆', selected: section == AppSection.memory, count: agent.pendingMemories == 0 ? null : '新 ${agent.pendingMemories}', onTap: () => agent.showSection(AppSection.memory)),
                      _NavRow(icon: 'skills', label: '技能', selected: section == AppSection.library, dot: agent.pendingProposals > 0, onTap: () => agent.showSection(AppSection.library)),
                    ],
                  ),
                ),
                const SizedBox(height: 14),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                    // 0.8.3 (user test): 蝶君's side lists its conversations like the workbench — a click opens
                    // one from any page; what needs you is in 「等你处理」, not on the list.
                    child: lists == null
                        ? const Padding(padding: EdgeInsets.all(10), child: SizedBox.shrink())
                        : AgentScope(
                            controller: lists,
                            child: _SessionPane(key: ValueKey(lists.sandbox), searching: _searching, onCloseSearch: () {}),
                          ),
                  ),
                ),
                const TourProgressCard(),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 8, 10, 10),
                  child: Row(children: [
                    Container(
                      width: 26, height: 26, alignment: Alignment.center,
                      decoration: BoxDecoration(color: colors.accentSoft, shape: BoxShape.circle),
                      child: Text(name.isEmpty ? '你' : name.characters.last, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: colors.accent)),
                    ),
                    const SizedBox(width: 8),
                    Expanded(child: Text(name.isEmpty ? '你' : name, maxLines: 1, overflow: TextOverflow.ellipsis, style: context.text.bodyMedium?.copyWith(fontSize: 13, color: colors.ink))),
                    _SideIconButton(icon: 'coin', tooltip: '花费', selected: section == AppSection.spending, onPressed: () { agent.showSection(AppSection.spending); closeShellDrawer(context); }),
                    const SizedBox(width: 4),
                    TourAnchor('settings-gear', child: _SideIconButton(icon: 'gear', tooltip: '设置', selected: section == AppSection.settings, onPressed: () { agent.showSection(AppSection.settings); closeShellDrawer(context); })),
                  ]),
                ),
              ],
            ),
          ),
        ),
        Positioned(right: 0, top: 0, bottom: 0, child: Container(width: 0.5, color: colors.border)),
        // Dragged here: the sidebar's width (Preferences.sidebarWidths).
        Positioned(
          right: 0,
          top: 0,
          bottom: 0,
          child: ResizeHandle(
            width: width,
            min: Preferences.sidebarWidths.min,
            max: Preferences.sidebarWidths.max,
            onChanged: (w) => setState(() => _width = w),
            onDone: (w) async {
              await agent.setSidebarWidth(w);
              if (mounted) setState(() => _width = null);
            },
          ),
        ),
      ],
    ));
  }
}

Widget _dragWindow(Widget child) => AppTitleBar.realWindow ? DragToMoveArea(child: child) : child;

/// 侧栏读到的「对话 → 目标状态」，顶栏蝶君对话的「· 在推进」也用它。
final sidebarGoalStatuses = ValueNotifier<Map<String, String>>(const {});

class _GoalDots extends InheritedWidget {
  const _GoalDots({required this.values, required super.child});
  final Map<String, String> values;
  @override bool updateShouldNotify(_GoalDots oldWidget) => oldWidget.values != values;
}

class ScheduleGoalDot extends StatelessWidget {
  const ScheduleGoalDot({super.key, required this.status});
  final String? status;
  @override Widget build(BuildContext context) {
    if (!['queued', 'running', 'reviewing', 'paused', 'blocked', 'uncertain'].contains(status)) return const SizedBox.shrink();
    final color = status == 'paused' ? context.colors.ochre : ['blocked', 'uncertain'].contains(status) ? context.colors.seal : context.colors.success;
    return Padding(padding: const EdgeInsets.only(right: 6), child: ['queued', 'running', 'reviewing'].contains(status) ? BreathingDot(color: color, size: 6) : Container(width: 6, height: 6, decoration: BoxDecoration(color: color, shape: BoxShape.circle)));
  }
}

/// 工作台 | 蝶君, the two places to work, with a dot when the other one is busy.
class _PlaceSwitch extends StatelessWidget {
  const _PlaceSwitch({
    required this.workbench,
    required this.butterfly,
    required this.onWorkbench,
    required this.onButterfly,
    required this.workbenchBusy,
    required this.butterflyBusy,
  });

  final bool workbench;
  final bool butterfly;
  final VoidCallback onWorkbench;
  final VoidCallback onButterfly;
  final bool workbenchBusy;
  final bool butterflyBusy;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final geometry = context.painting.craftGeometry;
    final shape = craftButtonShape(geometry);
    Widget half(
      String label,
      Widget icon,
      bool selected,
      bool busy,
      VoidCallback onTap,
    ) => Expanded(
      child: Semantics(
        button: true,
        selected: selected,
        child: CraftSelectionSurface(
          selected: selected,
          child: CraftControlMark(
            geometry: geometry,
            color: selected
                ? colors.accent.withValues(alpha: .7)
                : Colors.transparent,
            selected: selected,
            child: Material(
              color: Colors.transparent,
              child: InkWell(
                customBorder: shape,
                hoverColor: colors.accent.withValues(alpha: .06),
                onTap: () {
                  onTap();
                  closeShellDrawer(context);
                },
                child: SizedBox(
                  height: 28,
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      IconTheme(
                        data: IconThemeData(
                          color: selected ? colors.ink : colors.muted,
                        ),
                        child: icon,
                      ),
                      const SizedBox(width: 6),
                      Text(
                        label,
                        style: context.text.bodyMedium?.copyWith(
                          fontSize: 13,
                          color: selected ? colors.ink : colors.muted,
                          fontWeight: selected ? FontWeight.w600 : null,
                        ),
                      ),
                      if (busy) ...[
                        const SizedBox(width: 6),
                        const Tooltip(
                          message: '有工作在后台进行',
                          child: BreathingDot(),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    return Padding(
      padding: const EdgeInsets.all(3),
      child: Row(
        children: [
          half(
            '工作台',
            const ProtoIcon('chat', size: 14),
            workbench,
            workbenchBusy,
            onWorkbench,
          ),
          const SizedBox(width: 2),
          TourAnchor('place-butterfly', child: half(
            '蝶君',
            const ButterflyMark(size: 15),
            butterfly,
            butterflyBusy,
            onButterfly,
          )),
        ],
      ),
    );
  }
}

/// A row near the top of the sidebar (new conversation, search, tasks).
/// 原型 .nav：16 细线图标（muted，选中时强调色）、13.5 字、行高约 32、圆角 8；
/// 选中时 accentSoft 底、字 500、左边 2px 强调色条（v1-art.css `.nav.on`）。
/// 右边：红色角标 [badge]（只给「等你处理」）、淡色计数 [count]（「新 3」）或赭色小圆点 [dot]。
class _NavRow extends StatelessWidget {
  const _NavRow({required this.icon, required this.label, required this.onTap, this.selected = false, this.badge, this.count, this.dot = false});

  final String icon;
  final String label;
  final VoidCallback? onTap;
  final bool selected;
  final String? badge;
  final String? count;
  final bool dot;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Tooltip(
      message: label,
      child: PressFeedback(
        enabled: onTap != null,
        child: CraftSelectionSurface(selected: selected, child: Material(
          color: Colors.transparent,
          shape: craftButtonShape(context.painting.craftGeometry),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap == null ? null : () { onTap!(); closeShellDrawer(context); },
            child: Container(
              height: 32,
              decoration: BoxDecoration(border: Border(left: BorderSide(color: selected ? colors.accent : Colors.transparent, width: 2))),
              child: Row(children: [
                const SizedBox(width: 8),
                ProtoIcon(icon, color: selected ? colors.accent : colors.muted),
                const SizedBox(width: 11),
                Expanded(child: Text(label, style: context.text.bodyMedium?.copyWith(fontSize: 13.5, fontWeight: selected ? FontWeight.w500 : null, color: onTap == null ? colors.muted : (selected ? colors.ink : colors.ink2)))),
                if (badge != null) ShellCount(count: badge!),
                if (count != null) Text(count!, style: context.text.bodySmall?.copyWith(fontSize: 11.5, color: colors.muted)),
                if (dot) Container(width: 7, height: 7, decoration: BoxDecoration(color: colors.ochre, shape: BoxShape.circle)),
                const SizedBox(width: 10),
              ]),
            ),
          ),
        )),
      ),
    );
  }
}

/// 原型 .ib：26 方、圆角 8 的纯图标钮（侧栏收起、花费、设置），名字只在悬停时出现。
class _SideIconButton extends StatelessWidget {
  const _SideIconButton({required this.icon, required this.tooltip, required this.onPressed, this.selected = false});

  final String icon;
  final String tooltip;
  final VoidCallback onPressed;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final geometry = context.painting.craftGeometry;
    final button = IconButton(
      tooltip: tooltip,
      onPressed: onPressed,
      style: craftControlStyle(context, IconButton.styleFrom(
        fixedSize: const Size.square(26), minimumSize: const Size.square(26),
        maximumSize: const Size.square(26), padding: EdgeInsets.zero,
        visualDensity: VisualDensity.standard, tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        backgroundColor: selected ? colors.accentSoft : Colors.transparent,
        shape: craftButtonShape(geometry),
      )),
      icon: ProtoIcon(icon, color: selected ? colors.accent : colors.ink2),
    );
    return PressFeedback(
      child: SizedBox.square(
        dimension: 26,
        child: CraftControlMark(
          geometry: geometry,
          color: selected ? colors.accent.withValues(alpha: .62) : Colors.transparent,
          selected: selected,
          child: button,
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Workspace switcher
// ---------------------------------------------------------------------------

/// The workspace, at the top of the workbench's sidebar (0.8.2, user test: it was in the title
/// bar, away from the conversations it lists). Ctrl O opens the same menu.
class SidebarWorkspaceButton extends StatefulWidget {
  const SidebarWorkspaceButton({super.key});
  @override State<SidebarWorkspaceButton> createState()=>_SidebarWorkspaceButtonState();
}
class _SidebarWorkspaceButtonState extends State<SidebarWorkspaceButton>{
  Map<String,(int,int)> counts={};
  Future<void> loadCounts()async{
    final agent=AgentScope.read(context);final paths={agent.workspace,...agent.recentWorkspaces}.where((p)=>p.isNotEmpty);final result=<String,(int,int)>{};
    try{final slots=jsonRows(await agent.backend.call('slot.list'));for(final path in paths){final rows=jsonRows(await agent.backend.call('sessions.list',{'cwd':path}));final live=slots.where((r)=>SessionStore.samePath('${r['cwd']}',path)&&r['incognito']!=true);final ids={for(final r in rows)'${r['path']}',for(final r in live)'${r['sessionFile']??r['slotId']}'};result[path]=(ids.length,live.where((r)=>r['running']==true).length);}if(mounted)setState(()=>counts=result);}catch(_){if(mounted)setState(()=>counts={});}
  }

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
              if(counts[path] case final count?)Text('${count.$1} 个对话${count.$2>0?' · ${count.$2} 个在运行':''}',style:muted),
            ],
          ),
        ),
        if (selected) ...[const SizedBox(width: 8), Icon(Icons.check, size: 16, color: colors.accent)],
      ],
    );
    final itemStyle = MenuItemButton.styleFrom(minimumSize: const Size(320, 48), padding: const EdgeInsets.symmetric(horizontal: 10));
    return TourAnchor('workspace', child: MenuAnchor(
      controller: workspaceMenu,
      onOpen:loadCounts,
      alignmentOffset: const Offset(0, 6),
      style: MenuStyle(
        backgroundColor: WidgetStatePropertyAll(colors.card),
        side: WidgetStatePropertyAll(BorderSide(color: colors.border)),
        shape: WidgetStatePropertyAll(craftButtonShape(context.painting.craftGeometry, radius: 10)),
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
        message: current.isEmpty ? '选择工作区（Ctrl + O）' : '$current（Ctrl + O 切换）',
        waitDuration: const Duration(milliseconds: 600),
        // The workspace shares the painting's selected surface, including in dark mode.
        child: CraftSelectionSurface(child: Material(
          color: Colors.transparent,
          shape: craftButtonShape(context.painting.craftGeometry, radius: 10),
          child: InkWell(
            customBorder: craftButtonShape(context.painting.craftGeometry, radius: 10),
            onTap: () => controller.isOpen ? controller.close() : controller.open(),
            child: Container(
              height: 34,
              padding: const EdgeInsets.symmetric(horizontal: 10),
              child: Row(
                children: [
                  ProtoIcon('folder', color: colors.ochre),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      current.isEmpty ? '选择工作区' : p.basename(current),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: context.text.bodyMedium?.copyWith(fontSize: 13, color: colors.ink),
                    ),
                  ),
                  ProtoIcon('chev', size: 14, color: colors.muted),
                ],
              ),
            ),
          ),
        )),
      ),
    ));
  }
}

// ---------------------------------------------------------------------------
// Older workspace switcher (the empty state's folder picker)
// ---------------------------------------------------------------------------

/// Current workspace with a menu of recent ones; also used by the empty state.
class WorkspaceSwitcher extends StatelessWidget {
  const WorkspaceSwitcher({super.key, this.compact = false});

  final bool compact;

  static Future<void> pickFolder(BuildContext context) async {
    final agent = AgentScope.read(context);
    final directory = await getDirectoryPath(
      initialDirectory: agent.workspace.isEmpty ? null : agent.workspace,
      confirmButtonText: '设为工作区',
    );
    if (directory != null) await agent.setWorkspace(directory);
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final current = agent.workspace;
    final others = agent.recentWorkspaces.where((w) => !SessionStore.samePath(w, current)).toList();
    return PopupMenuButton<String>(
      tooltip: '工作区：Agent 在这个文件夹里读写文件、执行命令',
      position: PopupMenuPosition.under,
      constraints: const BoxConstraints(minWidth: 300, maxWidth: 420),
      onSelected: (value) async {
        switch (value) {
          case '__pick__':
            await pickFolder(context);
          case '__reveal__':
            await agent.revealInExplorer(current);
          default:
            await agent.setWorkspace(value);
        }
      },
      itemBuilder: (_) => [
        PopupMenuItem<String>(
          enabled: false,
          child: _WorkspaceRow(path: current, current: true),
        ),
        if (others.isNotEmpty) ...[
          const PopupMenuDivider(),
          PopupMenuItem<String>(
            enabled: false,
            height: 28,
            child: Text('最近使用', style: context.text.labelSmall?.copyWith(color: colors.muted)),
          ),
          for (final w in others) PopupMenuItem<String>(value: w, child: _WorkspaceRow(path: w)),
        ],
        const PopupMenuDivider(),
        const PopupMenuItem<String>(
          value: '__pick__',
          child: ListTile(dense: true, leading: Icon(Icons.create_new_folder_outlined), title: Text('打开其他文件夹…')),
        ),
        const PopupMenuItem<String>(
          value: '__reveal__',
          child: ListTile(dense: true, leading: Icon(Icons.open_in_new), title: Text('在资源管理器中显示')),
        ),
      ],
      child: compact
          ? Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Flexible(
                  child: Text(
                    current.isEmpty ? '选择工作区' : '工作区 · ${p.basename(current)}',
                    overflow: TextOverflow.ellipsis,
                    style: context.label,
                  ),
                ),
                Icon(Icons.expand_more, size: 14, color: colors.muted),
              ],
            )
          : Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              decoration: BoxDecoration(
                color: colors.card,
                border: Border.all(color: colors.border),
                borderRadius: BorderRadius.circular(context.radius),
              ),
              child: Row(
                children: [
                  Icon(Icons.folder_outlined, size: 18, color: Theme.of(context).colorScheme.primary),
                  const SizedBox(width: AppTokens.gap),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('工作区', style: context.text.labelSmall?.copyWith(color: colors.muted)),
                        Text(
                          current.isEmpty ? '选择工作区' : p.basename(current),
                          overflow: TextOverflow.ellipsis,
                          style: context.text.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                        ),
                      ],
                    ),
                  ),
                  Icon(Icons.unfold_more, size: 16, color: colors.muted),
                ],
              ),
            ),
    );
  }
}

class _WorkspaceRow extends StatelessWidget {
  const _WorkspaceRow({required this.path, this.current = false});

  final String path;
  final bool current;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Row(
      children: [
        Icon(current ? Icons.check : Icons.folder_outlined, size: 16, color: current ? Theme.of(context).colorScheme.primary : colors.muted),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(p.basename(path), overflow: TextOverflow.ellipsis, style: context.text.bodyMedium?.copyWith(color: Theme.of(context).colorScheme.onSurface)),
              Text(path, overflow: TextOverflow.ellipsis, style: context.text.bodySmall?.copyWith(color: colors.muted)),
            ],
          ),
        ),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Session list
// ---------------------------------------------------------------------------

/// Search box above either the session list or the search results.
class _SessionPane extends StatefulWidget {
  const _SessionPane({super.key, required this.searching, required this.onCloseSearch});

  /// The search box is open (the sidebar's 「搜索」).
  final bool searching;
  final VoidCallback onCloseSearch;

  @override
  State<_SessionPane> createState() => _SessionPaneState();
}

class _SessionPaneState extends State<_SessionPane> {
  final _query = TextEditingController();
  Timer? _debounce;
  Json? _hits;
  String? _error;
  int _generation = 0;
  var _searching = false;
  final _focus = FocusNode(debugLabel: 'sidebar-search');

  @override
  void initState() {
    super.initState();
    HardwareKeyboard.instance.addHandler(_onKey);
  }

  /// Ctrl+K：跳到侧栏搜索框（原型搜索框右边写着 Ctrl K）。
  bool _onKey(KeyEvent event) {
    if (event is! KeyDownEvent || event.logicalKey != LogicalKeyboardKey.keyK) return false;
    final keys = HardwareKeyboard.instance;
    if (!keys.isControlPressed || keys.isAltPressed || keys.isShiftPressed || keys.isMetaPressed || !mounted) return false;
    _focus.requestFocus();
    _query.selection = TextSelection(baseOffset: 0, extentOffset: _query.text.length);
    return true;
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_onKey);
    _debounce?.cancel();
    _query.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _onChanged(String text) {
    _debounce?.cancel();
    final generation = ++_generation;
    setState(() { _searching = false; _error = null; _hits = null; });
    if (text.trim().isEmpty) {
      return;
    }
    _debounce = Timer(const Duration(milliseconds: 300), () async {
      setState(() => _searching = true);
      try {
        final agent = AgentScope.read(context);
        final hits = asJsonMap(await agent.backend.call('search.all', {'query': text.trim(), 'cwd': agent.workspace}));
        if (!mounted || generation != _generation) return;
        setState(() { _hits = hits; _searching = false; });
      } catch (error) {
        if (!mounted || generation != _generation) return;
        setState(() { _error = SessionRuntime.describeError(error); _searching = false; });
      }
    });
  }

  @override
  void didUpdateWidget(_SessionPane old) {
    super.didUpdateWidget(old);
    if (old.searching && !widget.searching) {
      _query.clear();
      _debounce?.cancel();
      ++_generation;
      _hits = null;
      _searching = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (widget.searching) ...[
        // 原型 .search：主题浅染、圆角 8，聚焦时才显示边框。
        SizedBox(
          height: 32,
          child: TextField(
            key: const ValueKey('sidebar-search'),
            controller: _query,
            focusNode: _focus,
            onChanged: _onChanged,
            style: context.text.bodySmall?.copyWith(fontSize: 12.5, color: colors.ink),
            decoration: InputDecoration(
              hintText: '搜索对话',
              hintStyle: context.text.bodySmall?.copyWith(fontSize: 12.5, color: colors.muted),
              isDense: true,
              filled: true,
              fillColor: colors.accent.withValues(alpha: .055),
              prefixIcon: Padding(padding: const EdgeInsets.only(left: 10, right: 8), child: ProtoIcon('search', size: 14, color: colors.muted)),
              prefixIconConstraints: const BoxConstraints(minWidth: 32, minHeight: 14),
              suffixIcon: _query.text.isEmpty
                  ? Padding(padding: const EdgeInsets.only(right: 10), child: Text('Ctrl K', style: TextStyle(fontSize: 11, color: colors.muted)))
                  : IconButton(
                      tooltip: '清除搜索',
                      iconSize: 14,
                      onPressed: () {
                        _query.clear();
                        _onChanged('');
                      },
                      icon: ProtoIcon('x', size: 14, color: colors.muted),
                    ),
              suffixIconConstraints: const BoxConstraints(minHeight: 14),
              contentPadding: const EdgeInsets.symmetric(vertical: 8),
              border: craftInputBorder(context.painting.craftGeometry, radius: 8),
              enabledBorder: craftInputBorder(context.painting.craftGeometry, radius: 8),
              focusedBorder: craftInputBorder(context.painting.craftGeometry, radius: 8, side: BorderSide(color: colors.accent.withValues(alpha: .65))),
            ),
          ),
        ),
        const SizedBox(height: 8),
        ],
        // Workspace button: only for the workbench (not 蝶君), below the search
        // box and above the conversation list (2026-11-15 user decision).
        if (!agent.sandbox) ...[
          const SidebarWorkspaceButton(),
          const SizedBox(height: 4),
        ],
        Expanded(
          child: _error != null ? Text(_error!, style: TextStyle(color: colors.danger)) : _hits != null || _searching
              ? _SearchResults(hits: _hits ?? const {}, searching: _searching)
              : _SessionList(entries: agent.sidebar),
        ),
      ],
    );
  }
}

class _SearchResults extends StatelessWidget {
  const _SearchResults({required this.hits, required this.searching});

  final Json hits;
  final bool searching;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final groups = {'conversations': '对话', 'files': '产物', 'memories': '记忆'};
    if (searching) return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    if (groups.keys.every((key) => jsonRows(hits[key]).isEmpty)) return Text('没有找到', style: context.text.bodySmall?.copyWith(color: colors.muted));
    final agent = AgentScope.read(context);
    return ListView(
      children: [
        for (final group in groups.entries) if (jsonRows(hits[group.key]).isNotEmpty) ...[
        Padding(padding: const EdgeInsets.fromLTRB(6, 10, 6, 4), child: Text(group.value, style: context.label)),
        for (final hit in jsonRows(hits[group.key]))
          InkWell(
            borderRadius: BorderRadius.circular(context.radiusSm),
            onTap: () async {
              final target = asJsonMap(hit['target']);
              if (group.key == 'conversations') {
                await agent.openSearchHit(SearchHit.fromJson({...hit, 'path': target['sessionFile'] ?? hit['path']}));
                agent.entryTarget.value = target['entryId'] as String?;
                agent.main.showSection(agent.sandbox ? AppSection.butterfly : AppSection.chat);
                if (agent.sandbox) agent.main.butterflyTab.value = ButterflyTab.talk;
              } else if (group.key == 'files') {
                final path = target['path'] ?? hit['path'];
                if (path is String && context.mounted) await showFilePreview(context, path);
              } else {
                agent.main.openMemory(itemId: (target['itemId'] ?? hit['id']) as String?);
              }
            },
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text((hit['title'] ?? hit['content'] ?? p.basename('${hit['path'] ?? ''}')).toString(), maxLines: 1, overflow: TextOverflow.ellipsis, style: context.text.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
                  const SizedBox(height: 2),
                  if (hit['snippet'] is String) _Snippet(text: hit['snippet'] as String, prefix: ''),
                ],
              ),
            ),
          ),
        ],
      ],
    );
  }
}

/// Search snippet with the match (wrapped in 【】 by the core) highlighted.
class _Snippet extends StatelessWidget {
  const _Snippet({required this.text, required this.prefix});

  final String text;
  final String prefix;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final base = context.text.bodySmall?.copyWith(color: colors.muted);
    final spans = <TextSpan>[TextSpan(text: prefix)];
    final pattern = RegExp('【(.*?)】');
    var last = 0;
    for (final match in pattern.allMatches(text)) {
      spans.add(TextSpan(text: text.substring(last, match.start)));
      spans.add(TextSpan(text: match.group(1), style: TextStyle(color: Theme.of(context).colorScheme.primary, fontWeight: FontWeight.w600)));
      last = match.end;
    }
    spans.add(TextSpan(text: text.substring(last)));
    return Text.rich(TextSpan(style: base, children: spans), maxLines: 2, overflow: TextOverflow.ellipsis);
  }
}

class _SessionList extends StatefulWidget {
  const _SessionList({required this.entries});

  final List<SidebarEntry> entries;

  @override
  State<_SessionList> createState() => _SessionListState();
}

class _SessionListState extends State<_SessionList> {
  /// Paths of parent conversations whose branches are expanded. Default: all
  /// collapsed (2026-11-15 user decision).
  final Set<String> _expandedParents = {};

  static String _group(DateTime time) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final day = DateTime(time.year, time.month, time.day);
    final diff = today.difference(day).inDays;
    if (diff <= 0) return '今天';
    if (diff == 1) return '昨天';
    if (!day.isBefore(today.subtract(Duration(days: today.weekday - 1)))) return '本周';
    return '更早';
  }

  void _toggleParent(String path) {
    setState(() {
      if (_expandedParents.contains(path)) {
        _expandedParents.remove(path);
      } else {
        _expandedParents.add(path);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    if (widget.entries.isEmpty) {
      return Padding(
        padding: const EdgeInsets.only(top: AppTokens.pad),
        child: Text(
          '还没有对话', style: context.text.bodySmall?.copyWith(color: context.colors.muted)),
      );
    }
    final rows = <Widget>[];
    String? lastGroup;
    final ordered = orderSidebarEntries(widget.entries);

    // Group children by their parent session.
    final childrenByParent = <String, List<SidebarEntry>>{};
    final parents = <SidebarEntry>[];

    for (final entry in ordered) {
      if (entry.parentSession != null) {
        final parent = widget.entries
            .where((e) => SessionStore.samePath(e.path, entry.parentSession!))
            .firstOrNull;
        if (parent != null) {
          childrenByParent.putIfAbsent(parent.path, () => []).add(entry);
          continue;
        }
      }
      parents.add(entry);
    }

    for (final parent in parents) {
      final children = childrenByParent[parent.path] ?? [];
      final hasChildren = children.isNotEmpty;
      final isExpanded = _expandedParents.contains(parent.path);

      final group = parent.pinned ? '置顶' : _group(parent.modifiedAt);
      if (group != lastGroup) {
        rows.add(
          Padding(
            key: ValueKey('group-$group'),
            // 原型 .grp：11.5 淡色，上 10 下 4。
            padding: EdgeInsets.fromLTRB(10, lastGroup == null ? 2 : 10, 10, 4),
            child: Text(group, style: context.text.bodySmall?.copyWith(fontSize: 11.5, color: context.colors.muted)),
          ),
        );
        lastGroup = group;
      }

      rows.add(
        Padding(
          key: ValueKey(parent.path),
          padding: EdgeInsets.zero,
          child: _SessionTile(
            key: ValueKey(parent.path),
            entry: parent,
            hasChildren: hasChildren,
            isExpanded: isExpanded,
            onToggleChildren: hasChildren ? () => _toggleParent(parent.path) : null,
            childCount: children.length,
          ),
        ),
      );

      // Add children if expanded
      if (hasChildren && isExpanded) {
        for (final child in children) {
          rows.add(
            Padding(
              key: ValueKey(child.path),
              padding: const EdgeInsets.only(left: 18),
              child: _SessionTile(key: ValueKey(child.path), entry: child),
            ),
          );
        }
      }
    }

    return ShellAnimatedList(children: rows);
  }
}

class _SessionTile extends StatefulWidget {
  const _SessionTile({
    super.key,
    required this.entry,
    this.hasChildren = false,
    this.isExpanded = false,
    this.onToggleChildren,
    this.childCount = 0,
  });

  final SidebarEntry entry;
  final bool hasChildren;
  final bool isExpanded;
  final VoidCallback? onToggleChildren;
  final int childCount;

  @override
  State<_SessionTile> createState() => _SessionTileState();
}

class _SessionTileState extends State<_SessionTile> {
  var _hovered = false;

  Future<void> _showMenu(Offset position) async {
    final agent = AgentScope.read(context);
    final entry = widget.entry;
    final overlay = Overlay.of(context).context.findRenderObject()! as RenderBox;
    // [position] is on the screen; the menu is laid out in the overlay, which is scaled
    // with the interface zoom (AppZoom): convert, or it opens away from the button.
    final local = overlay.globalToLocal(position);
    final choice = await showMenu<String>(
      context: context,
      position: RelativeRect.fromRect(local & const Size(1, 1), Offset.zero & overlay.size),
      items: [
        if (!entry.incognito) ...[
          PopupMenuItem(
            value: 'pin',
            child: ListTile(dense: true, leading: Icon(entry.pinned ? Icons.push_pin : Icons.push_pin_outlined), title: Text(entry.pinned ? '取消置顶' : '置顶')),
          ),
          const PopupMenuItem(value: 'rename', child: ListTile(dense: true, leading: Icon(Icons.edit_outlined), title: Text('重命名'))),
          const PopupMenuItem(value: 'clone', child: ListTile(dense: true, leading: Icon(Icons.copy_all_outlined), title: Text('复制为新对话'))),
          const PopupMenuItem(value: 'export_md', child: ListTile(dense: true, leading: Icon(Icons.description_outlined), title: Text('导出 Markdown'))),
          PopupMenuItem(
            value: 'archive',
            child: ListTile(dense: true, leading: const Icon(Icons.inventory_2_outlined), title: Text('归档')),
          ),
          const PopupMenuDivider(),
        ],
        PopupMenuItem(value: 'delete', child: ListTile(dense: true, leading: Icon(Icons.delete_outline, color: context.colors.danger), title: Text('删除', style: TextStyle(color: context.colors.danger)))),
      ],
    );
    if (!mounted || choice == null) return;
    switch (choice) {
      case 'rename':
        final name = await _askName(context, entry.title);
        if (name != null && name.trim().isNotEmpty) await agent.renameSession(entry.path, name);
      case 'clone':
        await agent.cloneSession(entry.path);
      case 'delete':
        await deleteConversation(context, agent, entry.path, title: entry.title);
      case 'pin':
        await agent.setPinned(entry.path, !entry.pinned);
      case 'archive':
        await agent.setArchived(entry.path, true);
      case 'export_md':
        await exportConversation(context, agent, entry.path, entry.title);
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final entry = widget.entry;
    final selected = entry.isActive;
    final Widget? badge = entry.hasError
        ? Tooltip(message: '对话出错', child: Icon(Icons.error_outline, size: 14, color: colors.danger))
        : entry.needsAttention
        ? Tooltip(message: '在等你确认', child: Icon(Icons.front_hand_outlined, size: 14, color: colors.warning))
        : entry.isRunning
        ? const Tooltip(message: '正在运行', child: BreathingDot())
        : entry.hasUnseenResult
        ? Tooltip(
            message: '后台运行已完成，还没查看',
            child: Container(width: 7, height: 7, decoration: BoxDecoration(color: colors.ochre, shape: BoxShape.circle)),
          )
        : null;
    return MouseRegion(
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: GestureDetector(
        onSecondaryTapUp: (details) => _showMenu(details.globalPosition),
        child: Padding(
          padding: const EdgeInsets.only(bottom: 2),
          child: CraftSelectionSurface(selected: selected, child: Material(
            color: _hovered ? colors.ink.withValues(alpha: .04) : Colors.transparent,
            shape: craftButtonShape(context.painting.craftGeometry),
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              onTap: () {
                final agent = AgentScope.read(context);
                if (entry.isSideConversation) {
                  agent.openSavedSideChat({
                    'path': entry.path,
                    'parentSession': entry.parentSession,
                    'quote': entry.sideQuote,
                  });
                } else {
                  agent.openSession(entry.path);
                }
                // From the tasks or memory page too: show the conversation.
                agent.showSection(agent.sandbox ? AppSection.butterfly : AppSection.chat);
                if (agent.sandbox) agent.main.butterflyTab.value = ButterflyTab.talk;
              },
              child: Container(
                padding: const EdgeInsets.fromLTRB(8, 6, 4, 6),
                decoration: BoxDecoration(border: Border(left: BorderSide(color: selected ? colors.accent : Colors.transparent, width: 2))),
                child: Row(
                  children: [
                    // Branch expand/collapse button (2026-11-15 user decision):
                    // on the left of parent conversations with branches.
                    if (widget.hasChildren) ...[
                      // 原型 .brt：收拢时「› N」带条数，展开后只剩向下箭头。
                      Tooltip(
                        message: widget.isExpanded ? '收起分支' : '展开 ${widget.childCount} 个分支',
                        child: InkWell(
                          borderRadius: BorderRadius.circular(6),
                          onTap: widget.onToggleChildren,
                          child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 3, vertical: 2),
                            child: Row(mainAxisSize: MainAxisSize.min, children: [
                              ProtoIcon(widget.isExpanded ? 'chev' : 'right', size: 12, color: colors.muted),
                              if (!widget.isExpanded && widget.childCount > 0) Text('${widget.childCount}', style: TextStyle(fontSize: 10.5, color: colors.muted)),
                            ]),
                          ),
                        ),
                      ),
                      const SizedBox(width: 4),
                    ],
                    if (entry.incognito) ...[
                      Tooltip(message: '无痕对话，不会保存', child: Icon(Icons.visibility_off_outlined, size: 14, color: colors.muted)),
                      const SizedBox(width: 4),
                    ],
                    ScheduleGoalDot(status: context.dependOnInheritedWidgetOfExactType<_GoalDots>()?.values[entry.path]),
                    if (entry.parentSession != null) ...[
                      Tooltip(message: '从其他对话重来', child: ProtoIcon('branch', size: 13, color: colors.muted)),
                      const SizedBox(width: 4),
                    ],
                    Expanded(
                      child: Builder(builder: (context) {
                        final agent = AgentScope.of(context);
                        final goal = context.dependOnInheritedWidgetOfExactType<_GoalDots>()?.values[entry.path];
                        final now = DateTime.now(), at = entry.modifiedAt;
                        final today = now.year == at.year && now.month == at.month && now.day == at.day;
                        final time = today ? '${at.hour.toString().padLeft(2, '0')}:${at.minute.toString().padLeft(2, '0')}' : '${at.month}月${at.day}日';
                        final status = switch (goal) {
                          'running' => '在推进', 'paused' => '暂停了', 'blocked' || 'uncertain' => '卡住了', 'reviewing' => '等你验收', 'queued' => '排队中', _ => null,
                        };
                        final subtitle = agent.sandbox
                            ? (status == null ? time : '$status · $time')
                            : (entry.modelName == null ? time : '$time · ${entry.modelName}');
                        return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                          Text(
                            entry.title.isEmpty ? '新对话' : entry.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: context.text.bodyMedium?.copyWith(fontSize: 13, color: colors.ink, fontWeight: selected || entry.hasUnseenResult ? FontWeight.w500 : null),
                          ),
                          const SizedBox(height: 2),
                          Text(subtitle, maxLines: 1, overflow: TextOverflow.ellipsis, style: context.text.bodySmall?.copyWith(fontSize: 11.5, color: colors.muted)),
                        ]);
                      }),
                    ),
                    if (badge != null) ...[const SizedBox(width: 6), badge],
                    if (_hovered)
                      Builder(
                        builder: (buttonContext) => Tooltip(
                          message: '更多',
                          child: InkWell(
                            borderRadius: BorderRadius.circular(4),
                            onTap: () {
                              final box = buttonContext.findRenderObject()! as RenderBox;
                              _showMenu(box.localToGlobal(box.size.bottomLeft(Offset.zero)));
                            },
                            child: Padding(
                              padding: const EdgeInsets.symmetric(horizontal: 2),
                              child: Icon(Icons.more_horiz, size: 16, color: colors.muted),
                            ),
                          ),
                        ),
                      )
                    else
                      const SizedBox(width: 20),
                  ],
                ),
              ),
            ),
          )),
        ),
      ),
    );
  }
}

Future<String?> _askName(BuildContext context, String current) {
  final controller = TextEditingController(text: current);
  return showDialog<String>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('重命名对话'),
      content: SizedBox(
        width: 360,
        child: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(hintText: '对话名称'),
          onSubmitted: (value) => Navigator.pop(context, value),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(onPressed: () => Navigator.pop(context, controller.text), child: const Text('保存')),
      ],
    ),
  );
}
