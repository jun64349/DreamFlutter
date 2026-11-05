import 'package:pi_rpc/pi_rpc.dart';

import 'session_runtime.dart';

/// A side conversation (0.4, roadmap 4.7): questions about a passage of the
/// conversation, asked in a copy of the session that lives only in memory. It
/// sees everything said so far, and neither interrupts nor adds to the main
/// line; its answer can be brought back to the main input box.
class SideChat {
  SideChat({required this.quote, required this.runtime, required this.sourcePath});

  /// The passage it is about.
  final String quote;

  /// Its own session in the core (incognito, forked from [sourcePath]).
  final SessionRuntime runtime;
  final String sourcePath;

  /// How many transcript items were the main conversation's when it opened;
  /// null while it is still opening.
  int? baseline;

  var _asked = false;

  bool get isReady => baseline != null && runtime.isReady;

  /// What was said in the side conversation (not the history it was forked with).
  List<TranscriptItem> get items {
    final start = baseline;
    if (start == null) return const [];
    return runtime.transcript.items.skip(start).toList();
  }

  /// The latest answer's text, to bring back.
  String? get lastAnswer {
    for (final item in items.reversed) {
      if (item is AssistantItem) {
        final text = item.parts.whereType<TextPart>().map((p) => p.text).join('\n').trim();
        if (text.isNotEmpty) return text;
      }
    }
    return null;
  }

  /// The first question carries the passage, quoted.
  static const lead = '关于主对话里的这段内容：';

  Future<void> ask(String question) async {
    final text = _asked ? question : '$lead\n${quoteLines(quote)}\n\n$question';
    _asked = true;
    await runtime.send(text);
  }

  /// [text] as a Markdown quote.
  static String quoteLines(String text) => text.trim().split('\n').map((l) => '> $l').join('\n');
}
