import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:highlight/highlight.dart' show highlight, Node;
import 'package:markdown/markdown.dart' as md;
import 'package:url_launcher/url_launcher.dart';

import '../theme.dart';

/// A reply's Markdown in the reading style: Song body text with generous
/// leading, serif headings, ruled tables, and code blocks with highlighting
/// and a copy button.
class ReplyMarkdown extends StatelessWidget {
  const ReplyMarkdown({super.key, required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final body = context.serif(context.text.bodyLarge).copyWith(fontSize: 15, height: 1.85, color: colors.ink);
    TextStyle heading(double size) => context.serif(body).copyWith(fontSize: size, fontWeight: FontWeight.w600, height: 1.5);
    final mono = TextStyle(fontFamily: AppTokens.monoFamily, fontFamilyFallback: AppTokens.monoFallback, fontSize: 13);
    final sans = context.text.bodyMedium?.copyWith(fontSize: 13, height: 1.6, color: colors.ink);
    return MarkdownBody(
      data: text,
      selectable: false,
      builders: {'code': _CodeBuilder()},
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
        code: mono.copyWith(backgroundColor: colors.codeBackground, color: colors.ink, fontSize: 13),
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
}

/// Block code (fenced, or ending in a newline) becomes a [CodeBlock];
/// inline code keeps the default rendering.
class _CodeBuilder extends MarkdownElementBuilder {
  @override
  Widget? visitElementAfterWithContext(BuildContext context, md.Element element, TextStyle? preferredStyle, TextStyle? parentStyle) {
    final text = element.textContent;
    final className = element.attributes['class'] ?? '';
    final isBlock = className.startsWith('language-') || text.contains('\n');
    if (!isBlock) return null;
    final language = className.startsWith('language-') ? className.substring('language-'.length) : null;
    return CodeBlock(code: text.endsWith('\n') ? text.substring(0, text.length - 1) : text, language: language);
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
        borderRadius: BorderRadius.circular(AppTokens.radius),
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
