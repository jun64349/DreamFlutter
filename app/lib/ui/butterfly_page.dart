import 'package:flutter/material.dart';

import '../state/butterfly_tasks.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'butterfly_tasks_view.dart';
import 'chat_view.dart';
import 'goal_widgets.dart';

class ButterflyPage extends StatefulWidget {
  const ButterflyPage({super.key, this.headerBuilder, this.captionInset = 0});
  final Widget Function(bool panelVisible)? headerBuilder;
  final double captionInset;
  @override
  State<ButterflyPage> createState() => _ButterflyPageState();
}

class _ButterflyPageState extends State<ButterflyPage> {
  late final ButterflyTasks _tasks;
  @override
  void initState() {
    super.initState();
    _tasks = ButterflyTasks(AgentScope.read(context))..load();
  }

  @override
  void dispose() {
    _tasks.dispose();
    super.dispose();
  }

  Widget _withoutPanel(Widget body) {
    final header = widget.headerBuilder?.call(false);
    return header == null ? body : Column(children: [header, Expanded(child: body)]);
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _tasks,
    builder: (context, _) {
      if (_tasks.loading) {
        return _withoutPanel(const Center(child: CircularProgressIndicator()));
      }
      final worker = _tasks.worker;
      if (!_tasks.ready || worker == null) {
        return _withoutPanel(SingleChildScrollView(
          padding: const EdgeInsets.all(40),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '交给我吧，你去忙别的',
                style: context.handwriting(context.text.headlineMedium),
              ),
              const SizedBox(height: 24),
              Text(
                _tasks.error == null ? '蝶君的沙箱还没准备好' : '蝶君暂时打不开：${_tasks.error}',
              ),
              const SizedBox(height: 16),
              Wrap(
                spacing: 12,
                children: [
                  FilledButton(
                    onPressed: () =>
                        AgentScope.read(context).openSettings('蝶君'),
                    child: const Text('去设置'),
                  ),
                  TextButton(onPressed: _tasks.load, child: const Text('重试')),
                ],
              ),
            ],
          ),
        ));
      }
      return AgentScope(
        controller: worker,
        // Plans are answered inline. Other questions remain in the unified
        // attention queue rather than blocking this conversation with a modal.
        child: ChatView(
          headerBuilder: widget.headerBuilder,
          captionInset: widget.captionInset,
          emptyStateBuilder: (context, agent) => ButterflyTasksHome(tasks: _tasks),
          detailsPanelBuilder: (context, agent) => ButterflyTaskProgress(
            tasks: _tasks,
            captionInset: widget.captionInset,
            leadingSections: const ConversationGoalSections(showEmpty: true),
          ),
          notice: _tasks.error == null && !_tasks.preparing ? null : Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (_tasks.error != null) Padding(
                padding: const EdgeInsets.symmetric(horizontal: 24),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        '没有完成：${_tasks.error}',
                        style: TextStyle(color: context.colors.danger),
                      ),
                    ),
                    TextButton(onPressed: _tasks.load, child: const Text('重试')),
                  ],
                ),
              ),
              if (_tasks.preparing) const LinearProgressIndicator(minHeight: 2),
            ],
          ),
        ),
      );
    },
  );
}
