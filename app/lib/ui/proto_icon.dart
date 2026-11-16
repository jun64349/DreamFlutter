import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../craft_style.dart';
import '../theme.dart';
import 'craft_icon_paths.dart';
import 'proto_icon_paths.dart';

/// 原型 `.ic` 的细线图标：16×16、线宽 1.6、颜色跟随 [color]（默认取 IconTheme）。
/// 名字和原型 `ic('inbox')` 一样；主要导航和工具按主题取形，通用动作沿用 [protoIconPaths]。
class ProtoIcon extends StatelessWidget {
  const ProtoIcon(this.name, {super.key, this.size = 16, this.color, this.strokeWidth = 1.6});
  final String name;
  final double size;
  final Color? color;
  final double strokeWidth;

  static final _cache = <(String, double, CraftGeometry?), String>{};

  @override
  Widget build(BuildContext context) {
    final c = color ?? IconTheme.of(context).color ?? DefaultTextStyle.of(context).style.color ?? Colors.black;
    final geometry = context.painting.craftGeometry;
    final themed = craftIconPaths[geometry]?[name];
    final svg = _cache.putIfAbsent((name, strokeWidth, themed == null ? null : geometry), () {
      final angular = themed != null && geometry == CraftGeometry.angular;
      final solid = themed != null && name == 'stop';
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" '
          'fill="${solid ? '#000' : 'none'}" stroke="${solid ? 'none' : '#000'}" '
          'stroke-width="$strokeWidth" stroke-linecap="${angular ? 'butt' : 'round'}" '
          'stroke-linejoin="${angular ? 'bevel' : 'round'}">'
          '${themed ?? protoIconPaths[name] ?? ''}</svg>';
    });
    return SizedBox.square(
      dimension: size,
      child: SvgPicture.string(svg, width: size, height: size, colorFilter: ColorFilter.mode(c, BlendMode.srcIn)),
    );
  }
}
