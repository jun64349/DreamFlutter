import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'common.dart';
import 'gateway_pages.dart' show describeQuota;
import 'ledger_table.dart';

/// One group of the usage summary (a day, a model, a workspace, a session).
class UsageRow {
  UsageRow.fromJson(Map<String, dynamic> json)
    : key = json['key'] as String? ?? '',
      label = json['label'] as String? ?? '',
      input = (json['input'] as num?)?.toInt() ?? 0,
      output = (json['output'] as num?)?.toInt() ?? 0,
      cacheRead = (json['cacheRead'] as num?)?.toInt() ?? 0,
      cost = (json['cost'] as num?)?.toDouble() ?? 0,
      responses = (json['responses'] as num?)?.toInt() ?? 0;

  UsageRow.sum(this.key, this.label, Iterable<UsageRow> rows)
    : input = rows.fold(0, (s, r) => s + r.input),
      output = rows.fold(0, (s, r) => s + r.output),
      cacheRead = rows.fold(0, (s, r) => s + r.cacheRead),
      cost = rows.fold(0.0, (s, r) => s + r.cost),
      responses = rows.fold(0, (s, r) => s + r.responses);

  final String key;
  final String label;
  final int input;
  final int output;
  final int cacheRead;
  final double cost;
  final int responses;

  int get tokens => input + output + cacheRead;
}

String formatCost(double cost) => cost == 0 ? '\$0' : cost < 0.01 ? '<\$0.01' : '\$${cost.toStringAsFixed(2)}';

String formatTokens(int tokens) => tokens >= 1000000
    ? '${(tokens / 1000000).toStringAsFixed(1)}M'
    : tokens >= 1000
    ? '${(tokens / 1000).toStringAsFixed(1)}K'
    : '$tokens';

String _day(DateTime d) => '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

enum _Split {
  channel('渠道'),
  model('模型'),
  workspace('工作区'),
  session('会话');

  const _Split(this.label);
  final String label;
}

/// Spending, tokens, channels and budgets in one place (docs/v0.2-gateway.md §5).
class DashboardPage extends StatefulWidget {
  const DashboardPage({super.key});

  @override
  State<DashboardPage> createState() => _DashboardPageState();
}

class _DashboardPageState extends State<DashboardPage> {
  /// Day rows of the last 62 days (this and last month, this and last week).
  List<UsageRow> _days = const [];
  final _splits = <_Split, List<UsageRow>>{};
  List<ChannelStatus> _channels = const [];
  var _split = _Split.channel;
  var _loading = true;
  var _refreshing = false;
  String? _error;

  /// Kept from the first build: dispose must not look the controller up in the tree.
  late final AgentController _agent = AgentScope.read(context);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _agent.gatewayRevision.addListener(_loadChannels);
      _load();
    });
  }

  @override
  void dispose() {
    _agent.gatewayRevision.removeListener(_loadChannels);
    super.dispose();
  }

  DateTime get _today {
    final now = DateTime.now();
    return DateTime(now.year, now.month, now.day);
  }

  int get _splitSince => _today.subtract(const Duration(days: 29)).millisecondsSinceEpoch;

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final since = _today.subtract(const Duration(days: 61)).millisecondsSinceEpoch;
      _days = jsonRows(await _agent.backend.call('usage.summary', {'groupBy': 'day', 'since': since})).map(UsageRow.fromJson).toList();
      for (final split in [_Split.model, _Split.workspace, _Split.session]) {
        _splits[split] = jsonRows(await _agent.backend.call('usage.summary', {'groupBy': split.name, 'since': _splitSince})).map(UsageRow.fromJson).toList();
      }
      _error = null;
    } catch (e) {
      _error = SessionRuntime.describeError(e);
    }
    await _loadChannels();
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _loadChannels() async {
    try {
      final rows = jsonRows(await _agent.backend.call('gateway.status')).map(ChannelStatus.fromJson).toList();
      if (mounted) setState(() => _channels = rows);
    } catch (_) {}
  }

  Future<void> _refreshQuotas() async {
    setState(() => _refreshing = true);
    try {
      final rows = jsonRows(await _agent.backend.call('gateway.refreshQuota', const {}, const Duration(seconds: 45))).map(ChannelStatus.fromJson).toList();
      if (mounted) setState(() => _channels = rows);
    } catch (_) {}
    if (mounted) setState(() => _refreshing = false);
  }

  /// Sum of the day rows in [from, to).
  UsageRow _between(DateTime from, DateTime to) {
    final a = _day(from), b = _day(to);
    return UsageRow.sum('', '', _days.where((r) => r.key.compareTo(a) >= 0 && r.key.compareTo(b) < 0));
  }

  List<UsageRow> _splitRows(AgentController agent) {
    if (_split != _Split.channel) return _splits[_split] ?? const [];
    // Usage is recorded per model ("provider/model"): add up by the channel's name.
    final byChannel = <String, List<UsageRow>>{};
    for (final row in _splits[_Split.model] ?? const <UsageRow>[]) {
      final provider = row.key.split('/').first;
      byChannel.putIfAbsent(agent.providerLabel(provider), () => []).add(row);
    }
    return [for (final e in byChannel.entries) UsageRow.sum(e.key, e.key, e.value)]..sort((a, b) => b.cost.compareTo(a.cost));
  }

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final today = _today;
    final tomorrow = today.add(const Duration(days: 1));
    final weekStart = today.subtract(const Duration(days: 6));
    final monthStart = DateTime(today.year, today.month);
    final periods = [
      ('今天', _between(today, tomorrow), _between(today.subtract(const Duration(days: 1)), today), '昨天'),
      ('近 7 天', _between(weekStart, tomorrow), _between(weekStart.subtract(const Duration(days: 7)), weekStart), '前 7 天'),
      ('本月', _between(monthStart, tomorrow), _between(DateTime(today.year, today.month - 1), DateTime(today.year, today.month - 1, today.day + 1)), '上月同期'),
    ];
    final daily = (agent.coreSettings['dailyBudgetUsd'] as num?)?.toDouble() ?? 0;
    final monthly = (agent.coreSettings['monthlyBudgetUsd'] as num?)?.toDouble() ?? 0;
    final last30 = [
      for (var i = 29; i >= 0; i--)
        (
          day: today.subtract(Duration(days: i)),
          row: _days.where((r) => r.key == _day(today.subtract(Duration(days: i)))).firstOrNull,
        ),
    ];

    return Scaffold(
      appBar: AppBar(
        title: const Text('仪表盘'),
        scrolledUnderElevation: 0,
        actions: [IconButton(tooltip: '刷新', onPressed: _loading ? null : _load, icon: const Icon(Icons.refresh)), const SizedBox(width: AppTokens.gap)],
      ),
      body: _error != null
          ? Center(child: Text(_error!, style: TextStyle(color: colors.danger)))
          : PageBody(
              children: [
                if (_loading) const LinearProgressIndicator(),
                Row(
                  children: [
                    for (final (label, now, before, beforeLabel) in periods) Expanded(child: _PeriodCard(label: label, now: now, before: before, beforeLabel: beforeLabel)),
                  ],
                ),
                if (daily > 0 || monthly > 0) ...[
                  const SizedBox(height: AppTokens.gap),
                  OutlinedCard(
                    child: Column(
                      children: [
                        if (daily > 0) _BudgetBar(label: '今天', spent: periods[0].$2.cost, cap: daily),
                        if (monthly > 0) _BudgetBar(label: '本月', spent: periods[2].$2.cost, cap: monthly),
                      ],
                    ),
                  ),
                ],
                SectionTitle(
                  '渠道',
                  count: _channels.length,
                  trailing: TextButton.icon(
                    onPressed: _refreshing ? null : _refreshQuotas,
                    icon: _refreshing ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.sync, size: 16),
                    label: const Text('查询余额和额度'),
                  ),
                ),
                if (_channels.isEmpty) const EmptyNote('还没有渠道。在「设置 › 模型与网关」里添加。'),
                Wrap(
                  spacing: AppTokens.gap,
                  runSpacing: AppTokens.gap,
                  children: [for (final c in _channels) SizedBox(width: 340, child: _ChannelTile(status: c))],
                ),
                const SectionTitle('逐请求核对'),
                const LedgerTable(),
                const SectionTitle('最近 30 天的花费'),
                _DailyBars(days: last30),
                SectionTitle(
                  '近 30 天按${_split.label}',
                  trailing: SegmentedButton<_Split>(
                    showSelectedIcon: false,
                    segments: [for (final s in _Split.values) ButtonSegment(value: s, label: Text(s.label))],
                    selected: {_split},
                    onSelectionChanged: (s) => setState(() => _split = s.first),
                  ),
                ),
                _SplitTable(
                  header: _split.label,
                  rows: _splitRows(agent).take(20).toList(),
                  label: (r) => switch (_split) {
                    _Split.workspace => p.basename(r.label).isEmpty ? r.label : p.basename(r.label),
                    _Split.model => '${r.key.split('/').skip(1).join('/')} · ${agent.providerLabel(r.key.split('/').first)}',
                    _ => r.label,
                  },
                ),
                const SizedBox(height: AppTokens.pad),
                Text('上方旧摘要仅合计已知 USD 金额，不含缺失金额与其他币种；完整币种、估算、套餐占用和历史导入见逐请求账本。', style: context.text.bodySmall?.copyWith(color: colors.muted)),
              ],
            ),
    );
  }
}

class _PeriodCard extends StatelessWidget {
  const _PeriodCard({required this.label, required this.now, required this.before, required this.beforeLabel});

  final String label;
  final UsageRow now;
  final UsageRow before;
  final String beforeLabel;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final change = before.cost > 0 ? (now.cost - before.cost) / before.cost * 100 : null;
    return OutlinedCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: context.text.bodySmall?.copyWith(color: colors.muted)),
          const SizedBox(height: 4),
          Text(formatCost(now.cost), style: context.serif(context.text.headlineSmall)),
          const SizedBox(height: 2),
          Text('${formatTokens(now.tokens)} token · ${now.responses} 次回复', style: context.text.bodySmall),
          const SizedBox(height: 2),
          Text(
            change == null ? '$beforeLabel没有花费' : '比$beforeLabel ${change >= 0 ? '多' : '少'} ${change.abs().round()}%',
            style: context.text.bodySmall?.copyWith(color: change != null && change > 0 ? colors.ochre : colors.muted),
          ),
        ],
      ),
    );
  }
}

class _BudgetBar extends StatelessWidget {
  const _BudgetBar({required this.label, required this.spent, required this.cap});

  final String label;
  final double spent;
  final double cap;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final ratio = (spent / cap).clamp(0.0, 1.0);
    final color = ratio >= 1 ? colors.danger : ratio >= 0.8 ? colors.warning : colors.accent;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          SizedBox(width: 72, child: Text('$label上限')),
          Expanded(child: _Meter(value: ratio, color: color)),
          SizedBox(width: 140, child: Text('${formatCost(spent)} / ${formatCost(cap)}', textAlign: TextAlign.right, style: context.text.bodySmall)),
        ],
      ),
    );
  }
}

class _Meter extends StatelessWidget {
  const _Meter({required this.value, required this.color});

  final double value;
  final Color color;

  @override
  Widget build(BuildContext context) => ClipRRect(
    borderRadius: BorderRadius.circular(3),
    child: LinearProgressIndicator(value: value, minHeight: 6, color: color, backgroundColor: context.colors.border),
  );
}

class _ChannelTile extends StatelessWidget {
  const _ChannelTile({required this.status});

  final ChannelStatus status;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final down = status.unavailable;
    final dot = down == null ? colors.success : (down.resting ? colors.warning : colors.danger);
    final quota = status.quota;
    final lastError = status.lastError;
    return OutlinedCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(width: 8, height: 8, decoration: BoxDecoration(color: dot, shape: BoxShape.circle)),
              const SizedBox(width: AppTokens.gap),
              Expanded(child: Text(status.name, style: context.text.titleSmall, overflow: TextOverflow.ellipsis)),
              TagChip(channelKindNames[status.kind] ?? status.kind, color: status.kind == 'plan' ? colors.accent : colors.ochre),
            ],
          ),
          const SizedBox(height: 4),
          Text(down == null ? '正常' : down.describe(), style: context.text.bodySmall?.copyWith(color: down == null ? colors.muted : dot)),
          if (quota?.type == 'plan')
            for (final w in quota!.windows)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Row(
                  children: [
                    SizedBox(width: 64, child: Text(w.label, style: context.text.bodySmall)),
                    Expanded(child: w.usedPercent == null ? const Text('未知') : _Meter(value: w.usedPercent! / 100, color: w.usedPercent! >= 100 ? colors.danger : w.usedPercent! >= 80 ? colors.warning : colors.accent)),
                    SizedBox(width: 54, child: Text(w.usedPercent == null ? '未知' : '${w.usedPercent!.round()}%', textAlign: TextAlign.right, style: context.text.bodySmall)),
                  ],
                ),
              )
          else if (describeQuota(status).isNotEmpty)
            Padding(padding: const EdgeInsets.only(top: 4), child: Text(describeQuota(status), style: context.text.bodySmall)),
          if (quota?.type == 'plan') const Text('供应商套餐用量读数'),
          if (status.quotaError != null) ...[
            Text('当前查询：${status.quotaError!['message'] ?? '未知'}', style: TextStyle(color: colors.danger)),
            if (quota?.type != 'error' && quota != null) Text('保留上次有效读数：${quota.checkedAt.toLocal()}'),
            for (final b in jsonRows(asJsonMap(status.quotaError!['observed'])['balances'])) Text('本次 ${b['currency']}：${b['amount'] is num ? b['amount'] : '未知'}'),
            for (final w in jsonRows(asJsonMap(status.quotaError!['observed'])['windows'])) Text('本次 ${w['label']}：${w['usedPercent'] is num ? '${w['usedPercent']}%' : '未知'}'),
          ],
          if (status.localUsage != null) ...[
            const SizedBox(height: 6),
            const Text('本机累计用量（估算）'),
            for (final e in asJsonMap(status.localUsage!['allowance']).entries) Text('${e.key.split(':').first} ${e.value} · ${e.key.endsWith(':provider') ? '供应商逐笔计量累计' : '按官方规则估算'}'),
            if (asJsonMap(status.localUsage!['allowance']).isEmpty) const Text('套餐占用计量未知；不推算剩余'),
          ],
          const SizedBox(height: 6),
          Text(
            [
              '今天 ${status.requestsToday} 次请求',
              if (status.failuresToday > 0) '${status.failuresToday} 次出错',
              if (status.avgFirstTokenMs != null) '首字 ${(status.avgFirstTokenMs! / 1000).toStringAsFixed(1)} 秒',
              if (status.costToday > 0) formatCost(status.costToday),
            ].join(' · '),
            style: context.text.bodySmall?.copyWith(color: colors.muted),
          ),
          if (lastError != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Tooltip(
                message: '${lastError['message'] ?? ''}',
                child: Text(
                  '最近出错：${_ago(DateTime.fromMillisecondsSinceEpoch((lastError['at'] as num).toInt()))} · ${'${lastError['message'] ?? ''}'.split('\n').first}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.text.bodySmall?.copyWith(color: colors.muted),
                ),
              ),
            ),
        ],
      ),
    );
  }

  static String _ago(DateTime at) {
    final d = DateTime.now().difference(at);
    if (d.inMinutes < 1) return '刚刚';
    if (d.inHours < 1) return '${d.inMinutes} 分钟前';
    if (d.inDays < 1) return '${d.inHours} 小时前';
    return '${d.inDays} 天前';
  }
}

class _DailyBars extends StatelessWidget {
  const _DailyBars({required this.days});

  final List<({DateTime day, UsageRow? row})> days;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final peak = days.fold<double>(0, (m, d) => (d.row?.cost ?? 0) > m ? d.row!.cost : m);
    return SizedBox(
      height: 120,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          for (final d in days)
            Expanded(
              child: Tooltip(
                message: '${d.day.month}月${d.day.day}日 · ${formatCost(d.row?.cost ?? 0)} · ${formatTokens(d.row?.tokens ?? 0)} token',
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 1.5),
                  child: Align(
                    alignment: Alignment.bottomCenter,
                    child: FractionallySizedBox(
                      heightFactor: peak == 0 ? 0.02 : ((d.row?.cost ?? 0) / peak).clamp(0.02, 1.0),
                      child: Container(
                        decoration: BoxDecoration(
                          color: (d.row?.cost ?? 0) > 0 ? colors.accent.withValues(alpha: 0.7) : colors.border,
                          borderRadius: const BorderRadius.vertical(top: Radius.circular(2)),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _SplitTable extends StatelessWidget {
  const _SplitTable({required this.header, required this.rows, required this.label});

  /// What the first column lists (工作区, 模型…).
  final String header;
  final List<UsageRow> rows;
  final String Function(UsageRow row) label;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final peak = rows.fold<double>(0, (m, r) => r.cost > m ? r.cost : m);
    if (rows.isEmpty) return const EmptyNote('没有数据');
    final head = context.text.bodySmall?.copyWith(color: colors.muted, fontWeight: FontWeight.w600);
    return Column(
      children: [
        // Column names (v0.3.1 test 10: the numbers had no headings).
        Container(
          padding: const EdgeInsets.only(bottom: 4),
          margin: const EdgeInsets.only(bottom: 2),
          decoration: BoxDecoration(border: Border(bottom: BorderSide(color: colors.border))),
          child: Row(
            children: [
              SizedBox(width: 280, child: Text(header, style: head)),
              Expanded(child: Text('花费占比', style: head)),
              SizedBox(width: 80, child: Text('token', textAlign: TextAlign.right, style: head)),
              SizedBox(width: 80, child: Text('花费', textAlign: TextAlign.right, style: head)),
              SizedBox(width: 64, child: Text('回复', textAlign: TextAlign.right, style: head)),
            ],
          ),
        ),
        for (final row in rows)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 3),
            child: Row(
              children: [
                SizedBox(width: 280, child: Tooltip(message: row.label, child: Text(label(row), maxLines: 1, overflow: TextOverflow.ellipsis))),
                Expanded(
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: FractionallySizedBox(
                      widthFactor: peak == 0 ? 0.01 : (row.cost / peak).clamp(0.01, 1.0),
                      child: Container(height: 8, decoration: BoxDecoration(color: colors.accent.withValues(alpha: 0.5), borderRadius: BorderRadius.circular(3))),
                    ),
                  ),
                ),
                SizedBox(width: 80, child: Text(formatTokens(row.tokens), textAlign: TextAlign.right, style: context.text.bodySmall)),
                SizedBox(width: 80, child: Text(formatCost(row.cost), textAlign: TextAlign.right, style: context.text.bodySmall)),
                SizedBox(width: 64, child: Text('${row.responses} 次', textAlign: TextAlign.right, style: context.text.bodySmall?.copyWith(color: colors.muted))),
              ],
            ),
          ),
      ],
    );
  }
}
