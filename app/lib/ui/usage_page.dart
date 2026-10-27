import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';

class UsageRow {
  UsageRow.fromJson(Map<String, dynamic> json)
    : key = json['key'] as String? ?? '',
      label = json['label'] as String? ?? '',
      input = (json['input'] as num?)?.toInt() ?? 0,
      output = (json['output'] as num?)?.toInt() ?? 0,
      cacheRead = (json['cacheRead'] as num?)?.toInt() ?? 0,
      cost = (json['cost'] as num?)?.toDouble() ?? 0,
      responses = (json['responses'] as num?)?.toInt() ?? 0;

  final String key;
  final String label;
  final int input;
  final int output;
  final int cacheRead;
  final double cost;
  final int responses;

  int get tokens => input + output + cacheRead;
}

enum _Period {
  today('今天'),
  week('近 7 天'),
  month('近 30 天'),
  all('全部');

  const _Period(this.label);
  final String label;

  int? get since {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    return switch (this) {
      _Period.today => today.millisecondsSinceEpoch,
      _Period.week => today.subtract(const Duration(days: 6)).millisecondsSinceEpoch,
      _Period.month => today.subtract(const Duration(days: 29)).millisecondsSinceEpoch,
      _Period.all => null,
    };
  }
}

/// Token usage and spending from every session, by day, model, workspace
/// and session. Cost is only known for models with prices configured.
class UsagePage extends StatefulWidget {
  const UsagePage({super.key});

  @override
  State<UsagePage> createState() => _UsagePageState();
}

class _UsagePageState extends State<UsagePage> {
  var _period = _Period.week;
  final _data = <String, List<UsageRow>>{};
  String? _error;
  var _loading = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    final agent = AgentScope.read(context);
    try {
      for (final group in ['day', 'model', 'workspace', 'session']) {
        final rows = await agent.backend.call('usage.summary', {'groupBy': group, 'since': ?_period.since});
        _data[group] = (rows as List).whereType<Map>().map((r) => UsageRow.fromJson(r.cast<String, dynamic>())).toList();
      }
      _error = null;
    } catch (e) {
      _error = SessionRuntime.describeError(e);
    }
    if (mounted) setState(() => _loading = false);
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final days = _data['day'] ?? const [];
    final total = days.fold<({int tokens, double cost, int responses})>(
      (tokens: 0, cost: 0, responses: 0),
      (sum, r) => (tokens: sum.tokens + r.tokens, cost: sum.cost + r.cost, responses: sum.responses + r.responses),
    );
    return Scaffold(
      appBar: AppBar(title: const Text('用量统计'), scrolledUnderElevation: 0),
      body: _error != null
          ? Center(child: Text(_error!, style: TextStyle(color: colors.danger)))
          : ListView(
              padding: const EdgeInsets.symmetric(horizontal: AppTokens.padLg * 2, vertical: AppTokens.padLg),
              children: [
                SegmentedButton<_Period>(
                  segments: [for (final p in _Period.values) ButtonSegment(value: p, label: Text(p.label))],
                  selected: {_period},
                  onSelectionChanged: (s) {
                    setState(() => _period = s.first);
                    _load();
                  },
                ),
                const SizedBox(height: AppTokens.padLg),
                if (_loading) const LinearProgressIndicator(),
                Row(
                  children: [
                    _Stat(label: '花费', value: formatCost(total.cost)),
                    _Stat(label: '处理的 token', value: formatTokens(total.tokens)),
                    _Stat(label: '模型回复次数', value: '${total.responses}'),
                  ],
                ),
                const SizedBox(height: AppTokens.gap),
                Text('花费按模型价格计算；没有填写价格的服务商显示为 \$0，可以在「模型服务商」里补上价格。', style: context.text.bodySmall?.copyWith(color: colors.muted)),
                _Section(title: '按天', rows: days, bars: true),
                _Section(title: '按模型', rows: _data['model'] ?? const []),
                _Section(title: '按工作区', rows: _data['workspace'] ?? const [], label: (r) => p.basename(r.label).isEmpty ? r.label : p.basename(r.label)),
                _Section(title: '花费最多的会话', rows: (_data['session'] ?? const []).take(20).toList()),
              ],
            ),
    );
  }
}

String formatCost(double cost) => cost == 0 ? '\$0' : cost < 0.01 ? '<\$0.01' : '\$${cost.toStringAsFixed(2)}';

String formatTokens(int tokens) => tokens >= 1000000
    ? '${(tokens / 1000000).toStringAsFixed(1)}M'
    : tokens >= 1000
    ? '${(tokens / 1000).toStringAsFixed(1)}K'
    : '$tokens';

class _Stat extends StatelessWidget {
  const _Stat({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Expanded(
    child: Card(
      child: Padding(
        padding: const EdgeInsets.all(AppTokens.pad),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: context.text.bodySmall?.copyWith(color: context.colors.muted)),
            const SizedBox(height: 4),
            Text(value, style: context.text.headlineSmall),
          ],
        ),
      ),
    ),
  );
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.rows, this.bars = false, this.label});

  final String title;
  final List<UsageRow> rows;
  final bool bars;
  final String Function(UsageRow row)? label;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final maxTokens = rows.fold<int>(1, (m, r) => r.tokens > m ? r.tokens : m);
    return Padding(
      padding: const EdgeInsets.only(top: AppTokens.padLg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(title, style: context.text.titleSmall),
          const SizedBox(height: AppTokens.gap),
          if (rows.isEmpty) Text('没有数据', style: context.text.bodySmall?.copyWith(color: colors.muted)),
          for (final row in rows)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(
                children: [
                  SizedBox(
                    width: 260,
                    child: Tooltip(
                      message: row.label,
                      child: Text(label?.call(row) ?? row.label, maxLines: 1, overflow: TextOverflow.ellipsis),
                    ),
                  ),
                  Expanded(
                    child: bars
                        ? Align(
                            alignment: Alignment.centerLeft,
                            child: FractionallySizedBox(
                              widthFactor: (row.tokens / maxTokens).clamp(0.01, 1.0),
                              child: Container(height: 10, decoration: BoxDecoration(color: Theme.of(context).colorScheme.primary.withValues(alpha: 0.5), borderRadius: BorderRadius.circular(3))),
                            ),
                          )
                        : const SizedBox(),
                  ),
                  SizedBox(width: 90, child: Text(formatTokens(row.tokens), textAlign: TextAlign.right, style: context.text.bodySmall)),
                  SizedBox(width: 80, child: Text(formatCost(row.cost), textAlign: TextAlign.right, style: context.text.bodySmall)),
                  SizedBox(width: 70, child: Text('${row.responses} 次', textAlign: TextAlign.right, style: context.text.bodySmall?.copyWith(color: colors.muted))),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
