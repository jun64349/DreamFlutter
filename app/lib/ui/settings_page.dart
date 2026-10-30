import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

import '../main.dart' show appVersion;
import '../state/agent_controller.dart' show AgentController;
import '../state/preferences.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'composer.dart' show agentModeHints, agentModeNames;
import 'mcp_page.dart';
import 'providers_page.dart';
import 'usage_page.dart';
import 'zoom.dart';
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
    final colors = context.colors;
    final core = agent.coreInfo;
    final agentDir = core['agentDir'] as String? ?? SessionStore.defaultAgentDir();
    final defaultKey = agent.defaultModelKey;
    final defaultModel = agent.models.where((m) => m.key == defaultKey).firstOrNull;
    final providers = <String, int>{};
    for (final m in agent.models) {
      providers[m.provider] = (providers[m.provider] ?? 0) + 1;
    }
    final physical = agent.models.where((m) => m.provider != 'dreamflutter').toList();
    final auxKey = agent.coreSettings['auxModel'] as String?;
    final chain = (agent.coreSettings['fallbackModels'] as List? ?? const []).whereType<String>().toList();
    String modelName(String key) => agent.models.where((m) => m.key == key).firstOrNull?.name ?? key;

    return Scaffold(
      appBar: AppBar(title: const Text('设置'), scrolledUnderElevation: 0),
      body: ListView(
        padding: const EdgeInsets.symmetric(vertical: AppTokens.padLg),
        children: [
          const _Section(
            title: '外观',
            children: [
              _Row(title: '界面缩放', subtitle: '整个界面一起放大或缩小。快捷键：Ctrl + 加号 / 减号，Ctrl + 0 恢复。', trailing: ZoomControl()),
              _Row(title: '文字大小', subtitle: '只调整文字，布局不变。', trailing: TextSizeControl()),
              _Row(title: '主题', trailing: ThemeModeControl()),
            ],
          ),
          _Section(
            title: '模型',
            children: [
              _Row(
                title: '新会话默认模型',
                subtitle: defaultModel?.key ?? (defaultKey == null ? '未设置，由 Pi 决定' : '$defaultKey（当前不可用）'),
                trailing: PopupMenuButton<PiModel>(
                  tooltip: '选择默认模型',
                  enabled: agent.models.isNotEmpty,
                  onSelected: agent.setDefaultModel,
                  itemBuilder: (_) => [
                    for (final m in agent.models)
                      CheckedPopupMenuItem(value: m, checked: m.key == defaultKey, child: Text('${m.name}  ·  ${m.provider}')),
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
                      CheckedPopupMenuItem(value: level, checked: level == agent.defaultThinkingLevel, child: Text(_levelNames[level] ?? level)),
                  ],
                  child: _ValueChip(text: _levelNames[agent.defaultThinkingLevel] ?? '跟随 Pi'),
                ),
              ),
              _Row(
                title: '辅助模型',
                subtitle: '生成会话标题、整理记忆等后台小任务用的模型，选便宜快速的即可',
                trailing: PopupMenuButton<String>(
                  tooltip: '选择辅助模型',
                  onSelected: (key) => agent.updateCoreSettings({'auxModel': key.isEmpty ? null : key}),
                  itemBuilder: (_) => [
                    CheckedPopupMenuItem(value: '', checked: auxKey == null, child: const Text('跟随默认模型')),
                    for (final m in physical) CheckedPopupMenuItem(value: m.key, checked: m.key == auxKey, child: Text('${m.name}  ·  ${m.provider}')),
                  ],
                  child: _ValueChip(text: auxKey == null ? '跟随默认模型' : modelName(auxKey)),
                ),
              ),
              _Row(
                title: '备用模型链',
                subtitle: chain.isEmpty
                    ? '未设置。设置后可以选择模型「自动（主模型 + 备用链）」：主模型出错或限流时自动换下一个，适合无人值守的定时任务。'
                    : chain.map(modelName).join(' → '),
                trailing: OutlinedButton(
                  onPressed: () async {
                    final result = await showDialog<List<String>>(context: context, builder: (_) => _ChainDialog(models: physical, chain: chain));
                    if (result != null) await agent.updateCoreSettings({'fallbackModels': result});
                  },
                  child: const Text('编辑'),
                ),
              ),
              SwitchListTile(
                value: agent.coreSettings['autoTitle'] != false,
                onChanged: (v) => agent.updateCoreSettings({'autoTitle': v}),
                title: const Text('自动生成会话标题'),
                subtitle: const Text('第一轮对话结束后，用辅助模型起一个简短标题。'),
                dense: true,
              ),
              _Row(
                title: '服务商与凭证',
                subtitle: providers.isEmpty
                    ? '还没有可用的模型，先添加一个服务商。'
                    : providers.entries.where((e) => e.key != 'dreamflutter').map((e) => '${e.key}（${e.value} 个模型）').join('、'),
                trailing: Wrap(
                  spacing: AppTokens.gap,
                  children: [
                    FilledButton.tonal(
                      onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const ProvidersPage())),
                      child: const Text('管理服务商'),
                    ),
                    OutlinedButton(
                      onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const UsagePage())),
                      child: const Text('用量统计'),
                    ),
                    OutlinedButton(
                      onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const McpPage())),
                      child: const Text('MCP 服务'),
                    ),
                    OutlinedButton(onPressed: agent.reloadIdleSessions, child: const Text('重新加载')),
                  ],
                ),
              ),
              _Hint(
                '服务商配置写在 Pi 自己的配置文件里（${p.join(agentDir, 'models.json')} 和 auth.json），在终端里用 Pi 也能看到。'
                '新填写的 API Key 用你的 Windows 账户加密保存。',
              ),
            ],
          ),
          _Section(
            title: 'Agent 模式',
            children: [
              RadioGroup<String>(
                groupValue: agent.defaultAgentMode,
                onChanged: (m) => agent.updateCoreSettings({'agentMode': m!}),
                child: Column(
                  children: [
                    for (final mode in agentModeNames.keys)
                      RadioListTile<String>(value: mode, title: Text('${agentModeNames[mode]}模式'), subtitle: Text(agentModeHints[mode]!), dense: true),
                  ],
                ),
              ),
              _Hint('新会话用这个模式；已有的会话保持创建时的模式。两种模式都按 DeepSeek Harness 的设计实现，对 DeepSeek 模型最友好。'),
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
              _Hint('审批在后台完成，修改后立即生效；关掉窗口后，后台任务的确认请求会以系统通知提醒你。'),
              const _ToolRules(),
            ],
          ),
          _Section(
            title: '运行上限',
            children: [
              _Row(
                title: '单次运行最多轮数',
                subtitle: 'Agent 每调用一轮模型算一轮。超过后任务暂停，在「任务 › 待处理」里选择继续还是结束。',
                trailing: SegmentedButton<int>(
                  segments: const [
                    ButtonSegment(value: 30, label: Text('30')),
                    ButtonSegment(value: 60, label: Text('60')),
                    ButtonSegment(value: 120, label: Text('120')),
                    ButtonSegment(value: 0, label: Text('不限')),
                  ],
                  selected: {(agent.coreSettings['maxTurnsPerRun'] as num?)?.toInt() ?? 60},
                  onSelectionChanged: (s) => agent.updateCoreSettings({'maxTurnsPerRun': s.first}),
                ),
              ),
              _Row(
                title: '每天花费上限',
                subtitle: '所有任务当天的花费合计超过后暂停，可以选择当天不再限制。只统计填写了价格的模型。',
                trailing: _BudgetField(value: (agent.coreSettings['dailyBudgetUsd'] as num?)?.toDouble() ?? 0),
              ),
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
                value: agent.defaultAutoCompaction,
                onChanged: agent.setDefaultAutoCompaction,
                title: const Text('上下文快满时自动压缩'),
                subtitle: const Text('自动把较早的对话总结成摘要，腾出空间。关闭后需要在状态栏的「上下文」里手动压缩。'),
                dense: true,
              ),
              _Row(
                title: '后台会话',
                subtitle: '会话运行在后台服务里：切走、新建会话或关掉窗口，运行中的会话都会继续。空闲的会话过一段时间会自动释放（内容保留在磁盘上）。'
                    '当前窗口连着 ${agent.runtimes.length} 个会话，${agent.backgroundRunning} 个在后台运行。',
              ),
            ],
          ),
          _Section(
            title: '运行环境',
            children: [
              _InfoRow('后台服务', core.isEmpty ? '未连接' : 'v${core['version']}（进程 ${core['pid']}）'),
              _InfoRow('Pi 版本', core['piVersion'] as String? ?? '未知'),
              _InfoRow('Node.js', PiRuntimeLocator.findOnPath('node') ?? '未找到（需要 Node.js 22.19 以上）'),
              _InfoRow('Bash', PiRuntimeLocator.findGitBashDir() == null ? '使用 Pi 的默认查找顺序' : p.join(PiRuntimeLocator.findGitBashDir()!, 'bash.exe')),
              _InfoRow('后台数据', core['dataDir'] as String? ?? '未知'),
              _InfoRow('会话存放位置', agent.sessionStore.sessionsDir),
              Padding(
                padding: const EdgeInsets.fromLTRB(AppTokens.padLg, AppTokens.gap, AppTokens.padLg, 0),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: OutlinedButton(onPressed: () => agent.revealInExplorer(agent.sessionStore.sessionsDir), child: const Text('打开会话文件夹')),
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

/// Ordered list of fallback models.
class _ChainDialog extends StatefulWidget {
  const _ChainDialog({required this.models, required this.chain});

  final List<PiModel> models;
  final List<String> chain;

  @override
  State<_ChainDialog> createState() => _ChainDialogState();
}

class _ChainDialogState extends State<_ChainDialog> {
  late final List<String> _chain = [...widget.chain];

  String _name(String key) => widget.models.where((m) => m.key == key).firstOrNull?.name ?? key;

  @override
  Widget build(BuildContext context) {
    final available = widget.models.where((m) => !_chain.contains(m.key)).toList();
    return AlertDialog(
      title: const Text('备用模型链'),
      content: SizedBox(
        width: 460,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text('按顺序尝试：第一个是主模型，出错或限流时换下一个。'),
            const SizedBox(height: AppTokens.gap),
            for (final (i, key) in _chain.indexed)
              ListTile(
                dense: true,
                leading: Text('${i + 1}'),
                title: Text(_name(key)),
                subtitle: Text(key),
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    IconButton(
                      tooltip: '上移',
                      onPressed: i == 0 ? null : () => setState(() => _chain.insert(i - 1, _chain.removeAt(i))),
                      icon: const Icon(Icons.arrow_upward, size: 16),
                    ),
                    IconButton(tooltip: '移除', onPressed: () => setState(() => _chain.removeAt(i)), icon: const Icon(Icons.close, size: 16)),
                  ],
                ),
              ),
            PopupMenuButton<String>(
              enabled: available.isNotEmpty,
              tooltip: '添加模型',
              onSelected: (key) => setState(() => _chain.add(key)),
              itemBuilder: (_) => [for (final m in available) PopupMenuItem(value: m.key, child: Text('${m.name}  ·  ${m.provider}'))],
              child: const Padding(padding: EdgeInsets.all(8), child: Text('＋ 添加模型')),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(onPressed: () => Navigator.pop(context, _chain), child: const Text('保存')),
      ],
    );
  }
}

/// Tools the user chose to always allow in the current workspace.
class _ToolRules extends StatefulWidget {
  const _ToolRules();

  @override
  State<_ToolRules> createState() => _ToolRulesState();
}

class _ToolRulesState extends State<_ToolRules> {
  List<String>? _tools;
  String _workspace = '';

  Future<void> _load(AgentController agent) async {
    _workspace = agent.workspace;
    try {
      final rows = await agent.backend.call('workspace.toolRules', {'cwd': agent.workspace});
      _tools = [for (final r in (rows as List).whereType<Map>()) r['tool'] as String];
    } catch (_) {
      _tools = const [];
    }
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    if (_tools == null || _workspace != agent.workspace) {
      _load(agent);
      return const SizedBox();
    }
    if (_tools!.isEmpty) return const SizedBox();
    return _Row(
      title: '这个工作区里总是允许',
      subtitle: '在审批时选了「在此工作区总是允许」的工具，不再询问。点 × 恢复询问。',
      trailing: Wrap(
        spacing: AppTokens.gap,
        children: [
          for (final tool in _tools!)
            InputChip(
              label: Text(tool),
              onDeleted: () async {
                await agent.backend.call('workspace.removeToolRule', {'cwd': agent.workspace, 'tool': tool});
                await _load(agent);
              },
            ),
        ],
      ),
    );
  }
}

class _BudgetField extends StatefulWidget {
  const _BudgetField({required this.value});

  final double value;

  @override
  State<_BudgetField> createState() => _BudgetFieldState();
}

class _BudgetFieldState extends State<_BudgetField> {
  late final _controller = TextEditingController(text: widget.value == 0 ? '' : widget.value.toString());

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _save() {
    final value = double.tryParse(_controller.text.trim()) ?? 0;
    AgentScope.read(context).updateCoreSettings({'dailyBudgetUsd': value < 0 ? 0.0 : value});
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 160,
      child: Focus(
        onFocusChange: (focused) {
          if (!focused) _save();
        },
        child: TextField(
          controller: _controller,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          decoration: const InputDecoration(prefixText: '\$ ', hintText: '不限'),
          onSubmitted: (_) => _save(),
        ),
      ),
    );
  }
}
