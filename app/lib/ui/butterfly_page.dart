import 'package:flutter/material.dart';

import '../state/agent_controller.dart';
import '../state/butterfly_tasks.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'butterfly_tasks_view.dart';
import 'chat_view.dart';

class ButterflyPage extends StatefulWidget {
  const ButterflyPage({super.key});
  @override
  State<ButterflyPage> createState() => _ButterflyPageState();
}

class _ButterflyPageState extends State<ButterflyPage> {
  late final ButterflyTasks _tasks;
  @override
  void initState() {
    super.initState();
    _tasks = ButterflyTasks(AgentScope.read(context))..load();
    butterflyTasksHub.value = _tasks;
  }

  @override
  void dispose() {
    if (butterflyTasksHub.value == _tasks) butterflyTasksHub.value = null;
    _tasks.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _tasks,
    builder: (context, _) {
      if (_tasks.loading) {
        return const Center(child: CircularProgressIndicator());
      }
      final worker = _tasks.worker;
      if (!_tasks.ready || worker == null) {
        return SingleChildScrollView(
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
                        AgentScope.read(context)
                            .showSection(AppSection.settings),
                    child: const Text('去设置'),
                  ),
                  TextButton(onPressed: _tasks.load, child: const Text('重试')),
                ],
              ),
            ],
          ),
        );
      }
      return AgentScope(
        controller: worker,
        // Plans are answered inline. Other questions remain in the unified
        // attention queue rather than blocking this conversation with a modal.
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_tasks.selected != null) ButterflyTaskHeader(tasks: _tasks),
            if (_tasks.error != null)
              Padding(
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
            Expanded(
              child: ChatView(
                emptyStateBuilder: (context, agent) => _tasks.selected == null
                    ? ButterflyTasksHome(tasks: _tasks)
                    : const SizedBox.shrink(),
                detailsPanelBuilder: (context, agent) =>
                    ButterflyTaskProgress(tasks: _tasks),
              ),
            ),
          ],
        ),
      );
    },
  );
}
