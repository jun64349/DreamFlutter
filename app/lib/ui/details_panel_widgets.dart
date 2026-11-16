import 'package:flutter/material.dart';

import '../theme.dart';
import '../craft_style.dart';
import 'craft_surface.dart';
import 'painting_background.dart';
import 'proto_icon.dart';

/// The right panel heading (.rh in the prototype).
class DetailsPanelHeading extends StatelessWidget {
  const DetailsPanelHeading({super.key, this.title = '这个对话', required this.onClose, this.captionInset = 0});

  final String title;
  final VoidCallback onClose;
  final double captionInset;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 12, 12 + captionInset, 8),
      child: Row(children: [
        Expanded(child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis,
          style: context.text.bodyMedium?.copyWith(fontSize: 13.5, fontWeight: FontWeight.w600))),
        const SizedBox(width: 8),
        IconButton(
          tooltip: '收起详情',
          onPressed: onClose,
          style: IconButton.styleFrom(
            fixedSize: const Size.square(30), minimumSize: const Size.square(30), padding: EdgeInsets.zero,
            tapTargetSize: MaterialTapTargetSize.shrinkWrap, shape: craftButtonShape(context.painting.craftGeometry),
          ),
          icon: ProtoIcon('x', color: colors.ink2),
        ),
      ]),
    );
  }
}

/// The right panel's cards share a surface and an internal heading (.blk).
class DetailsPanelCard extends StatelessWidget {
  const DetailsPanelCard({super.key, required this.icon, required this.title, this.trailing, required this.child});

  final String icon;
  final String title;
  final Widget? trailing;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final heading = TextStyle(fontSize: 12.5, fontWeight: FontWeight.w500, color: colors.muted);
    return CraftCardEdge(child: Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: craftSurfaceDecoration(context, color: colors.card, borderColor: colors.ink.withValues(alpha: .07)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          ProtoIcon(icon, size: 13, color: colors.muted),
          const SizedBox(width: 6),
          Expanded(child: Text(title, style: heading)),
          if (trailing != null) DefaultTextStyle(style: heading, child: trailing!),
        ]),
        const SizedBox(height: 8),
        child,
      ]),
    ));
  }
}
