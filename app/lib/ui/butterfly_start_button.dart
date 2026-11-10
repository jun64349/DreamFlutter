import 'dart:async';
import 'package:flutter/material.dart';
import 'package:pi_rpc/pi_rpc.dart';
import '../theme.dart';

/// The core owns the deadline and starts the task. This only draws its wait.
class ButterflyStartButton extends StatefulWidget {
  const ButterflyStartButton({super.key, required this.intent, required this.onPressed});
  final Json intent;
  final VoidCallback? onPressed;
  @override
  State<ButterflyStartButton> createState() => _ButterflyStartButtonState();
}

class _ButterflyStartButtonState extends State<ButterflyStartButton> with SingleTickerProviderStateMixin {
  late final _progress = AnimationController(vsync: this, animationBehavior: AnimationBehavior.preserve);
  Timer? _clock;
  bool get _timed => widget.intent['created_at'] is num && widget.intent['start_at'] is num && (widget.intent['start_at'] as num) > (widget.intent['created_at'] as num);
  double _value() => ((DateTime.now().millisecondsSinceEpoch - (widget.intent['created_at'] as num)) / ((widget.intent['start_at'] as num) - (widget.intent['created_at'] as num))).clamp(0.0, 1.0);
  void _sync() {
    _clock?.cancel(); _progress.stop();
    if (!_timed) return;
    _progress.value = _value();
    if (!TickerMode.valuesOf(context).enabled) return;
    if (_progress.value == 1) return;
    if (MediaQuery.disableAnimationsOf(context)) {
      _clock = Timer.periodic(const Duration(seconds: 1), (timer) { _progress.value = _value(); if (_progress.value == 1) timer.cancel(); });
    } else {
      final left = (widget.intent['start_at'] as num).toInt() - DateTime.now().millisecondsSinceEpoch;
      if (left > 0) _progress.animateTo(1, duration: Duration(milliseconds: left), curve: Curves.linear);
    }
  }
  @override
  void didChangeDependencies() { super.didChangeDependencies(); _sync(); }
  @override
  void didUpdateWidget(ButterflyStartButton oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.intent['id'] != widget.intent['id'] || oldWidget.intent['start_at'] != widget.intent['start_at'] || oldWidget.intent['created_at'] != widget.intent['created_at']) _sync();
  }
  @override
  void dispose() { _clock?.cancel(); _progress.dispose(); super.dispose(); }
  @override
  Widget build(BuildContext context) => Stack(children: [
    FilledButton(onPressed: widget.onPressed, child: const Text('可以，开始吧')),
    if (_timed) Positioned(left: 12, right: 12, bottom: 3, child: IgnorePointer(child: AnimatedBuilder(animation: _progress, builder: (context, _) => LinearProgressIndicator(
      key: const ValueKey('butterfly-start-progress'), value: _progress.value, minHeight: 2,
      color: context.colors.onAccent.withValues(alpha: 0.8), backgroundColor: context.colors.onAccent.withValues(alpha: 0.16),
      semanticsLabel: '开工等待进度',
    )))),
  ]);
}
