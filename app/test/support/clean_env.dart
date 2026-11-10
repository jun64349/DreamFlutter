import 'dart:io';

/// The environment for a test core: the parent's, without model credentials or endpoints.
/// A developer shell (Claude Code sets ANTHROPIC_*) otherwise makes Pi pick a real provider,
/// and a scripted test talks to a real API instead of its fake model.
Map<String, String> testCoreEnvironment() => {
      for (final e in Platform.environment.entries)
        if (!RegExp(r'^(ANTHROPIC_|OPENAI_|GEMINI_|DEEPSEEK_)|(_API_KEY|_AUTH_TOKEN|_ACCESS_TOKEN|_SECRET|_BASE_URL)$', caseSensitive: false).hasMatch(e.key))
          e.key: e.value,
    };
