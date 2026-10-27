/// Small helpers for reading loosely-typed JSON from Pi without throwing on
/// unexpected shapes. Pi evolves quickly, so parsing is tolerant by design:
/// missing or mistyped fields fall back to defaults instead of crashing.
library;

typedef Json = Map<String, dynamic>;

Json asJson(Object? value) => value is Map ? value.cast<String, dynamic>() : const {};

List<Json> asJsonList(Object? value) =>
    value is List ? value.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList() : const [];

String? asString(Object? value) => value is String ? value : null;

int asInt(Object? value, [int fallback = 0]) => value is num ? value.toInt() : fallback;

double asDouble(Object? value, [double fallback = 0]) => value is num ? value.toDouble() : fallback;

bool asBool(Object? value, [bool fallback = false]) => value is bool ? value : fallback;

List<String> asStringList(Object? value) => value is List ? value.whereType<String>().toList() : const [];
