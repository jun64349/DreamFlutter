import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../theme.dart';
import 'agent_scope.dart';

/// Display names for where a slash command comes from.
const commandSourceLabels = {'skill': '技能', 'prompt': '提示模板', 'extension': '扩展命令'};

/// Lists the skills, prompt templates and extension commands Pi discovered.
/// Choosing one puts `/name ` into the input box.
Future<void> showCommandsDialog(BuildContext context) =>
    showDialog<void>(context: context, builder: (_) => const _CommandsDialog());

class _CommandsDialog extends StatefulWidget {
  const _CommandsDialog();

  @override
  State<_CommandsDialog> createState() => _CommandsDialogState();
}

class _CommandsDialogState extends State<_CommandsDialog> {
  var _query = '';

  @override
  Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final colors = context.colors;
    final query = _query.toLowerCase();
    final commands = agent.commands
        .where((c) => query.isEmpty || c.name.toLowerCase().contains(query) || c.description.toLowerCase().contains(query))
        .toList();
    final groups = <String, List<SlashCommand>>{};
    for (final c in commands) {
      groups.putIfAbsent(c.source, () => []).add(c);
    }
    return Dialog(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 620, maxHeight: 620),
        child: Padding(
          padding: const EdgeInsets.all(AppTokens.padLg + 4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Text('Skills 与命令', style: context.text.titleLarge),
                  const Spacer(),
                  IconButton(onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close), tooltip: '关闭'),
                ],
              ),
              Text(
                '这些能力来自 Pi：~/.pi/agent 下的 skills、prompts、extensions，以及工作区里的同名目录。在输入框里输入 / 也能直接调出。',
                style: context.text.bodySmall?.copyWith(color: colors.muted),
              ),
              const SizedBox(height: AppTokens.pad),
              TextField(
                autofocus: true,
                decoration: const InputDecoration(prefixIcon: Icon(Icons.search, size: 18), hintText: '搜索名称或说明'),
                onChanged: (v) => setState(() => _query = v),
              ),
              const SizedBox(height: AppTokens.pad),
              Expanded(
                child: commands.isEmpty
                    ? Center(
                        child: Text(
                          agent.commands.isEmpty ? '当前还没有可用的技能或命令。\n把技能放进 ~/.pi/agent/skills 后，在设置里点「重新加载」。' : '没有匹配的结果',
                          textAlign: TextAlign.center,
                          style: context.text.bodyMedium?.copyWith(color: colors.muted),
                        ),
                      )
                    : ListView(
                        children: [
                          for (final source in ['skill', 'prompt', 'extension', ...groups.keys.where((k) => !commandSourceLabels.containsKey(k))])
                            if (groups[source] != null) ...[
                              Padding(
                                padding: const EdgeInsets.fromLTRB(4, 8, 4, 4),
                                child: Text(
                                  commandSourceLabels[source] ?? source,
                                  style: context.text.labelMedium?.copyWith(color: colors.muted),
                                ),
                              ),
                              for (final command in groups[source]!)
                                ListTile(
                                  dense: true,
                                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(context.radiusSm)),
                                  title: Text('/${command.name}', style: TextStyle(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback)),
                                  subtitle: command.description.isEmpty ? null : Text(command.description, maxLines: 2, overflow: TextOverflow.ellipsis),
                                  trailing: const Icon(Icons.north_west, size: 16),
                                  onTap: () {
                                    agent.insertIntoComposer('/${command.name} ');
                                    Navigator.pop(context);
                                  },
                                ),
                            ],
                        ],
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
