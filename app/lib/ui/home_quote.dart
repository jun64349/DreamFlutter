import 'dart:math';

import 'package:flutter/material.dart';

import '../theme.dart';
import 'home_quote_data.dart';
import 'shell_widgets.dart';

export 'home_quote_data.dart'
    show HomeQuoteContent, chineseHomeQuotes, foreignHomeQuotes;

/// Painting provenance decides the language, independently of control geometry.
bool homeQuoteIsForeign(String themeId) => switch (themeId) {
  'caodie' ||
  'yuhua' ||
  'shensi' ||
  'qiandie' ||
  'youhua' ||
  'liuguang' ||
  'huandie' => true,
  _ => false,
};

class _QuoteBinding {
  _QuoteBinding(this.path, this.sessionId);
  String? path;
  String? sessionId;
  final byCulture = <bool, HomeQuoteContent>{};
}

/// A bag is exhausted before it is shuffled again; the first item in a new
/// bag cannot equal the last item in the old one. No timer is involved.
class HomeQuotePicker {
  HomeQuotePicker({Random? random}) : _random = random ?? Random();
  final Random _random;
  final _pending = Expando<_QuoteBinding>('home quote per runtime');
  final _saved = <String, _QuoteBinding>{};
  final _bags = <bool, List<int>>{};
  final _last = <bool, int>{};

  HomeQuoteContent pick({
    required Object sessionToken,
    String? sessionPath,
    String? sessionId,
    required bool foreign,
  }) {
    var binding = _pending[sessionToken];
    // Starting another unsaved conversation can reuse the same runtime.
    if (sessionPath == null &&
        binding != null &&
        (binding.path != null ||
            (sessionId != null &&
                binding.sessionId != null &&
                binding.sessionId != sessionId))) {
      binding = _QuoteBinding(null, sessionId);
      _pending[sessionToken] = binding;
    }
    if (sessionPath != null && binding?.path != sessionPath) {
      final saved = _saved[sessionPath];
      if (saved != null) {
        binding = saved;
      } else if (binding?.path != null) {
        binding = _QuoteBinding(sessionPath, sessionId);
      } else {
        binding ??= _QuoteBinding(sessionPath, sessionId);
      }
      binding.path = sessionPath;
      binding.sessionId = sessionId;
      _pending[sessionToken] = binding;
      _saved[sessionPath] = binding;
      // A bounded in-memory hint for returning to a pristine conversation.
      if (_saved.length > 128) _saved.remove(_saved.keys.first);
    }
    binding ??= _QuoteBinding(sessionPath, sessionId);
    binding.sessionId ??= sessionId;
    _pending[sessionToken] = binding;
    return binding.byCulture.putIfAbsent(foreign, () => _draw(foreign));
  }

  HomeQuoteContent _draw(bool foreign) {
    final pool = foreign ? foreignHomeQuotes : chineseHomeQuotes;
    final bag = _bags.putIfAbsent(foreign, () => []);
    if (bag.isEmpty) {
      bag.addAll(List<int>.generate(pool.length, (i) => i)..shuffle(_random));
      final last = _last[foreign];
      if (last != null && bag.last == last) {
        final other = bag.indexWhere((index) => index != last);
        final firstDraw = bag.last;
        bag[bag.length - 1] = bag[other];
        bag[other] = firstDraw;
      }
    }
    final index = bag.removeLast();
    _last[foreign] = index;
    return pool[index];
  }
}

final _homeQuotePicker = HomeQuotePicker();
final _fallbackQuoteToken = Object();

class HomeQuote extends StatelessWidget {
  const HomeQuote({super.key, this.sessionToken, this.sessionPath, this.sessionId});
  final Object? sessionToken;
  final String? sessionPath;
  final String? sessionId;

  @override
  Widget build(BuildContext context) {
    final quote = _homeQuotePicker.pick(
      sessionToken: sessionToken ?? _fallbackQuoteToken,
      sessionPath: sessionPath,
      sessionId: sessionId,
      foreign: homeQuoteIsForeign(context.painting.id),
    );
    return ShellQuoteLine(
      quote.original,
      quote.source,
      translation: quote.translation,
      englishOriginal: quote.isForeign,
    );
  }
}
