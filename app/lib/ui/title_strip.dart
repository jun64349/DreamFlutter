import 'package:flutter/material.dart';
import 'package:window_manager/window_manager.dart';

import '../theme.dart';

/// The window's own title bar (the system one is hidden): a thin strip in the
/// theme's rail colour to drag the window (double-click maximizes), with
/// minimize, maximize and close. Close hides to the tray like before.
class TitleStrip extends StatefulWidget {
  const TitleStrip({super.key});

  static const height = 32.0;

  @override
  State<TitleStrip> createState() => _TitleStripState();
}

class _TitleStripState extends State<TitleStrip> with WindowListener {
  var _maximized = false;

  @override
  void initState() {
    super.initState();
    windowManager.addListener(this);
    windowManager.isMaximized().then((value) {
      if (mounted) setState(() => _maximized = value);
    });
  }

  @override
  void dispose() {
    windowManager.removeListener(this);
    super.dispose();
  }

  @override
  void onWindowMaximize() => setState(() => _maximized = true);

  @override
  void onWindowUnmaximize() => setState(() => _maximized = false);

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final brightness = Theme.of(context).brightness;
    return Material(
      color: colors.rail,
      child: SizedBox(
        height: TitleStrip.height,
        child: Row(
          children: [
            Expanded(
              child: DragToMoveArea(
                child: SizedBox.expand(
                  child: Padding(
                    padding: const EdgeInsets.only(left: 14),
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: Text('DreamFlutter', style: context.text.labelSmall?.copyWith(color: colors.muted, letterSpacing: 0.6)),
                    ),
                  ),
                ),
              ),
            ),
            WindowCaptionButton.minimize(brightness: brightness, onPressed: windowManager.minimize),
            _maximized
                ? WindowCaptionButton.unmaximize(brightness: brightness, onPressed: windowManager.unmaximize)
                : WindowCaptionButton.maximize(brightness: brightness, onPressed: windowManager.maximize),
            WindowCaptionButton.close(brightness: brightness, onPressed: windowManager.close),
          ],
        ),
      ),
    );
  }
}
