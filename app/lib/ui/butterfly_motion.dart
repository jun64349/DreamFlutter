import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';

import '../state/agent_controller.dart';
import '../theme.dart';

enum ButterflyActivity {
  idle,
  received,
  thinking,
  searching,
  reading,
  working,
  waiting,
  writing,
  complete,
  paused,
}

/// Only observed session data selects a pose. Animation never advances progress.
ButterflyActivity butterflyActivity(AgentController agent) {
  if (agent.status == ConnectionStatus.crashed ||
      agent.status == ConnectionStatus.missingRuntime) { return ButterflyActivity.paused; }
  if (agent.active?.pendingDialogs.isNotEmpty ?? false) { return ButterflyActivity.waiting; }
  final last = agent.transcript.items.whereType<AssistantItem>().lastOrNull;
  if (!agent.isRunning) {
    if (last == null) return ButterflyActivity.idle;
    if (last.failed || last.aborted) return ButterflyActivity.paused;
    return ButterflyActivity.complete;
  }
  final tools = agent.transcript.tools.values.where((t) => t.isActive);
  if (tools.isNotEmpty) {
    final name = tools.last.name.toLowerCase();
    if (RegExp('search|fetch|browse').hasMatch(name)) { return ButterflyActivity.searching; }
    if (RegExp('read|list|glob').hasMatch(name)) { return ButterflyActivity.reading; }
    return ButterflyActivity.working;
  }
  final current = agent.transcript.items.lastOrNull;
  final part = current is AssistantItem ? current.parts.lastOrNull : null;
  if (part is ThinkingPart) return ButterflyActivity.thinking;
  if (part is TextPart) return ButterflyActivity.writing;
  return ButterflyActivity.received;
}

class ButterflyAvatar extends StatefulWidget {
  const ButterflyAvatar({super.key, required this.activity, this.size = 40});
  final ButterflyActivity activity;
  final double size;

  @override
  State<ButterflyAvatar> createState() => _ButterflyAvatarState();
}

class _ButterflyAvatarState extends State<ButterflyAvatar>
    with SingleTickerProviderStateMixin {
  late final _motion = AnimationController(
    vsync: this,
    duration: AppTokens.slow * 5,
  );

  void _sync() {
    final animate =
        !MediaQuery.disableAnimationsOf(context) &&
        TickerMode.valuesOf(context).enabled &&
        ![
          ButterflyActivity.idle,
          ButterflyActivity.complete,
          ButterflyActivity.waiting,
          ButterflyActivity.paused,
        ].contains(widget.activity);
    if (animate && !_motion.isAnimating) _motion.repeat();
    if (!animate) {
      _motion.stop();
      _motion.value = 0;
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void didUpdateWidget(ButterflyAvatar oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.activity == widget.activity) return;
    _motion.stop();
    if ([ButterflyActivity.complete, ButterflyActivity.waiting].contains(widget.activity) && !MediaQuery.disableAnimationsOf(context) && TickerMode.valuesOf(context).enabled) {
      _motion.duration = AppTokens.slow;
      _motion.forward(from: 0);
    } else {
      _motion.duration = AppTokens.slow * 5;
      _sync();
    }
  }

  @override
  void dispose() {
    _motion.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _motion,
    child: ButterflyMark(size: widget.size),
    builder: (context, child) {
      final reduced = MediaQuery.disableAnimationsOf(context);
      final wave = math.sin(_motion.value * math.pi * 2);
      final a = widget.activity;
      final tilt = switch (a) {
        ButterflyActivity.searching => -0.12,
        ButterflyActivity.reading => 0.12,
        ButterflyActivity.working => 0.05,
        ButterflyActivity.writing => -0.04,
        _ => 0.0,
      };
      final fold = switch (a) {
        ButterflyActivity.received => 0.13,
        ButterflyActivity.thinking => 0.07,
        ButterflyActivity.waiting => 0.18,
        ButterflyActivity.writing => 0.04,
        _ => 0.09,
      };
      return Transform.translate(
        offset: Offset(
          0,
          reduced ? 0 : wave * (a == ButterflyActivity.working ? 1 : 2.5),
        ),
        child: Transform.rotate(
          angle: reduced ? 0 : tilt,
          child: Transform.scale(scaleX: (a == ButterflyActivity.waiting && !reduced ? .82 : 1) - wave.abs() * fold, child: child),
        ),
      );
    },
  );
}
