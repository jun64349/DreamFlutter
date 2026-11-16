import 'dart:async';

import 'package:flutter/material.dart';
import 'proto_icon.dart';
import 'window_frame.dart' show AppTitleBar;
import 'package:flutter/services.dart';

import '../state/agent_controller.dart';
import 'agent_scope.dart';
import 'butterfly_page.dart';
import 'chat_view.dart';
import 'extension_dialogs.dart';
import 'library_page.dart';
import 'memory_page.dart';
import 'overlay_panel.dart' show ShellOverlaySidebar;
import 'rich_blocks.dart';
import 'sidebar.dart';
import 'attention_page.dart';
import 'settings_page.dart';
import 'shell_widgets.dart';
import 'schedule_page.dart';
import 'spending_page.dart';
import 'keys.dart';
import '../state/goal_conversation.dart';

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  static const _overlaySections = {AppSection.settings, AppSection.memory, AppSection.library, AppSection.spending};
  StreamSubscription<String>? _toasts;
  final _scaffoldKey = GlobalKey<ScaffoldState>();
  var _collapsed = false;
  var _baseSection = AppSection.chat;

  /// Pages opened at least once (kept alive afterwards).
  final _visited = <AppSection>{};
  void _scheduleJump() { if (mounted && scheduleNavigationRequest.value != null) AgentScope.read(context).showSection(AppSection.schedules); }

  bool _onKey(KeyEvent event) {
    if (event is! KeyDownEvent) return false;
    final agent = AgentScope.read(context);
    if (event.logicalKey == LogicalKeyboardKey.escape && _overlaySections.contains(agent.section)) {
      agent.showSection(_baseSection);
      return true;
    }
    if (event.logicalKey != LogicalKeyboardKey.keyB) return false;
    final keys = HardwareKeyboard.instance;
    if (!HeldKeys.control || keys.isAltPressed || keys.isShiftPressed || keys.isMetaPressed) return false;
    if (MediaQuery.sizeOf(context).width / agent.zoom < 860) {
      final scaffold = _scaffoldKey.currentState;
      if (scaffold != null && !scaffold.isDrawerOpen) scaffold.openDrawer();
    } else {
      setState(() => _collapsed = !_collapsed);
    }
    return true;
  }

  @override
  void initState() {
    super.initState();
    scheduleNavigationRequest.addListener(_scheduleJump);
    HardwareKeyboard.instance.addHandler(_onKey);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final agent = AgentScope.read(context);
    _toasts ??= agent.toasts.listen((message) {
      if (!mounted) return;
      // At the top, centred and only as wide as the message needs (v0.3.1 test 1).
      final size = MediaQuery.sizeOf(context);
      final width = (message.length * 13.0 + 48.0).clamp(200.0, 560.0);
      final side = ((size.width - width) / 2).clamp(16.0, double.infinity);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(message, textAlign: TextAlign.center),
          behavior: SnackBarBehavior.floating,
          dismissDirection: DismissDirection.up,
          margin: EdgeInsets.fromLTRB(side, 12, side, (size.height - 120).clamp(12.0, double.infinity)),
        ),
      );
    });
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_onKey);
    _toasts?.cancel();
    scheduleNavigationRequest.removeListener(_scheduleJump);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    if (!_overlaySections.contains(agent.section)) _baseSection = agent.section;
    if (!_overlaySections.contains(agent.section)) _visited.add(agent.section);
    RichRenderer.configure((agent.coreInfo['port'] as num?)?.toInt());
    void close() => agent.showSection(_baseSection);
    return ExtensionDialogHost(
      child: LayoutBuilder(builder: (context, constraints) {
        final narrow = constraints.maxWidth < 860;
        final sidebarWidth = narrow || _collapsed ? 0.0 : agent.sidebarWidth.clamp(180.0, MediaQuery.sizeOf(context).width * .36);
        final captionInset = AppTitleBar.realWindow ? AppTitleBar.captionWidth : 0.0;
        Widget header(AppSection section, {bool panelVisible = false}) => AppTitleBar(
          windowButtons: AppTitleBar.realWindow,
          contentOnly: true,
          showCaptionButtons: false,
          captionInset: panelVisible ? 0 : captionInset,
          active: _baseSection == section,
          leading: narrow || _collapsed ? IconButton(
            tooltip: narrow ? '打开侧栏' : '展开侧栏（Ctrl + B）',
            onPressed: narrow ? () => _scaffoldKey.currentState?.openDrawer() : () => setState(() => _collapsed = false),
            style: IconButton.styleFrom(minimumSize: const Size(30, 30), fixedSize: const Size(30, 30), padding: EdgeInsets.zero),
            icon: const ProtoIcon('side'),
          ) : null,
        );
        Widget pageWithHeader(AppSection section, Widget page) => Column(children: [
          header(section),
          Expanded(child: page),
        ]);
        final pages = ShellPageMotion(
          page: _baseSection,
          child: IndexedStack(index: _baseSection.index, sizing: StackFit.expand, children: [
            TickerMode(enabled: _baseSection == AppSection.chat, child: ChatView(
              captionInset: captionInset,
              headerBuilder: (panelVisible) => header(AppSection.chat, panelVisible: panelVisible),
            )),
            _visited.contains(AppSection.butterfly) ? TickerMode(enabled: _baseSection == AppSection.butterfly, child: ButterflyPage(
              captionInset: captionInset,
              headerBuilder: (panelVisible) => header(AppSection.butterfly, panelVisible: panelVisible),
            )) : const SizedBox(),
            _visited.contains(AppSection.tasks) ? pageWithHeader(AppSection.tasks, const AttentionPage()) : const SizedBox(),
            const SizedBox(),
            const SizedBox(),
            const SizedBox(),
            const SizedBox(),
            _visited.contains(AppSection.schedules) ? pageWithHeader(AppSection.schedules, const SchedulePage()) : const SizedBox(),
          ]),
        );
        return Scaffold(
          key: _scaffoldKey,
          drawer: narrow ? Drawer(width: 264, backgroundColor: Theme.of(context).colorScheme.surfaceContainerHighest, child: SafeArea(child: Sidebar(onCollapse: () => _scaffoldKey.currentState?.closeDrawer()))) : null,
          body: ShellOverlaySidebar(width: sidebarWidth, child: Stack(fit: StackFit.expand, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            if (!narrow && !_collapsed) Sidebar(onCollapse: () => setState(() => _collapsed = true)),
            Expanded(child: pages),
          ]),
          if (agent.section == AppSection.settings) Positioned.fill(child: SettingsOverlay(onClose: close)),
          if (agent.section == AppSection.memory) Positioned.fill(child: MemoryOverlay(onClose: close)),
          if (agent.section == AppSection.library) Positioned.fill(child: LibraryOverlay(onClose: close)),
          if (agent.section == AppSection.spending) Positioned.fill(child: SpendingOverlay(onClose: close)),
          if (AppTitleBar.realWindow) const Positioned(top: 0, right: 0, child: AppTitleBar(windowButtons: true, captionOnly: true)),
          Positioned.fill(child: ValueListenableBuilder(valueListenable: agent.appearance, builder: (context, appearance, _) {
            final factor = switch (appearance.paperTexture) { 'off' => 0.0, 'cotton' => .7, 'grain' => 1.35, _ => 1.0 };
            return PaperGrain(strength: appearance.paperStrength * factor);
          })),
          ])),
        );
      }),
    );
  }
}
