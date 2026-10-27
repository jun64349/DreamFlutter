import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

import '../main.dart' show appVersion;
import '../state/preferences.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'sidebar.dart' show WorkspaceSwitcher;

class SettingsPage extends StatelessWidget {
  const SettingsPage({super.key});

  static const _levelNames = {
    'off': '关闭',
    'minimal': '极低',
    'low': '低',
    'medium': '中',
    'high': '高',
    'xhigh': '很高',
    'max': '最高',
  };

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final prefs = agent.preferences;
    final colors = context.colors;
    final info = agent.runtimeInfo();
    final defaultModel = agent.models.where((m) => m.key == prefs.modelKey).firstOrNull;
    final providers = <String, int>{};
    for (final m in agent.models) {
      providers[m.provider] = (providers[m.provider] ?? 0) + 1;
    }

    return Scaffold(
      appBar: AppBar(title: const Text('设置'), scrolledUnderElevation: 0),
      body: ListView(
        padding: const EdgeInsets.symmetric(vertical: AppTokens.padLg),
        children: [
          _Section(
            title: '模型',
            children: [
              _Row(
                title: '新会话默认模型',
                subtitle: defaultModel == null ? '${prefs.modelKey}（当前不可用）' : defaultModel.key,
                trailing: PopupMenuButton<PiModel>(
                  tooltip: '选择默认模型',
                  enabled: agent.models.isNotEmpty,
                  onSelected: agent.setDefaultModel,
                  itemBuilder: (_) => [
                    for (final m in agent.models)
                      CheckedPopupMenuItem(value: m, checked: m.key == prefs.modelKey, child: Text('${m.name}  ·  ${m.provider}')),
                  ],
                  child: _ValueChip(text: defaultModel?.name ?? '选择'),
                ),
              ),
              _Row(
                title: '新会话默认思考级别',
                subtitle: '越高越仔细，但更慢、更贵',
                trailing: PopupMenuButton<String>(
                  tooltip: '选择默认思考级别',
                  enabled: agent.thinkingLevels.isNotEmpty,
                  onSelected: agent.setDefaultThinkingLevel,
                  itemBuilder: (_) => [
                    for (final level in agent.thinkingLevels)
                      CheckedPopupMenuItem(value: level, checked: level == prefs.thinkingLevel, child: Text(_levelNames[level] ?? level)),
                  ],
                  child: _ValueChip(text: _levelNames[prefs.thinkingLevel] ?? '跟随 Pi'),
                ),
              ),
              _Row(
                title: '服务商与凭证',
                subtitle: providers.isEmpty
                    ? '还没有可用的模型。在 Pi 的配置文件里添加服务商后点「重新加载」。'
                    : providers.entries.map((e) => '${e.key}（${e.value} 个模型）').join('、'),
                trailing: Wrap(
                  spacing: AppTokens.gap,
                  children: [
                    OutlinedButton(onPressed: () => agent.revealInExplorer(info.agentDir), child: const Text('打开配置文件夹')),
                    OutlinedButton(onPressed: agent.reloadIdleSessions, child: const Text('重新加载')),
                  ],
                ),
              ),
              _Hint(
                '模型和凭证由 Pi 管理：自定义服务商写在 ${p.join(info.agentDir, 'models.json')}，登录凭证在 auth.json。'
                '改完后点「重新加载」，空闲的会话会用新配置重启，正在运行的会话不受影响。',
              ),
            ],
          ),
          _Section(
            title: '安全',
            children: [
              RadioGroup<ApprovalMode>(
                groupValue: agent.approvalMode,
                onChanged: (m) => agent.setApprovalMode(m!),
                child: Column(
                  children: [
                    for (final mode in ApprovalMode.values)
                      RadioListTile<ApprovalMode>(
                        value: mode,
                        title: Text(mode.label),
                        subtitle: Text(mode.description),
                        dense: true,
                      ),
                  ],
                ),
              ),
              _Hint('审批由 Pi 扩展 dreamflutter-approval 完成，修改后立即生效，不需要重启会话。'),
            ],
          ),
          _Section(
            title: '工作区与上下文',
            children: [
              _Row(
                title: '当前工作区',
                subtitle: agent.workspace,
                trailing: const SizedBox(width: 260, child: WorkspaceSwitcher()),
              ),
              SwitchListTile(
                value: prefs.autoCompaction,
                onChanged: agent.setDefaultAutoCompaction,
                title: const Text('上下文快满时自动压缩'),
                subtitle: const Text('自动把较早的对话总结成摘要，腾出空间。关闭后需要在状态栏的「上下文」里手动压缩。'),
                dense: true,
              ),
              _Row(
                title: '后台会话',
                subtitle: '运行中的会话切走后会在后台继续；空闲超过 ${agent.idleGrace.inMinutes} 分钟的后台会话会自动释放进程（会话内容保留在磁盘上）。'
                    '当前共 ${agent.runtimes.length} 个 Pi 进程，${agent.backgroundRunning} 个在后台运行。',
              ),
            ],
          ),
          _Section(
            title: '外观',
            children: [
              _Row(
                title: '主题',
                trailing: SegmentedButton<ThemeMode>(
                  segments: const [
                    ButtonSegment(value: ThemeMode.system, label: Text('跟随系统')),
                    ButtonSegment(value: ThemeMode.light, label: Text('浅色')),
                    ButtonSegment(value: ThemeMode.dark, label: Text('深色')),
                  ],
                  selected: {agent.themeMode},
                  onSelectionChanged: (s) => agent.setThemeMode(s.first),
                ),
              ),
              _Row(
                title: '文字大小',
                trailing: SegmentedButton<double>(
                  segments: const [
                    ButtonSegment(value: 0.9, label: Text('小')),
                    ButtonSegment(value: 1.0, label: Text('标准')),
                    ButtonSegment(value: 1.1, label: Text('大')),
                    ButtonSegment(value: 1.25, label: Text('特大')),
                  ],
                  selected: {Preferences.textScales.contains(agent.textScale) ? agent.textScale : 1.0},
                  onSelectionChanged: (s) => agent.setTextScale(s.first),
                ),
              ),
            ],
          ),
          _Section(
            title: '运行环境',
            children: [
              _InfoRow('Pi 版本', info.piVersion ?? '未找到'),
              _InfoRow('Pi 程序', info.cliPath ?? '未找到（需要 runtime/node_modules）'),
              _InfoRow('Node.js', info.nodePath ?? '未找到（需要 Node.js 22.19 以上）'),
              _InfoRow('Bash', info.bashDir == null ? '使用 Pi 的默认查找顺序' : p.join(info.bashDir!, 'bash.exe')),
              _InfoRow('审批扩展', info.extensionPath ?? '未找到'),
              _InfoRow('会话存放位置', info.sessionsDir),
              Padding(
                padding: const EdgeInsets.fromLTRB(AppTokens.padLg, AppTokens.gap, AppTokens.padLg, 0),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: OutlinedButton(onPressed: () => agent.revealInExplorer(info.sessionsDir), child: const Text('打开会话文件夹')),
                ),
              ),
            ],
          ),
          _Section(
            title: '关于',
            children: [
              _InfoRow('DreamFlutter', 'v$appVersion'),
              _Hint('基于 Pi Agent 原生运行时的个人 AI Agent 桌面客户端。', color: colors.muted),
            ],
          ),
        ],
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.children});

  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 820),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(AppTokens.padLg + 8, 0, AppTokens.padLg + 8, AppTokens.padLg + 8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.only(left: 4, bottom: AppTokens.gap),
                child: Text(title, style: context.text.titleSmall?.copyWith(color: Theme.of(context).colorScheme.primary)),
              ),
              // Material (not a decorated Container) so list tiles inside can
              // paint their hover and ink effects.
              Material(
                color: colors.card,
                clipBehavior: Clip.antiAlias,
                shape: RoundedRectangleBorder(
                  side: BorderSide(color: colors.border),
                  borderRadius: BorderRadius.circular(AppTokens.radiusLg),
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: AppTokens.gap),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.title, this.subtitle, this.trailing});

  final String title;
  final String? subtitle;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppTokens.padLg, vertical: 10),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: context.text.bodyLarge),
                if (subtitle != null) ...[
                  const SizedBox(height: 2),
                  Text(subtitle!, style: context.text.bodySmall?.copyWith(color: context.colors.muted)),
                ],
              ],
            ),
          ),
          if (trailing != null) ...[const SizedBox(width: AppTokens.padLg), trailing!],
        ],
      ),
    );
  }
}

class _InfoRow extends StatelessWidget {
  const _InfoRow(this.label, this.value);

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppTokens.padLg, vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(width: 120, child: Text(label, style: context.text.bodyMedium?.copyWith(color: context.colors.muted))),
          Expanded(child: SelectableText(value, style: context.text.bodyMedium)),
        ],
      ),
    );
  }
}

class _Hint extends StatelessWidget {
  const _Hint(this.text, {this.color});

  final String text;
  final Color? color;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(AppTokens.padLg, 4, AppTokens.padLg, AppTokens.gap),
    child: Text(text, style: context.text.bodySmall?.copyWith(color: color ?? context.colors.muted)),
  );
}

class _ValueChip extends StatelessWidget {
  const _ValueChip({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      decoration: BoxDecoration(border: Border.all(color: colors.border), borderRadius: BorderRadius.circular(AppTokens.radius)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [Text(text), const SizedBox(width: 4), Icon(Icons.expand_more, size: 16, color: colors.muted)],
      ),
    );
  }
}
