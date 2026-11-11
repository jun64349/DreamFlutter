import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:highlight/highlight.dart' show highlight, Node;
import 'package:markdown/markdown.dart' as md;
import 'package:path/path.dart' as p;
import 'package:url_launcher/url_launcher.dart';

import '../theme.dart';
import 'rich_blocks.dart';

/// A reply's Markdown in the reading style: Song body text with generous
/// leading, serif headings, ruled tables, and code blocks with highlighting
/// and a copy button.
///
/// 0.8.3 (user test: a 400 token/s model writing ten thousand characters left the window behind and
/// stuttering): the text is drawn block by block. A block that is finished keeps its built widgets, so
/// each update parses and lays out only the block still being written, not the whole reply again.
class ReplyMarkdown extends StatelessWidget {
  const ReplyMarkdown({super.key, required this.text});

  final String text;

  /// The gap between blocks: MarkdownBody's own blockSpacing.
  static const blockGap = 10.0;

  @override
  Widget build(BuildContext context) {
    final blocks = markdownBlocks(text);
    if (blocks.length <= 1) return _MarkdownBlock(text: text);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final (i, block) in blocks.indexed)
          Padding(
            padding: EdgeInsets.only(top: i == 0 ? 0 : blockGap),
            child: _MarkdownBlock(key: ValueKey(i), text: block),
          ),
      ],
    );
  }
}

/// Splits Markdown into top-level blocks at blank lines, so each can be drawn on its own. It never
/// splits inside a fenced code block or a `$$` formula, and never before an indented line (a list
/// item's next paragraph, indented code), which belongs to the block above. A blank line at the very
/// end (the next block not written yet) does not split either.
List<String> markdownBlocks(String text) {
  final lines = text.split('\n');
  final blocks = <String>[];
  final current = <String>[];
  String? fence;
  var formula = false;
  void flush() {
    if (current.any((l) => l.trim().isNotEmpty)) blocks.add(current.join('\n'));
    current.clear();
  }

  for (var i = 0; i < lines.length; i++) {
    final line = lines[i];
    final trimmed = line.trimLeft();
    if (fence != null) {
      current.add(line);
      if (trimmed.startsWith(fence) && trimmed.substring(fence.length).trim().isEmpty) fence = null;
      continue;
    }
    final opening = RegExp(r'^(`{3,}|~{3,})').firstMatch(trimmed);
    if (opening != null) {
      fence = opening.group(1);
      current.add(line);
      continue;
    }
    if (r'$$'.allMatches(line).length.isOdd) formula = !formula;
    if (line.trim().isEmpty && !formula) {
      var next = '';
      for (var j = i + 1; j < lines.length; j++) {
        if (lines[j].trim().isNotEmpty) { next = lines[j]; break; }
      }
      if (next.isNotEmpty && !next.startsWith(' ') && !next.startsWith('\t')) {
        flush();
        continue;
      }
    }
    current.add(line);
  }
  flush();
  return blocks;
}

/// One block of a reply. It keeps what it built until its text or the theme changes: handing Flutter
/// the same widget again skips the subtree, so a finished paragraph costs nothing while the reply grows.
class _MarkdownBlock extends StatefulWidget {
  const _MarkdownBlock({super.key, required this.text});

  final String text;

  @override
  State<_MarkdownBlock> createState() => _MarkdownBlockState();
}

class _MarkdownBlockState extends State<_MarkdownBlock> {
  Widget? _built;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _built = null;
  }

  @override
  void didUpdateWidget(_MarkdownBlock old) {
    super.didUpdateWidget(old);
    if (old.text != widget.text) _built = null;
  }

  @override
  Widget build(BuildContext context) => _built ??= _replyMarkdownBody(context, widget.text);
}

Widget _replyMarkdownBody(BuildContext context, String text) {
    final colors = context.colors;
    final body = context.serif(context.text.bodyLarge).copyWith(fontSize: 15, height: 1.85, color: colors.ink);
    TextStyle heading(double size) => context.serif(body).copyWith(fontSize: size, fontWeight: FontWeight.w600, height: 1.5);
    final mono = TextStyle(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback, fontSize: 13);
    final sans = context.text.bodyMedium?.copyWith(fontSize: 13, height: 1.6, color: colors.ink);
    return MarkdownBody(
      data: text,
      selectable: false,
      inlineSyntaxes: mathSyntaxes,
      builders: {'code': _CodeBuilder(FileLinks.maybeOf(context)), 'math': _MathBuilder(body)},
      // Images in a reply load from the web only: never local files or network shares.
      imageBuilder: (uri, title, alt) => uri.scheme == 'http' || uri.scheme == 'https'
          ? Image.network(uri.toString(), errorBuilder: (_, _, _) => Text(alt ?? uri.toString(), style: body.copyWith(color: colors.muted)))
          : Text(alt ?? uri.toString(), style: body.copyWith(color: colors.muted)),
      styleSheet: MarkdownStyleSheet(
        p: body,
        a: body.copyWith(color: colors.accent, decoration: TextDecoration.underline, decorationColor: colors.accent.withValues(alpha: 0.4)),
        h1: heading(21),
        h2: heading(18),
        h3: heading(16.5),
        h4: heading(15.5),
        h5: heading(15),
        h6: heading(15),
        h1Padding: const EdgeInsets.only(top: 10, bottom: 2),
        h2Padding: const EdgeInsets.only(top: 8, bottom: 2),
        h3Padding: const EdgeInsets.only(top: 6),
        em: body.copyWith(fontStyle: FontStyle.italic),
        strong: body.copyWith(fontWeight: FontWeight.w700),
        del: body.copyWith(decoration: TextDecoration.lineThrough),
        listBullet: body,
        listIndent: 22,
        blockSpacing: 10,
        // No background: a paragraph paints its selection first and its text on
        // top, so a background hid the selection over inline code (v0.3.1 test 3).
        // Said outright: the package merges its default code style, which has a
        // card-colored ground, and leaving ours unset kept it (v0.3.3 test).
        code: mono.copyWith(color: colors.ochre, fontSize: 13, backgroundColor: Colors.transparent),
        // Code blocks draw their own frame (_CodeBlock).
        codeblockPadding: EdgeInsets.zero,
        codeblockDecoration: const BoxDecoration(),
        blockquote: body.copyWith(color: colors.ink2),
        blockquotePadding: const EdgeInsets.only(left: 14, top: 2, bottom: 2),
        blockquoteDecoration: BoxDecoration(border: Border(left: BorderSide(color: colors.ochre.withValues(alpha: 0.5), width: 2))),
        horizontalRuleDecoration: BoxDecoration(border: Border(top: BorderSide(color: colors.border))),
        tableHead: sans?.copyWith(fontWeight: FontWeight.w600, color: colors.muted),
        tableBody: sans,
        tableBorder: TableBorder(horizontalInside: BorderSide(color: colors.border), bottom: BorderSide(color: colors.border), top: BorderSide(color: colors.border)),
        tableCellsPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        tableColumnWidth: const IntrinsicColumnWidth(),
        checkbox: body.copyWith(color: colors.accent),
      ),
      onTapLink: (text, href, title) {
        final uri = href == null ? null : Uri.tryParse(href);
        if (uri != null && (uri.scheme == 'http' || uri.scheme == 'https')) launchUrl(uri);
      },
    );
}

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

/// TeX in replies: `$$…$$` and `\[…\]` on their own line, `$…$` and
/// `\(…\)` inside the text. A single `$` needs no space just inside it and
/// no digit right after the closing one, so prices like "$5 和 $10" stay text.
final mathSyntaxes = <md.InlineSyntax>[
  _MathSyntax(r'\$\$([\s\S]+?)\$\$', display: true),
  _MathSyntax(r'\\\[([\s\S]+?)\\\]', display: true),
  _MathSyntax(r'\\\(([\s\S]+?)\\\)', display: false),
  _MathSyntax(r'\$(?![\s$])([^$\n]+?)(?<!\s)\$(?!\d)', display: false),
];

class _MathSyntax extends md.InlineSyntax {
  _MathSyntax(super.pattern, {required this.display}) : super(startCharacter: pattern.startsWith(r'\$') ? 0x24 : 0x5C);

  final bool display;

  @override
  bool onMatch(md.InlineParser parser, Match match) {
    final tex = match[1]!.trim();
    if (tex.isEmpty) return false;
    parser.addNode(md.Element.text('math', tex)..attributes['display'] = display ? 'true' : 'false');
    return true;
  }
}

class _MathBuilder extends MarkdownElementBuilder {
  _MathBuilder(this.body);

  final TextStyle body;

  @override
  Widget? visitElementAfterWithContext(BuildContext context, md.Element element, TextStyle? preferredStyle, TextStyle? parentStyle) {
    final tex = element.textContent;
    final display = element.attributes['display'] == 'true';
    final style = body.copyWith(fontSize: display ? 16 : 15);
    final math = Math.tex(
      tex,
      mathStyle: display ? MathStyle.display : MathStyle.text,
      textStyle: style,
      // A formula it cannot read is shown as written.
      onErrorFallback: (_) => Text(display ? '\$\$$tex\$\$' : '\$$tex\$', style: style.copyWith(fontFamily: AppTokens.monoFamily, fontSize: 13)),
    );
    if (!display) return Text.rich(TextSpan(children: [WidgetSpan(alignment: PlaceholderAlignment.middle, child: math)]));
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 6),
      alignment: Alignment.center,
      child: SingleChildScrollView(scrollDirection: Axis.horizontal, child: math),
    );
  }
}

/// Files named in replies can be found: inline code that names an existing
/// file or folder (absolute, or relative to the conversation's workspace)
/// becomes a link. Click shows it in Explorer; right click opens it
/// (extra test 9). Without this scope, inline code is plain.
class FileLinks extends InheritedWidget {
  const FileLinks({super.key, required this.baseDir, required this.reveal, required this.open, required super.child});

  final String baseDir;
  final void Function(String path) reveal;
  final void Function(String path) open;

  static FileLinks? maybeOf(BuildContext context) => context.dependOnInheritedWidgetOfExactType<FileLinks>();

  static final _pathLike = RegExp(r'[\\/]|\.[A-Za-z0-9]{1,8}$');

  /// The existing file or folder [text] names, or null.
  String? resolve(String text) {
    var t = text.trim();
    if (t.length >= 2 && (t.startsWith('"') && t.endsWith('"') || t.startsWith("'") && t.endsWith("'"))) t = t.substring(1, t.length - 1);
    if (t.isEmpty || t.length > 400 || t.contains('\n') || !_pathLike.hasMatch(t) || t.contains('://')) return null;
    // Network shares and device paths (\\server\share, \\?\, //host) are never touched while
    // rendering: a reply naming one would make Windows connect (and sign in) to that server.
    if (RegExp(r'^[\\/]{2}').hasMatch(t)) return null;
    final full = p.isAbsolute(t) ? t : p.join(baseDir, t);
    if (RegExp(r'^[\\/]{2}').hasMatch(full)) return null;
    try {
      return FileSystemEntity.typeSync(full) == FileSystemEntityType.notFound ? null : p.normalize(full);
    } catch (_) {
      return null;
    }
  }

  @override
  bool updateShouldNotify(FileLinks oldWidget) => baseDir != oldWidget.baseDir;
}

/// Block code (fenced, or ending in a newline) becomes a [CodeBlock];
/// inline code that names a file becomes a [FileLinks] link, other inline
/// code keeps the default rendering.
class _CodeBuilder extends MarkdownElementBuilder {
  _CodeBuilder(this.links);

  final FileLinks? links;

  @override
  Widget? visitElementAfterWithContext(BuildContext context, md.Element element, TextStyle? preferredStyle, TextStyle? parentStyle) {
    final text = element.textContent;
    final className = element.attributes['class'] ?? '';
    final isBlock = className.startsWith('language-') || text.contains('\n');
    if (!isBlock) {
      final path = links?.resolve(text);
      if (path == null) return null;
      final folder = FileSystemEntity.isDirectorySync(path);
      // Inside the sentence, not a widget of its own: a separate widget broke the
      // line after the link and stood outside the paragraph's selection (v0.3.3 test).
      // The placeholder is left alone when the paragraph's spans are merged.
      return Text.rich(
        WidgetSpan(
          alignment: PlaceholderAlignment.baseline,
          baseline: TextBaseline.alphabetic,
          child: FileLink(
            text: text,
            style: preferredStyle ?? const TextStyle(),
            onTap: () => folder ? links!.open(path) : links!.reveal(path),
            onSecondaryTap: () => links!.open(path),
          ),
        ),
      );
    }
    final language = className.startsWith('language-') ? className.substring('language-'.length) : null;
    final source = text.endsWith('\n') ? text.substring(0, text.length - 1) : text;
    if (language != null && richLanguages.contains(language.toLowerCase())) return RichBlock(kind: language.toLowerCase(), source: source);
    return CodeBlock(code: source, language: language);
  }
}

/// A file named in a reply: accent text with an underline; under the mouse it
/// gets a light ground, which says it can be clicked without any note (v0.3.3
/// test). The ground is a box behind the text, not a text background, so a
/// selection still shows over it.
class FileLink extends StatefulWidget {
  const FileLink({super.key, required this.text, required this.style, required this.onTap, required this.onSecondaryTap});

  final String text;
  final TextStyle style;
  final VoidCallback onTap;
  final VoidCallback onSecondaryTap;

  @override
  State<FileLink> createState() => _FileLinkState();
}

class _FileLinkState extends State<FileLink> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        onTap: widget.onTap,
        onSecondaryTap: widget.onSecondaryTap,
        child: AnimatedContainer(
          duration: AppTokens.motion(context, AppTokens.fast), curve: AppTokens.curve,
          decoration: BoxDecoration(
            color: _hover ? colors.accent.withValues(alpha: 0.12) : colors.accent.withValues(alpha: 0),
            borderRadius: BorderRadius.circular(3),
          ),
          child: Text(
            widget.text,
            style: widget.style.copyWith(
              color: colors.accent,
              decoration: TextDecoration.underline,
              decorationColor: colors.accent.withValues(alpha: _hover ? 0.9 : 0.4),
            ),
          ),
        ),
      ),
    );
  }
}

/// A code block: language label and copy button above highlighted code.
class CodeBlock extends StatelessWidget {
  const CodeBlock({super.key, required this.code, this.language});

  final String code;
  final String? language;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final mono = TextStyle(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback, fontSize: 12.5, height: 1.55, color: colors.ink);
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: colors.codeBackground,
        border: Border.all(color: colors.border),
        borderRadius: BorderRadius.circular(context.radius),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 2, 2, 0),
            child: Row(
              children: [
                Text(language?.isNotEmpty == true ? language! : '代码', style: context.label),
                const Spacer(),
                IconButton(
                  tooltip: '复制代码',
                  iconSize: 14,
                  visualDensity: VisualDensity.compact,
                  onPressed: () {
                    Clipboard.setData(ClipboardData(text: code));
                    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已复制代码'), duration: Duration(seconds: 1)));
                  },
                  icon: const Icon(Icons.copy_outlined),
                ),
              ],
            ),
          ),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
            child: Text.rich(TextSpan(style: mono, children: highlightCode(code, language, colors))),
          ),
        ],
      ),
    );
  }
}

/// Colored spans for [code] in [language] (auto-detected when unknown or
/// unsupported; plain text if that fails).
List<TextSpan> highlightCode(String code, String? language, AppColors colors) {
  List<Node>? parse({String? language}) {
    try {
      return language != null ? highlight.parse(code, language: language).nodes : highlight.parse(code, autoDetection: true).nodes;
    } catch (_) {
      return null; // unknown language
    }
  }

  final nodes = (language == null ? null : parse(language: language.toLowerCase())) ?? (code.length < 20000 ? parse() : null);
  if (nodes == null) return [TextSpan(text: code)];
  final styles = <String, TextStyle>{
    'keyword': TextStyle(color: colors.accent, fontWeight: FontWeight.w600),
    'built_in': TextStyle(color: colors.accent),
    'type': TextStyle(color: colors.accent),
    'literal': TextStyle(color: colors.ochre),
    'number': TextStyle(color: colors.ochre),
    'string': TextStyle(color: colors.ochre),
    'regexp': TextStyle(color: colors.ochre),
    'symbol': TextStyle(color: colors.ochre),
    'comment': TextStyle(color: colors.muted, fontStyle: FontStyle.italic),
    'quote': TextStyle(color: colors.muted, fontStyle: FontStyle.italic),
    'meta': TextStyle(color: colors.muted),
    'title': TextStyle(color: colors.ink, fontWeight: FontWeight.w600),
    'function': TextStyle(color: colors.ink),
    'attr': TextStyle(color: colors.seal),
    'attribute': TextStyle(color: colors.seal),
    'variable': TextStyle(color: colors.seal),
    'template-variable': TextStyle(color: colors.seal),
    'tag': TextStyle(color: colors.accent),
    'name': TextStyle(color: colors.accent),
    'selector-tag': TextStyle(color: colors.accent),
    'params': TextStyle(color: colors.ink2),
    'addition': TextStyle(color: colors.accent, backgroundColor: colors.diffAdded),
    'deletion': TextStyle(color: colors.danger, backgroundColor: colors.diffRemoved),
  };
  List<TextSpan> convert(List<Node> nodes) => [
    for (final node in nodes)
      if (node.value != null)
        TextSpan(text: node.value, style: styles[node.className])
      else
        TextSpan(style: styles[node.className], children: convert(node.children ?? const [])),
  ];
  return convert(nodes);
}
