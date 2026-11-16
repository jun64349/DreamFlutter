import 'dart:math' as math;

import 'package:flutter/material.dart';
import '../state/voice_input.dart';
import '../theme.dart';

/// The composer's bottom row while recording (prototype .wave, .rectime, .mic.rec):
/// a live level wave, the elapsed time, cancel, and the stop button where the mic was.
class VoiceRecordingBar extends StatelessWidget {
  const VoiceRecordingBar({super.key, required this.voice});
  final VoiceInput voice;
  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Row(children: [
      const SizedBox(width: 4),
      Expanded(child: SizedBox(height: 26, child: CustomPaint(painter: _VoiceWave(voice.level, voice.seconds, colors.seal)))),
      const SizedBox(width: 10),
      Text('${voice.seconds ~/ 60}:${(voice.seconds % 60).toString().padLeft(2, '0')}', style: context.text.bodySmall?.copyWith(fontSize: 12.5, color: colors.seal, fontFeatures: const [FontFeature.tabularFigures()])),
      const SizedBox(width: 4),
      IconButton(tooltip: '取消录音', visualDensity: VisualDensity.compact, onPressed: voice.cancel, icon: Icon(Icons.close, size: 17, color: colors.ink2)),
      SizedBox.square(dimension: 30, child: IconButton.filled(
        tooltip: '结束录音',
        padding: EdgeInsets.zero,
        onPressed: voice.starting || voice.ending ? null : voice.end,
        style: IconButton.styleFrom(backgroundColor: colors.seal, foregroundColor: Colors.white, shape: const CircleBorder()),
        icon: const Icon(Icons.stop_rounded, size: 17),
      )),
      const SizedBox(width: 4),
    ]);
  }
}

class _VoiceWave extends CustomPainter {
  _VoiceWave(this.level, this.seconds, this.color);
  final double level;
  final int seconds;
  final Color color;
  @override
  void paint(Canvas canvas, Size size) {
    const bar = 4.0, gap = 2.0;
    final count = math.min(42, (size.width / (bar + gap)).floor());
    final pen = Paint()..color = color.withValues(alpha: .8);
    for (var i = 0; i < count; i++) {
      // A fixed ripple shaped by the live level, so quiet stays low and speech rises.
      final ripple = .35 + .65 * (0.5 + 0.5 * math.sin(i * 1.7 + seconds * 2.3)).abs();
      final height = (3 + level.clamp(0, 1) * 20 * ripple).clamp(3.0, size.height);
      canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(i * (bar + gap), (size.height - height) / 2, bar, height), const Radius.circular(2)), pen);
    }
  }
  @override
  bool shouldRepaint(_VoiceWave old) => old.level != level || old.seconds != seconds || old.color != color;
}
