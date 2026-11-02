import 'package:dreamflutter/ui/context_dialog.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_rpc/pi_rpc.dart';

void main() {
  test('the cache hit rate counts cached input against all input (extra test 10)', () {
    const none = SessionStats(totalTokens: 0, cost: 0, contextTokens: 0, contextWindow: 0, contextPercent: 0);
    expect(cacheHitRate(none), isNull);
    // The deep-test session: 257.1k input not from the cache, 5.5M from it.
    const session = SessionStats(totalTokens: 0, cost: 0, contextTokens: 0, contextWindow: 0, contextPercent: 0, inputTokens: 257100, cacheReadTokens: 5500000);
    expect(cacheHitRate(session), closeTo(0.955, 0.001));
  });
}
