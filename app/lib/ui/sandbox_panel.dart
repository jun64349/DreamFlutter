import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart' show AgentController, asJsonMap;
import '../theme.dart';
import 'agent_scope.dart';

/// Self-test checks by name, as people read them (core/src/sandbox/sandbox.ts SELF_TEST_SCRIPT).
const sandboxCheckNames = {
  'uid': '以独立的普通用户运行',
  'no-drives': '看不到 Windows 磁盘',
  'no-mount': '不能自己挂载 Windows 磁盘',
  'no-sudo': '没有 sudo',
  'no-su-root': '切换不到 root',
  'wsl-conf-locked': '改不了沙箱配置',
  'interop-locked': '打不开「运行 Windows 程序」的通道',
  'no-shared-mounts': '和其他 WSL 系统的共享目录已断开',
  'dns-locked': '改不了 DNS 设置',
  'firewall-locked': '改不了网络规则',
  'no-windows-programs': '运行不了 Windows 程序',
};

/// Settings › 蝶君沙箱: set the sandbox up, test that it holds, go offline,
/// reset or remove it (roadmap 3.3).
class SandboxPanel extends StatefulWidget {
  const SandboxPanel({super.key});

  @override
  State<SandboxPanel> createState() => _SandboxPanelState();
}

class _SandboxPanelState extends State<SandboxPanel> {
  AgentController? _agent;
  Json? _status;
  List<Json>? _checks;
  String? _busy;
  String? _error;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final agent = AgentScope.read(context);
    if (_agent == agent) return;
    _agent?.sandboxStatus.removeListener(_onPushed);
    _agent = agent..sandboxStatus.addListener(_onPushed);
    unawaited(_load());
  }

  @override
  void dispose() {
    _agent?.sandboxStatus.removeListener(_onPushed);
    super.dispose();
  }

  void _onPushed() {
    final status = _agent?.sandboxStatus.value;
    if (status != null && mounted) setState(() => _status = status);
  }

  Future<void> _load() async {
    try {
      final status = asJsonMap(await _agent!.backend.call('sandbox.status', const {}, const Duration(seconds: 60)));
      if (mounted) setState(() => _status = status);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  Future<void> _do(String label, String method, [Json params = const {}]) async {
    setState(() {
      _busy = label;
      _error = null;
    });
    try {
      final result = await _agent!.backend.call(method, params, const Duration(minutes: 3));
      if (!mounted) return;
      if (method == 'sandbox.selfTest') {
        setState(() => _checks = [for (final item in (asJsonMap(result)['items'] as List? ?? const [])) asJsonMap(item)]);
        await _load();
      } else {
        setState(() => _status = asJsonMap(result));
      }
    } catch (e) {
      if (mounted) setState(() => _error = '$label失败：$e');
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<bool> _confirm(String title, String body, String action) async =>
      await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(title),
          content: Text(body),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
            FilledButton(onPressed: () => Navigator.pop(context, true), child: Text(action)),
          ],
        ),
      ) ==
      true;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final status = _status;
    final state = status?['state'] as String?;
    // The app ships the sandbox image: no download (an older core does not say: assume it downloads).
    final bundled = status?['bundled'] == true;
    final muted = context.text.bodySmall?.copyWith(color: colors.muted);
    final children = <Widget>[];

    if (status == null) {
      children.add(Text(_error ?? '正在查看沙箱状态…', style: muted));
    } else if (state == 'no-wsl') {
      children.addAll([
        Text('这台电脑还没有 WSL。蝶君的沙箱建在 WSL 2 上（Windows 自带的轻量虚拟机），需要先装一次：', style: context.text.bodyMedium),
        const SizedBox(height: AppTokens.gap),
        Text('1. 开始菜单搜「PowerShell」，右键「以管理员身份运行」\n2. 运行下面这条命令，按提示重启\n3. 回到这里点「刷新」', style: context.text.bodyMedium),
        const SizedBox(height: AppTokens.gap),
        _CommandBox(command: 'wsl --install --no-distribution'),
        const SizedBox(height: 6),
        Text('如果报错 REGDB_E_CLASSNOTREG，到 github.com/microsoft/WSL/releases 下载最新的 x64 .msi 安装包，双击安装。', style: muted),
        const SizedBox(height: AppTokens.gap),
        Align(alignment: Alignment.centerLeft, child: OutlinedButton(onPressed: _load, child: const Text('刷新'))),
      ]);
    } else if (state == 'provisioning') {
      final progress = (status['progress'] as num?)?.toDouble();
      children.addAll([
        Text(status['step'] as String? ?? '正在建立沙箱…', style: context.text.bodyMedium),
        const SizedBox(height: AppTokens.gap),
        LinearProgressIndicator(value: progress),
        const SizedBox(height: 6),
        Text(
          bundled ? '用应用自带的系统镜像建立，不用联网，一般 1–2 分钟。' : '这个版本没有附带系统镜像，要在线组装 Debian 并安装工具，大约 10–20 分钟。可以先去做别的，好了会在这里显示。',
          style: muted,
        ),
      ]);
    } else if (state == 'absent' || state == 'error') {
      children.addAll([
        Text('蝶君在自己的沙箱里干活：一个独立的 Linux 系统，看不到你的文件，在里面做什么都不用你批准。', style: context.text.bodyMedium),
        if (state == 'error') ...[
          const SizedBox(height: AppTokens.gap),
          Text('上次建立没有成功：${status['error'] ?? ''}', style: context.text.bodySmall?.copyWith(color: colors.danger)),
        ],
        const SizedBox(height: AppTokens.gap),
        Align(
          alignment: Alignment.centerLeft,
          child: FilledButton.icon(
            onPressed: _busy != null ? null : () => _do('建立沙箱', 'sandbox.provision'),
            icon: Icon(bundled ? Icons.add_box_outlined : Icons.download_outlined, size: 18),
            label: Text(state == 'error' ? '重新建立' : '建立沙箱'),
          ),
        ),
        const SizedBox(height: 6),
        Text(
          bundled
              ? '用应用自带的 Debian 系统镜像建立，已经装好 Python、pandas、matplotlib、git 等工具，不用联网，一般 1–2 分钟，占用约 1.5 GB 磁盘。'
              : '这个版本没有附带系统镜像：会从国内镜像站在线组装 Debian 并安装 Python、pandas、git 等工具，大约 10–20 分钟，占用约 1.5 GB 磁盘。',
          style: muted,
        ),
      ]);
    } else {
      final online = status['online'] == true;
      final disk = (status['diskBytes'] as num?)?.toDouble();
      children.addAll([
        Row(
          children: [
            Icon(Icons.verified_user_outlined, size: 18, color: colors.accent),
            const SizedBox(width: 8),
            Text('沙箱已就绪', style: context.text.bodyLarge),
            if (disk != null) ...[const SizedBox(width: 12), Text('占用 ${(disk / 1024 / 1024 / 1024).toStringAsFixed(1)} GB', style: muted)],
          ],
        ),
        const SizedBox(height: AppTokens.gap),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          dense: true,
          value: online,
          onChanged: _busy != null ? null : (v) => _do(v ? '联网' : '断网', 'sandbox.setOnline', {'online': v}),
          title: const Text('允许沙箱联网'),
          subtitle: const Text('装 Python 包、查资料要用。无论开关，沙箱都访问不了你的局域网和这台电脑。'),
        ),
        const SizedBox(height: AppTokens.gap),
        Wrap(
          spacing: AppTokens.gap,
          runSpacing: AppTokens.gap,
          children: [
            OutlinedButton.icon(
              onPressed: _busy != null ? null : () => _do('自检', 'sandbox.selfTest'),
              icon: const Icon(Icons.fact_check_outlined, size: 18),
              label: const Text('运行逃逸自检'),
            ),
            OutlinedButton.icon(
              onPressed: _busy != null
                  ? null
                  : () async {
                      if (await _confirm('重置沙箱？', '沙箱会回到刚建好时的样子：蝶君在里面装的东西、做的文件（包括 outbox 里还没保存的产物）都会清空。', '重置')) {
                        await _do('重置', 'sandbox.reset');
                      }
                    },
              icon: const Icon(Icons.restart_alt, size: 18),
              label: const Text('重置'),
            ),
            TextButton(
              onPressed: _busy != null
                  ? null
                  : () async {
                      if (await _confirm('删除沙箱？', '沙箱和里面的所有文件都会删除，释放磁盘空间。以后可以重新建立。', '删除')) {
                        await _do('删除', 'sandbox.remove');
                      }
                    },
              child: Text('删除沙箱', style: TextStyle(color: colors.danger)),
            ),
          ],
        ),
      ]);
    }

    if (_busy != null) {
      children.addAll([const SizedBox(height: AppTokens.gap), Text('正在$_busy…', style: muted)]);
    }
    if (_error != null && status != null) {
      children.addAll([const SizedBox(height: AppTokens.gap), Text(_error!, style: context.text.bodySmall?.copyWith(color: colors.danger))]);
    }
    final checks = _checks;
    if (checks != null) {
      final passed = checks.where((c) => c['passed'] == true).length;
      children.addAll([
        const SizedBox(height: AppTokens.padLg),
        Text(passed == checks.length ? '自检全部通过（$passed 项）' : '自检有 ${checks.length - passed} 项没通过', style: context.text.bodyMedium?.copyWith(color: passed == checks.length ? colors.accent : colors.danger)),
        const SizedBox(height: 4),
        for (final check in checks)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 2),
            child: Row(
              children: [
                Icon(check['passed'] == true ? Icons.check : Icons.close, size: 16, color: check['passed'] == true ? colors.accent : colors.danger),
                const SizedBox(width: 8),
                Expanded(child: Text(sandboxCheckNames[check['name']] ?? '${check['name']}', style: context.text.bodySmall)),
              ],
            ),
          ),
      ]);
    }

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppTokens.padLg, vertical: AppTokens.pad),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
    );
  }
}

class _CommandBox extends StatelessWidget {
  const _CommandBox({required this.command});

  final String command;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
    decoration: BoxDecoration(color: context.colors.codeBackground, borderRadius: BorderRadius.circular(context.radiusSm)),
    child: Row(
      children: [
        Expanded(child: SelectableText(command, style: TextStyle(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback, fontSize: 13))),
        IconButton(
          tooltip: '复制',
          icon: const Icon(Icons.copy, size: 16),
          onPressed: () => Clipboard.setData(ClipboardData(text: command)),
        ),
      ],
    ),
  );
}
