/// Typed Dart client for Pi's RPC mode (`pi --mode rpc`).
///
/// - [PiRpcClient]: process lifecycle, command/response correlation, events.
/// - [Transcript]: folds the event stream into display-ready items.
/// - [SessionStore]: lists persisted sessions (RPC has no list command).
/// - [CoreClient] / [SlotConnection]: sessions hosted by the DreamFlutter core.
library;

export 'src/client.dart';
export 'src/core_client.dart';
export 'src/events.dart';
export 'src/json.dart' show Json;
export 'src/jsonl.dart';
export 'src/launcher.dart';
export 'src/messages.dart';
export 'src/models.dart';
export 'src/session_store.dart';
export 'src/slot_connection.dart';
export 'src/transcript.dart';
