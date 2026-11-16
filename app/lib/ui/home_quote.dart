import 'package:flutter/material.dart';

import '../theme.dart';
import 'shell_widgets.dart';

/// The quotation follows the painting's cultural source, not its widget shape.
/// Keep one line per culture so rebuilding or changing the day cannot rotate it.
/// Text checked against:
/// https://zh.wikisource.org/zh-hans/庄子/逍遥游
/// https://www.folger.edu/explore/shakespeares-works/the-tempest/read/
class HomeQuoteContent {
  const HomeQuoteContent(this.original, this.source, {this.translation});

  final String original;
  final String source;
  final String? translation;

  bool get isForeign => translation != null;

  static const chinese = HomeQuoteContent(
    '至人无己，神人无功，圣人无名。',
    '《庄子·逍遥游》',
  );

  static const foreign = HomeQuoteContent(
    'We are such stuff as dreams are made on.',
    '莎士比亚《暴风雨》第四幕第一场',
    translation: '我们也是梦织成的。',
  );

  static HomeQuoteContent forTheme(String id) => switch (id) {
    'warmPaper' || 'twilight' || 'jiadie' || 'moye' || 'shiqing' => chinese,
    'caodie' || 'yuhua' || 'shensi' || 'qiandie' || 'youhua' || 'liuguang' || 'huandie' => foreign,
    _ => chinese,
  };
}

class HomeQuote extends StatelessWidget {
  const HomeQuote({super.key});

  @override
  Widget build(BuildContext context) {
    final quote = HomeQuoteContent.forTheme(context.painting.id);
    return ShellQuoteLine(
      quote.original,
      quote.source,
      translation: quote.translation,
      englishOriginal: quote.isForeign,
    );
  }
}
