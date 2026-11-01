import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:pasteboard/pasteboard.dart';

import '../theme.dart';
import 'card_view.dart' show themeCssOf, themeVarsOf;
import 'markdown_view.dart' show CodeBlock;
import 'web_surface.dart';

/// Code block languages the window draws instead of printing (plan §C4).
const richLanguages = {'mermaid', 'chart', 'svg'};

class RichResult {
  const RichResult({required this.png, required this.width, required this.height, this.svg});

  final Uint8List png;
  final double width;
  final double height;
  final String? svg;
}

/// Draws Mermaid diagrams, charts (Chart.js) and SVG to pictures in one
/// hidden WebView that loads the core's renderer page (/render/renderer.html).
class RichRenderer {
  RichRenderer._();

  static final instance = RichRenderer._();

  /// `http://127.0.0.1:<port>` of the core; a new port (the core restarted) starts over.
  static String? baseUrl;

  static void configure(int? port) {
    final url = port == null || port == 0 ? null : 'http://127.0.0.1:$port';
    if (url == baseUrl) return;
    baseUrl = url;
    unawaited(instance.dispose());
  }

  WebSurface? _surface;
  Future<bool>? _ready;
  StreamSubscription<Map<String, dynamic>>? _sub;
  final _pending = <String, Completer<RichResult>>{};
  final _cache = <String, RichResult>{};
  var _seq = 0;

  Future<bool> _start() => _ready ??= () async {
    final base = baseUrl;
    if (base == null) return false;
    final surface = await WebSurfaces.create();
    if (surface == null) return false;
    final ready = Completer<bool>();
    _sub = surface.messages.listen((m) {
      if (m['ready'] == true && !ready.isCompleted) ready.complete(true);
      final id = m['id'];
      final completer = id is String ? _pending.remove(id) : null;
      if (completer == null) return;
      if (m['ok'] == true && m['png'] is String) {
        completer.complete(
          RichResult(png: base64Decode(m['png'] as String), width: (m['width'] as num?)?.toDouble() ?? 600, height: (m['height'] as num?)?.toDouble() ?? 400, svg: m['svg'] as String?),
        );
      } else {
        completer.completeError(m['error']?.toString() ?? '绘制失败');
      }
    });
    await surface.load('$base/render/renderer.html');
    _surface = surface;
    return ready.future.timeout(const Duration(seconds: 20), onTimeout: () => false);
  }();

  /// Draws [source]; [css] carries the theme variables, [width] the space available.
  Future<RichResult> render(String kind, String source, {required String css, required bool dark, double width = 680, double scale = 2}) async {
    final key = '$kind|$dark|${width.round()}|$scale|$css|$source';
    final hit = _cache[key];
    if (hit != null) return hit;
    if (!await _start()) throw StateError('这台电脑不能绘制图形（缺少 WebView2）');
    final id = 'r${++_seq}';
    final completer = Completer<RichResult>();
    _pending[id] = completer;
    await _surface!.post({'id': id, 'kind': kind, 'source': source, 'css': css, 'dark': dark, 'width': width, 'scale': scale});
    final result = await completer.future.timeout(const Duration(seconds: 30), onTimeout: () {
      _pending.remove(id);
      throw TimeoutException('绘制超时');
    });
    _cache[key] = result;
    if (_cache.length > 80) _cache.remove(_cache.keys.first);
    return result;
  }

  Future<void> dispose() async {
    await _sub?.cancel();
    await _surface?.dispose();
    _surface = null;
    _ready = null;
  }
}

/// A ```mermaid / ```chart / ```svg block: the picture, with zoom, copy and save.
/// While the reply is still streaming (the source keeps changing) the code shows.
class RichBlock extends StatefulWidget {
  const RichBlock({super.key, required this.kind, required this.source});

  final String kind;
  final String source;

  @override
  State<RichBlock> createState() => _RichBlockState();
}

class _RichBlockState extends State<RichBlock> {
  RichResult? _result;
  String? _error;
  String? _drawn;
  Timer? _settle;
  var _width = 680.0;

  String get _label => switch (widget.kind) {
    'mermaid' => 'Mermaid 图',
    'chart' => '图表',
    _ => 'SVG',
  };

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _schedule();
  }

  @override
  void didUpdateWidget(RichBlock old) {
    super.didUpdateWidget(old);
    if (old.source != widget.source) _schedule();
  }

  /// Draws once the source has stopped changing for a moment.
  void _schedule() {
    _settle?.cancel();
    _settle = Timer(const Duration(milliseconds: 500), _draw);
  }

  Future<void> _draw() async {
    if (!mounted) return;
    final vars = themeVarsOf(context);
    final dark = Theme.of(context).brightness == Brightness.dark;
    final key = '${widget.source}|$dark|${vars.hashCode}';
    if (key == _drawn) return;
    _drawn = key;
    try {
      final result = await RichRenderer.instance.render(widget.kind, widget.source, css: themeCssOf(vars), dark: dark, width: _width);
      if (!mounted) return;
      setState(() {
        _result = result;
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = e.toString().replaceFirst('Bad state: ', ''));
    }
  }

  @override
  void dispose() {
    _settle?.cancel();
    super.dispose();
  }

  Future<void> _save() async {
    final result = _result;
    if (result == null) return;
    final svg = result.svg;
    final location = await getSaveLocation(
      suggestedName: widget.kind == 'chart' ? '图表.png' : '图.${svg != null ? 'svg' : 'png'}',
      acceptedTypeGroups: [
        if (svg != null) const XTypeGroup(label: 'SVG', extensions: ['svg']),
        const XTypeGroup(label: 'PNG', extensions: ['png']),
      ],
    );
    if (location == null) return;
    final path = location.path;
    if (path.toLowerCase().endsWith('.svg') && svg != null) {
      await File(path).writeAsString(svg);
    } else {
      await File(path.toLowerCase().endsWith('.png') ? path : '$path.png').writeAsBytes(result.png);
    }
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('已保存到 $path')));
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final result = _result;
    if (_error != null && result == null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          CodeBlock(code: widget.source, language: widget.kind),
          Padding(padding: const EdgeInsets.only(top: 4), child: Text('没能画出$_label：$_error', style: context.text.bodySmall?.copyWith(color: colors.warning))),
        ],
      );
    }
    if (result == null) return CodeBlock(code: widget.source, language: widget.kind);
    return LayoutBuilder(
      builder: (context, constraints) {
        if ((constraints.maxWidth - _width).abs() > 40 && constraints.maxWidth.isFinite) {
          _width = constraints.maxWidth;
        }
        final shown = result.width.clamp(0, constraints.maxWidth).toDouble();
        return Container(
          decoration: BoxDecoration(color: colors.card, border: Border.all(color: colors.border), borderRadius: BorderRadius.circular(context.radius)),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 2, 2, 0),
                child: Row(
                  children: [
                    Text(_label, style: context.label),
                    const Spacer(),
                    _ToolButton(icon: Icons.zoom_out_map, tooltip: '放大', onPressed: () => _zoom(context, result)),
                    _ToolButton(
                      icon: Icons.image_outlined,
                      tooltip: '复制图片',
                      onPressed: () async {
                        await Pasteboard.writeImage(result.png);
                        if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已复制图片'), duration: Duration(seconds: 1)));
                      },
                    ),
                    _ToolButton(
                      icon: Icons.code,
                      tooltip: '复制源代码',
                      onPressed: () {
                        Clipboard.setData(ClipboardData(text: widget.source));
                        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已复制源代码'), duration: Duration(seconds: 1)));
                      },
                    ),
                    _ToolButton(icon: Icons.save_alt, tooltip: '另存为…', onPressed: _save),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(8, 0, 8, 10),
                child: Center(
                  child: GestureDetector(
                    onTap: () => _zoom(context, result),
                    child: MouseRegion(
                      cursor: SystemMouseCursors.zoomIn,
                      child: Image.memory(result.png, width: shown, fit: BoxFit.contain, filterQuality: FilterQuality.medium, gaplessPlayback: true),
                    ),
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  void _zoom(BuildContext context, RichResult result) {
    showDialog<void>(
      context: context,
      builder: (context) => Dialog(
        insetPadding: const EdgeInsets.all(24),
        child: Stack(
          children: [
            InteractiveViewer(
              maxScale: 8,
              minScale: 0.5,
              boundaryMargin: const EdgeInsets.all(200),
              child: Center(child: Padding(padding: const EdgeInsets.all(24), child: Image.memory(result.png, filterQuality: FilterQuality.high))),
            ),
            Positioned(right: 4, top: 4, child: IconButton(onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close), tooltip: '关闭')),
          ],
        ),
      ),
    );
  }
}

class _ToolButton extends StatelessWidget {
  const _ToolButton({required this.icon, required this.tooltip, required this.onPressed});

  final IconData icon;
  final String tooltip;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => IconButton(tooltip: tooltip, iconSize: 15, visualDensity: VisualDensity.compact, onPressed: onPressed, icon: Icon(icon));
}
