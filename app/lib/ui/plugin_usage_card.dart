import 'dart:async';

import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'mini_charts.dart';
import 'shell_widgets.dart';

class PluginUsageCard extends StatefulWidget {
  const PluginUsageCard({super.key});

  @override
  State<PluginUsageCard> createState() => _PluginUsageCardState();
}

class _PluginUsageCardState extends State<PluginUsageCard> {
  late final AgentController _agent;
  late final StreamSubscription<Json> _events;
  late Future<List<Json>> _data;

  @override
  void initState() {
    super.initState();
    _agent = AgentScope.read(context);
    _data = _load();
    _events = _agent.backend.events
        .where((event) => event['event'] == 'run.finished')
        .listen((_) => _refresh());
  }

  Future<List<Json>> _load() async =>
      jsonRows(asJsonMap(await _agent.backend.call('plugins.usage'))['days']);

  void _refresh() {
    if (mounted) setState(() => _data = _load());
  }

  @override
  void dispose() {
    unawaited(_events.cancel());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 14),
    child: ShellCard(
      child: FutureBuilder<List<Json>>(
        future: _data,
        builder: (context, snapshot) {
          if (snapshot.hasError) {
            return Row(
              children: [
                const Expanded(child: Text('未能读取用量仪表盘')),
                ShellButton('重试', small: true, onPressed: _refresh),
              ],
            );
          }
          final days = snapshot.data;
          if (days == null) return const LinearProgressIndicator();
          int total(String key) => days.fold<int>(
            0,
            (sum, day) => sum + ((day[key] as num?)?.toInt() ?? 0),
          );
          final missing = total('missingUsage');
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              DayBarChart(
                title: '近 7 天用量',
                labels: [for (final day in days) '${day['date']}'],
                values: [
                  for (final day in days)
                    ((day['input'] as num?) ?? 0).toDouble() +
                        ((day['output'] as num?) ?? 0).toDouble(),
                ],
                format: (value) => '${value.round()} tokens',
              ),
              Wrap(
                spacing: 18,
                runSpacing: 4,
                children: [
                  Text('输入 ${total('input')}'),
                  Text('输出 ${total('output')}'),
                  Text('${total('requests')} 次请求'),
                  if (missing > 0)
                    Text('$missing 次未返回用量', style: context.text.bodySmall),
                ],
              ),
            ],
          );
        },
      ),
    ),
  );
}
