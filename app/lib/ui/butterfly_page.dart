import 'dart:async';

import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart' show Json;

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'chat_view.dart';
import 'common.dart';
import 'desk_page.dart';
import 'extension_dialogs.dart';
import 'sandbox_panel.dart';

/// 蝶君 (roadmap 3.5): an agent that works in its own WSL sandbox, apart
/// from the workbench. 「交流」 is the conversations with it (their own list,
/// never in the workbench); 「工作」 is the old desk: notes, materials, what it
/// delivered, cards.
class ButterflyPage extends StatefulWidget {
  const ButterflyPage({super.key});

  @override
  State<ButterflyPage> createState() => _ButterflyPageState();
}

class _ButterflyPageState extends State<ButterflyPage> {
  late final AgentController _agent;
  Json? _status;

  @override
  void initState() {
    super.initState();
    _agent = AgentScope.read(context);
    _agent.sandboxStatus.addListener(_onPushed);
    unawaited(_loadStatus());
  }

  @override
  void dispose() {
    _agent.sandboxStatus.removeListener(_onPushed);
    super.dispose();
  }

  void _onPushed() {
    final status = _agent.sandboxStatus.value;
    if (status != null && mounted) setState(() => _status = status);
  }

  Future<void> _loadStatus() async {
    try {
      final status = asJsonMap(await _agent.backend.call('sandbox.status', const {}, const Duration(seconds: 60)));
      if (mounted) setState(() => _status = status);
    } catch (_) {
      if (mounted) setState(() => _status = const {'state': 'unknown'});
    }
  }

  bool get _ready => _status?['state'] == 'ready';

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    if (agent.butterflyHome == null) {
      return const EmptyState(
        title: '后台需要更新',
        message: '这个版本的蝶君需要新的后台。从托盘图标选「退出并停止后台」，再重新打开 DreamFlutter。',
      );
    }
    // Both halves are 蝶君's sandbox work: nothing to show until the sandbox exists.
    return ValueListenableBuilder<ButterflyTab>(
      valueListenable: agent.butterflyTab,
      builder: (context, tab, _) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _Header(tab: tab, status: _status, onTab: _ready ? (t) => agent.butterflyTab.value = t : null),
          Expanded(
            child: _status == null
                ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                : !_ready
                ? _Setup(onChanged: _loadStatus)
                : IndexedStack(
                    index: tab.index,
                    sizing: StackFit.expand,
                    children: const [_Talk(), DeskPage()],
                  ),
          ),
        ],
      ),
    );
  }
}

/// The page's top strip: 蝶君's name, the two halves, and whether its sandbox is online.
class _Header extends StatelessWidget {
  const _Header({required this.tab, required this.status, required this.onTab});

  final ButterflyTab tab;
  final Json? status;

  /// Null while there is no sandbox: the halves are hidden.
  final ValueChanged<ButterflyTab>? onTab;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final ready = status?['state'] == 'ready';
    final online = status?['online'] != false;
    final muted = context.text.bodySmall?.copyWith(color: colors.muted);
    return Container(
      height: 52,
      padding: const EdgeInsets.symmetric(horizontal: AppTokens.padLg),
      decoration: BoxDecoration(color: colors.sidebar, border: Border(bottom: BorderSide(color: colors.border, width: 0.5))),
      child: Row(
        children: [
          const ButterflyGlyph(size: 20),
          const SizedBox(width: AppTokens.gap),
          Text('蝶君', style: context.serif(context.text.titleMedium).copyWith(fontSize: 18, fontWeight: FontWeight.w600)),
          if (onTab case final onTab?) ...[
            const SizedBox(width: AppTokens.padLg),
            SegmentedButton<ButterflyTab>(
              showSelectedIcon: false,
              style: SegmentedButton.styleFrom(visualDensity: VisualDensity.compact),
              segments: const [
                ButtonSegment(value: ButterflyTab.talk, label: Text('交流'), icon: Icon(Icons.forum_outlined, size: 16)),
                ButtonSegment(value: ButterflyTab.work, label: Text('工作'), icon: Icon(Icons.edit_note, size: 16)),
              ],
              selected: {tab},
              onSelectionChanged: (s) => onTab(s.first),
            ),
          ],
          const Spacer(),
          if (ready)
            Tooltip(
              message: online ? '蝶君可以上网（不能访问你的局域网）。在「设置 › 蝶君沙箱」里可以一键离线。' : '蝶君现在不能上网。在「设置 › 蝶君沙箱」里可以重新联网。',
              child: Row(
                children: [
                  Icon(online ? Icons.cloud_outlined : Icons.cloud_off_outlined, size: 16, color: colors.muted),
                  const SizedBox(width: 6),
                  Text(online ? '沙箱 · 联网' : '沙箱 · 离线', style: muted),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// The conversations with 蝶君, under its own controller (its sessions run in the sandbox).
class _Talk extends StatefulWidget {
  const _Talk();

  @override
  State<_Talk> createState() => _TalkState();
}

class _TalkState extends State<_Talk> {
  AgentController? _butterfly;
  Object? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_open());
  }

  Future<void> _open() async {
    try {
      final butterfly = await AgentScope.read(context).ensureButterfly();
      if (mounted) setState(() => _butterfly = butterfly);
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final butterfly = _butterfly;
    if (_error != null) return Center(child: Text('打不开蝶君的对话：${SessionRuntime.describeError(_error!)}', style: TextStyle(color: context.colors.danger)));
    if (butterfly == null) return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    return AgentScope(
      controller: butterfly,
      // Its questions and dialogs are answered here, like the workbench's.
      // Its conversations are listed in the window's sidebar (0.4).
      child: const ExtensionDialogHost(child: ChatView()),
    );
  }
}

/// Before the sandbox exists: what 蝶君 is, and the sandbox panel to set it up.
class _Setup extends StatelessWidget {
  const _Setup({required this.onChanged});

  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final muted = context.text.bodyMedium?.copyWith(color: context.colors.muted, height: 1.7);
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(32, 32, 32, 40),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 720),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Center(child: ButterflyMark(size: 88, veins: true)),
              const SizedBox(height: AppTokens.padLg),
              Text('先给蝶君建一个沙箱', textAlign: TextAlign.center, style: context.serif(context.text.titleLarge)),
              const SizedBox(height: AppTokens.gap),
              Text(
                '「交流」和「工作」都在这个沙箱里进行。你交给蝶君的文件会复制一份进去，'
                '它做好的东西放在 outbox 里，由你决定保存到哪里。',
                textAlign: TextAlign.center,
                style: muted,
              ),
              const SizedBox(height: AppTokens.padLg),
              _ListenForReady(onReady: onChanged, child: const SandboxPanel()),
            ],
          ),
        ),
      ),
    );
  }
}

/// Reloads the page's sandbox state when the panel reports the sandbox ready.
class _ListenForReady extends StatefulWidget {
  const _ListenForReady({required this.onReady, required this.child});

  final VoidCallback onReady;
  final Widget child;

  @override
  State<_ListenForReady> createState() => _ListenForReadyState();
}

class _ListenForReadyState extends State<_ListenForReady> {
  late final AgentController _agent;

  @override
  void initState() {
    super.initState();
    _agent = AgentScope.read(context);
    _agent.sandboxStatus.addListener(_changed);
  }

  @override
  void dispose() {
    _agent.sandboxStatus.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (_agent.sandboxStatus.value?['state'] == 'ready') widget.onReady();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
