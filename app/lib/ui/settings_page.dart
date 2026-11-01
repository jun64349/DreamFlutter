import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

import '../main.dart' show appVersion;
import '../state/agent_controller.dart' show AgentController, groupProvider;
import '../state/preferences.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'composer.dart' show agentModeHints, agentModeNames;
import 'dashboard_page.dart';
import 'gateway_pages.dart';
import 'mcp_page.dart';
import 'providers_page.dart';
import 'sidebar.dart' show WorkspaceSwitcher;
import 'zoom.dart';

/// One setting: what the search matches, and the row itself.
class _Entry {
  const _Entry(this.text, this.child);

  final String text;
  final Widget child;
}

/// A card of entries inside a category.
class _Group {
  const _Group(this.entries, {this.title});

  final String? title;
  final List<_Entry> entries;
}

class _Category {
  const _Category(this.name, this.icon, this.groups);

  final String name;
  final IconData icon;
  final List<_Group> groups;
}

/// Settings by category on the left, the category on the right; the search
/// box looks through every category (docs/v0.2-gateway.md §6).
class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key, this.category});

  /// Category to open with, by name (e.g. '模型与网关').
  final String? category;

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  late String _selected = widget.category ?? '通用';
  final _search = TextEditingController();
  var _query = '';

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
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  List<_Category> _categories(BuildContext context, AgentController agent) {
    final colors = context.colors;
    final core = agent.coreInfo;
    final defaultKey = agent.defaultModelKey;
    final defaultModel = agent.models.where((m) => m.key == defaultKey).firstOrNull;
    final auxKey = agent.coreSettings['auxModel'] as String?;
    final visionKey = agent.coreSettings['visionModel'] as String?;
    String modelName(String key) {
      final m = agent.models.where((m) => m.key == key).firstOrNull;
      return m == null ? key : '${m.name} · ${agent.providerLabel(m.provider)}';
    }

    void open(Widget page) => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => page));

    return [
      _Category('通用', Icons.tune, [
        _Group([
          _Entry(
            '通知 系统通知 提醒',
            SwitchListTile(
              value: agent.coreSettings['notifications'] != false,
              onChanged: (v) => agent.updateCoreSettings({'notifications': v}),
              title: const Text('系统通知'),
              subtitle: const Text('任务完成、需要你确认、额度和余额提醒时，用 Windows 通知告诉你。'),
              dense: true,
            ),
          ),
          _Entry(
            '后台会话 关窗口 后台运行',
            _Row(
              title: '后台会话',
              subtitle: '会话运行在后台服务里：切走、新建会话或关掉窗口，运行中的会话都会继续。空闲的会话过一段时间会自动释放（内容保留在磁盘上）。'
                  '当前窗口连着 ${agent.runtimes.length} 个会话，${agent.backgroundRunning} 个在后台运行。',
            ),
          ),
        ]),
      ]),
      _Category('外观', Icons.palette_outlined, [
        _Group([
          _Entry('界面缩放 放大 缩小', const _Row(title: '界面缩放', subtitle: '整个界面一起放大或缩小。快捷键：Ctrl + 加号 / 减号，Ctrl + 0 恢复。', trailing: ZoomControl())),
          _Entry('文字大小 字号', const _Row(title: '文字大小', subtitle: '只调整文字，布局不变。', trailing: TextSizeControl())),
          _Entry('明暗 主题 深色 浅色 跟随系统', const _Row(title: '明暗', subtitle: '跟随系统时，白天用日间主题，夜里用夜间主题。', trailing: ThemeModeControl())),
        ]),
        _Group(title: '名画主题', [
          _Entry(
            '日间主题 名画 浅色 蛱蝶 草蝶 羽化 神思',
            const Padding(
              padding: EdgeInsets.fromLTRB(AppTokens.padLg, AppTokens.pad, AppTokens.padLg, AppTokens.pad),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('日间'), SizedBox(height: 8), ThemePicker(brightness: Brightness.light)]),
            ),
          ),
          _Entry(
            '夜间主题 名画 深色 墨夜 幽华 琉光',
            const Padding(
              padding: EdgeInsets.fromLTRB(AppTokens.padLg, AppTokens.pad, AppTokens.padLg, AppTokens.padLg),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('夜间'), SizedBox(height: 8), ThemePicker(brightness: Brightness.dark)]),
            ),
          ),
        ]),
      ]),
      _Category('模型与网关', Icons.hub_outlined, [
        _Group(title: '默认模型', [
          _Entry(
            '新会话默认模型 模型',
            _Row(
              title: '新会话默认模型',
              subtitle: defaultModel != null ? null : (defaultKey == null ? '未设置，由 Pi 决定' : '$defaultKey（当前不可用）'),
              trailing: _ModelMenu(
                tooltip: '选择默认模型',
                selected: defaultKey,
                label: defaultModel == null ? '选择' : modelName(defaultModel.key),
                onSelected: (key) => agent.setDefaultModel(agent.models.firstWhere((m) => m.key == key)),
              ),
            ),
          ),
          _Entry(
            '新会话默认思考级别 思考',
            _Row(
              title: '新会话默认思考级别',
              subtitle: '越高越仔细，但更慢、更贵',
              trailing: PopupMenuButton<String>(
                tooltip: '选择默认思考级别',
                enabled: agent.thinkingLevels.isNotEmpty,
                onSelected: agent.setDefaultThinkingLevel,
                itemBuilder: (_) => [
                  for (final level in agent.thinkingLevels) CheckedPopupMenuItem(value: level, checked: level == agent.defaultThinkingLevel, child: Text(_levelNames[level] ?? level)),
                ],
                child: _ValueChip(text: _levelNames[agent.defaultThinkingLevel] ?? '跟随 Pi'),
              ),
            ),
          ),
          _Entry(
            '辅助模型 标题 记忆整理',
            _Row(
              title: '辅助模型',
              subtitle: '生成会话标题、整理记忆等后台小任务用的模型，选便宜快速的即可；也可以选模型组',
              trailing: _ModelMenu(
                tooltip: '选择辅助模型',
                selected: auxKey ?? '',
                label: auxKey == null ? '跟随默认模型' : modelName(auxKey),
                extra: const [('', '跟随默认模型')],
                onSelected: (key) => agent.updateCoreSettings({'auxModel': key.isEmpty ? null : key}),
              ),
            ),
          ),
          _Entry(
            '看图模型 图片 多模态 视觉 转述',
            _Row(
              title: '看图模型',
              subtitle: '当前模型看不到图片时，先用它把图片转述成文字再交给当前模型（能看图的模型照常直接收到图片）；要选能看图的模型或模型组',
              trailing: _ModelMenu(
                tooltip: '选择看图模型',
                selected: visionKey ?? '',
                label: visionKey == null ? '自动选一个能看图的' : modelName(visionKey),
                extra: const [('', '自动选一个能看图的')],
                onSelected: (key) => agent.updateCoreSettings({'visionModel': key.isEmpty ? null : key}),
              ),
            ),
          ),
        ]),
        _Group(title: '渠道', [
          _Entry('渠道 服务商 api key 接口 deepseek 智谱 kimi minimax 中转 编程套餐', const Padding(padding: EdgeInsets.symmetric(horizontal: AppTokens.padLg, vertical: AppTokens.gap), child: ChannelList())),
          _Entry(
            'Pi 配置 服务商 凭证',
            _Hint('「来自 Pi 配置」的渠道是你在 Pi 里配好的服务商，Key 留在 Pi 的配置文件里（${p.join(core['agentDir'] as String? ?? SessionStore.defaultAgentDir(), 'models.json')}）。在这里新加的渠道存在 DreamFlutter 里，Key 用你的 Windows 账户加密保存。'),
          ),
        ]),
        _Group(title: '模型组', [
          _Entry('模型组 自动 切换 备用 分流 套餐', const Padding(padding: EdgeInsets.symmetric(horizontal: AppTokens.padLg, vertical: AppTokens.gap), child: GroupList())),
        ]),
        _Group(title: '更多', [
          _Entry(
            '仪表盘 用量 花费 余额 额度 pi 配置 重新加载',
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppTokens.padLg, vertical: AppTokens.gap),
              child: Wrap(
                spacing: AppTokens.gap,
                runSpacing: AppTokens.gap,
                children: [
                  OutlinedButton(onPressed: () => open(const DashboardPage()), child: const Text('仪表盘')),
                  OutlinedButton(onPressed: () => open(const ProvidersPage()), child: const Text('Pi 配置')),
                  OutlinedButton(onPressed: agent.reloadIdleSessions, child: const Text('重新加载')),
                ],
              ),
            ),
          ),
        ]),
      ]),
      _Category('对话', Icons.chat_bubble_outline, [
        _Group(title: 'Agent 模式', [
          _Entry(
            'Agent 模式 标准 极简',
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
          ),
          const _Entry('Agent 模式', _Hint('新会话用这个模式；已有的会话保持创建时的模式。两种模式都按 DeepSeek Harness 的设计实现，对 DeepSeek 模型最友好。')),
        ]),
        _Group([
          _Entry(
            '自动压缩 上下文',
            SwitchListTile(
              value: agent.defaultAutoCompaction,
              onChanged: agent.setDefaultAutoCompaction,
              title: const Text('上下文快满时自动压缩'),
              subtitle: const Text('自动把较早的对话总结成摘要，腾出空间。关闭后需要在输入框的上下文圆环里手动压缩。'),
              dense: true,
            ),
          ),
          _Entry(
            '自动生成会话标题',
            SwitchListTile(
              value: agent.coreSettings['autoTitle'] != false,
              onChanged: (v) => agent.updateCoreSettings({'autoTitle': v}),
              title: const Text('自动生成会话标题'),
              subtitle: const Text('第一轮对话结束后，用辅助模型起一个简短标题。'),
              dense: true,
            ),
          ),
        ]),
      ]),
      _Category('记忆', Icons.lightbulb_outline, [
        _Group([
          _Entry(
            '长期记忆 记忆',
            SwitchListTile(
              value: agent.coreSettings['memoryEnabled'] != false,
              onChanged: (v) => agent.updateCoreSettings({'memoryEnabled': v}),
              title: const Text('启用长期记忆'),
              subtitle: const Text('每次任务开始时带上常驻记忆块和相关记忆；Agent 也可以保存新的记忆。'),
              dense: true,
            ),
          ),
          _Entry(
            '自动整理 候选记忆',
            SwitchListTile(
              value: agent.coreSettings['memoryAutoExtract'] != false,
              onChanged: (v) => agent.updateCoreSettings({'memoryAutoExtract': v}),
              title: const Text('任务结束后自动整理候选记忆'),
              subtitle: const Text('用辅助模型从对话里找出值得记住的内容，放进「待确认」，你同意后才生效。'),
              dense: true,
            ),
          ),
          const _Entry('记忆', _Hint('记忆的内容在左侧导航的「记忆」页查看和编辑。')),
        ]),
      ]),
      _Category('安全与审批', Icons.shield_outlined, [
        _Group([
          _Entry(
            '审批 确认 ${ApprovalMode.values.map((m) => m.label).join(' ')}',
            RadioGroup<ApprovalMode>(
              groupValue: agent.approvalMode,
              onChanged: (m) => agent.setApprovalMode(m!),
              child: Column(
                children: [
                  for (final mode in ApprovalMode.values) RadioListTile<ApprovalMode>(value: mode, title: Text(mode.label), subtitle: Text(mode.description), dense: true),
                ],
              ),
            ),
          ),
          const _Entry('审批', _Hint('审批在后台完成，修改后立即生效；关掉窗口后，后台任务的确认请求会以系统通知提醒你。')),
          const _Entry('总是允许 工具 工作区', _ToolRules()),
        ]),
      ]),
      _Category('运行上限', Icons.speed_outlined, [
        _Group([
          _Entry(
            '单次运行最多轮数 轮数',
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
          ),
          _Entry(
            '每天花费上限 预算',
            _Row(
              title: '每天花费上限',
              subtitle: '所有任务当天的花费合计超过后暂停，可以选择当天不再限制。只统计填写了价格的模型。',
              trailing: _BudgetField(setting: 'dailyBudgetUsd', value: (agent.coreSettings['dailyBudgetUsd'] as num?)?.toDouble() ?? 0),
            ),
          ),
          _Entry(
            '每月花费上限 预算',
            _Row(
              title: '每月花费上限',
              subtitle: '本月 1 日起的花费合计超过后暂停，可以选择本月不再限制。仪表盘里能看到用了多少。',
              trailing: _BudgetField(setting: 'monthlyBudgetUsd', value: (agent.coreSettings['monthlyBudgetUsd'] as num?)?.toDouble() ?? 0),
            ),
          ),
        ]),
      ]),
      _Category('工具与 MCP', Icons.extension_outlined, [
        _Group([
          _Entry(
            'MCP 服务 工具',
            _Row(
              title: 'MCP 服务',
              subtitle: '给 Agent 接上外部工具（数据库、浏览器、各种 API）。',
              trailing: OutlinedButton(onPressed: () => open(const McpPage()), child: const Text('管理')),
            ),
          ),
          const _Entry('网页读取 web_fetch', _Row(title: '网页读取', subtitle: 'Agent 可以用 web_fetch 读取网页内容。只读，不需要审批。')),
        ]),
      ]),
      _Category('数据与存储', Icons.folder_outlined, [
        _Group([
          _Entry('当前工作区 文件夹', _Row(title: '当前工作区', subtitle: agent.workspace, trailing: const SizedBox(width: 260, child: WorkspaceSwitcher()))),
          _Entry(
            '会话存放位置 文件夹',
            _Row(
              title: '会话存放位置',
              subtitle: agent.sessionStore.sessionsDir,
              trailing: OutlinedButton(onPressed: () => agent.revealInExplorer(agent.sessionStore.sessionsDir), child: const Text('打开文件夹')),
            ),
          ),
          _Entry('后台数据 数据库', _InfoRow('后台数据', core['dataDir'] as String? ?? '未知')),
        ]),
      ]),
      _Category('关于', Icons.info_outline, [
        _Group([
          _Entry('版本 关于', _InfoRow('DreamFlutter', 'v$appVersion')),
          _Entry('后台服务 版本', _InfoRow('后台服务', core.isEmpty ? '未连接' : 'v${core['version']}（进程 ${core['pid']}）')),
          _Entry('Pi 版本', _InfoRow('Pi 版本', core['piVersion'] as String? ?? '未知')),
          _Entry('Node.js 运行环境', _InfoRow('Node.js', PiRuntimeLocator.findOnPath('node') ?? '未找到（需要 Node.js 22.19 以上）')),
          _Entry('Bash 运行环境', _InfoRow('Bash', PiRuntimeLocator.findGitBashDir() == null ? '使用 Pi 的默认查找顺序' : p.join(PiRuntimeLocator.findGitBashDir()!, 'bash.exe'))),
          _Entry('关于', _Hint('基于 Pi Agent 原生运行时的个人 AI Agent 桌面客户端。', color: colors.muted)),
        ]),
      ]),
    ];
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final categories = _categories(context, agent);
    final current = categories.where((c) => c.name == _selected).firstOrNull ?? categories.first;
    final query = _query.trim().toLowerCase();
    bool matches(_Category c, _Group g, _Entry e) => '${c.name} ${g.title ?? ''} ${e.text}'.toLowerCase().contains(query);

    final List<Widget> content;
    if (query.isEmpty) {
      content = [for (final g in current.groups) _Section(title: g.title ?? current.name, children: [for (final e in g.entries) e.child])];
    } else {
      content = [
        for (final c in categories)
          for (final g in c.groups)
            if (g.entries.any((e) => matches(c, g, e)))
              _Section(
                title: g.title == null ? c.name : '${c.name} › ${g.title}',
                children: [
                  for (final e in g.entries)
                    if (matches(c, g, e)) e.child,
                ],
              ),
      ];
      if (content.isEmpty) content.add(Center(child: Text('没有找到「$_query」', style: TextStyle(color: colors.muted))));
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('设置'),
        scrolledUnderElevation: 0,
        actions: [
          SizedBox(
            width: 280,
            child: TextField(
              controller: _search,
              decoration: InputDecoration(
                isDense: true,
                hintText: '搜索设置',
                prefixIcon: const Icon(Icons.search, size: 18),
                suffixIcon: _query.isEmpty
                    ? null
                    : IconButton(
                        tooltip: '清除',
                        icon: const Icon(Icons.close, size: 16),
                        onPressed: () => setState(() {
                          _search.clear();
                          _query = '';
                        }),
                      ),
              ),
              onChanged: (v) => setState(() => _query = v),
            ),
          ),
          const SizedBox(width: AppTokens.padLg),
        ],
      ),
      body: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            width: 196,
            child: ListView(
              padding: const EdgeInsets.symmetric(vertical: AppTokens.pad, horizontal: AppTokens.gap),
              children: [
                for (final c in categories)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 2),
                    child: ListTile(
                      dense: true,
                      selected: query.isEmpty && c.name == current.name,
                      selectedTileColor: colors.accentSoft,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(context.radius)),
                      leading: Icon(c.icon, size: 18),
                      title: Text(c.name),
                      onTap: () => setState(() {
                        _selected = c.name;
                        _search.clear();
                        _query = '';
                      }),
                    ),
                  ),
              ],
            ),
          ),
          const VerticalDivider(width: 1),
          Expanded(
            child: ListView(
              key: ValueKey('settings-${query.isEmpty ? current.name : 'search'}'),
              padding: const EdgeInsets.symmetric(vertical: AppTokens.padLg),
              children: content,
            ),
          ),
        ],
      ),
    );
  }
}

/// A model menu grouped by channel, model groups first.
class _ModelMenu extends StatelessWidget {
  const _ModelMenu({required this.tooltip, required this.selected, required this.label, required this.onSelected, this.extra = const []});

  final String tooltip;
  final String? selected;
  final String label;
  final ValueChanged<String> onSelected;

  /// Choices before the models, as (value, label).
  final List<(String, String)> extra;

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final byProvider = <String, List<PiModel>>{};
    for (final m in agent.models) {
      byProvider.putIfAbsent(m.provider, () => []).add(m);
    }
    final providers = byProvider.keys.toList()..sort((a, b) => (a == groupProvider ? 0 : 1).compareTo(b == groupProvider ? 0 : 1));
    return PopupMenuButton<String>(
      tooltip: tooltip,
      enabled: agent.models.isNotEmpty,
      onSelected: onSelected,
      itemBuilder: (_) => [
        for (final (value, text) in extra) CheckedPopupMenuItem(value: value, checked: value == selected, child: Text(text)),
        for (final provider in providers) ...[
          PopupMenuItem<String>(
            enabled: false,
            height: 28,
            child: Text(agent.providerLabel(provider), style: context.text.labelSmall?.copyWith(color: context.colors.muted)),
          ),
          for (final m in byProvider[provider]!) CheckedPopupMenuItem(value: m.key, checked: m.key == selected, child: Text(m.name)),
        ],
      ],
      child: _ValueChip(text: label),
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
        constraints: const BoxConstraints(maxWidth: 860),
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
                  borderRadius: BorderRadius.circular(context.radiusLg),
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
      constraints: const BoxConstraints(maxWidth: 300),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      decoration: BoxDecoration(border: Border.all(color: colors.border), borderRadius: BorderRadius.circular(context.radius)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Flexible(child: Text(text, overflow: TextOverflow.ellipsis)),
          const SizedBox(width: 4),
          Icon(Icons.expand_more, size: 16, color: colors.muted),
        ],
      ),
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
  const _BudgetField({required this.setting, required this.value});

  final String setting;
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
    AgentScope.read(context).updateCoreSettings({widget.setting: value < 0 ? 0.0 : value});
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
