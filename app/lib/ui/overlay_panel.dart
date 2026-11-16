import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../craft_style.dart';
import '../theme.dart';
import 'motion.dart';
import 'proto_icon.dart';
import 'craft_surface.dart';

/// Sidebar links remain usable wherever an overlay does not cover them.
class ShellOverlaySidebar extends InheritedWidget {
  const ShellOverlaySidebar({super.key, required this.width, required super.child});
  final double width;
  static double widthOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<ShellOverlaySidebar>()?.width ?? 0;
  @override bool updateShouldNotify(ShellOverlaySidebar oldWidget) => oldWidget.width != width;
}

class ShellOverlay extends StatelessWidget {
  const ShellOverlay({super.key, required this.child, required this.onClose, this.width = 1080, this.height = 780, this.label = '浮层', this.padding = 20, this.color});

  final Widget child;
  final VoidCallback onClose;
  final double width;
  final double height;
  final String label;
  final double padding;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final scrim = colors.background.computeLuminance() > .5 ? const Color(0x4728201A) : const Color(0x73000000);
    final sidebarWidth = ShellOverlaySidebar.widthOf(context);
    return CallbackShortcuts(
      bindings: {const SingleActivator(LogicalKeyboardKey.escape): onClose},
      child: FocusScope(
        autofocus: true,
        onKeyEvent: (_, event) {
          if (event is KeyDownEvent && event.logicalKey == LogicalKeyboardKey.escape) { onClose(); return KeyEventResult.handled; }
          return KeyEventResult.ignored;
        },
        child: Stack(children: [
          Positioned.fill(child: FadeSlideIn(child: Stack(children: [
            Positioned.fill(child: IgnorePointer(child: ColoredBox(color: scrim))),
            Positioned.fill(left: sidebarWidth, child: GestureDetector(behavior: HitTestBehavior.opaque, onTap: onClose)),
          ]))),
          Center(child: Padding(
            padding: EdgeInsets.all(padding),
            child: TweenAnimationBuilder<double>(
              tween: Tween(begin: 0, end: 1),
              duration: AppTokens.motion(context, AppTokens.panel),
              curve: AppTokens.curve,
              builder: (context, value, child) => Opacity(opacity: value, child: Transform.translate(offset: Offset(0, 6 * (1 - value)), child: Transform.scale(scale: .985 + .015 * value, child: child))),
              child: Semantics(
                label: label,
                child: ConstrainedBox(
                  constraints: BoxConstraints(maxWidth: width, maxHeight: height),
                  child: Material(
                    color: color ?? colors.card,
                    clipBehavior: Clip.antiAlias,
                    shape: craftSurfaceShape(context, radius: 18, borderColor: colors.ink.withValues(alpha: .07)),
                    elevation: 12,
                    shadowColor: Colors.black.withValues(alpha: .2),
                    child: SizedBox(width: width, height: height, child: child),
                  ),
                ),
              ),
            ),
          )),
        ]),
      ),
    );
  }
}

class OverlayCloseButton extends StatelessWidget {
  const OverlayCloseButton({super.key, required this.onClose});
  final VoidCallback onClose;
  @override
  Widget build(BuildContext context) => PressFeedback(
    child: IconButton(
      tooltip: '关闭（Esc）',
      onPressed: onClose,
      style: craftControlStyle(context, IconButton.styleFrom(
        fixedSize: const Size.square(30), minimumSize: const Size.square(30),
        padding: EdgeInsets.zero, tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        shape: craftButtonShape(context.painting.craftGeometry),
      )),
      icon: ProtoIcon('x', color: context.colors.ink2),
    ),
  );
}
