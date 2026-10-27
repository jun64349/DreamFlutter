import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

import 'backend.dart';
import 'preferences.dart';
import 'session_runtime.dart';

export 'backend.dart' show AgentBackend, CoreBackend;
export 'session_runtime.dart' show ClientLauncher, ConnectionStatus, SessionRuntime;

/// One row in the session sidebar: a persisted session, a live one, or both.
class SidebarEntry {
  const SidebarEntry({
    required this.path,
    required this.title,
    required this.modifiedAt,
    required this.isActive,
    required this.isRunning,
    required this.hasUnseenResult,
    required this.hasError,
    this.needsAttention = false,
    this.isFork = false,
  });

  final String path;
  final String title;
  final DateTime modifiedAt;
  final bool isActive;
  final bool isRunning;

  /// A background run finished and the user has not looked at it yet.
  final bool hasUnseenResult;
  final bool hasError;

  /// An extension (e.g. tool approval) is waiting for the user's answer.
  final bool needsAttention;

  /// Created by forking or cloning another session.
  final bool isFork;
}

/// A run the previous core process left unfinished (shown as a resume card).
class InterruptedRun {
  const InterruptedRun({required this.id, required this.sessionFile, required this.cwd, required this.prompt, required this.startedAt});

  factory InterruptedRun.fromJson(Json json) => InterruptedRun(
    id: json['id'] as String? ?? '',
    sessionFile: json['sessionFile'] as String?,
    cwd: json['cwd'] as String? ?? '',
    prompt: json['prompt'] as String?,
    startedAt: DateTime.fromMillisecondsSinceEpoch((json['startedAt'] as num?)?.toInt() ?? 0),
  );

  final String id;
  final String? sessionFile;
  final String cwd;
  final String? prompt;
  final DateTime startedAt;
}

/// Manages the sessions shown in this window. Sessions live in the core (a
/// background service), so a running session keeps going when the user
/// switches away, starts another one, or closes the window.
///
/// Reuse rules keep the number of live sessions low:
/// - New/open while the active session is idle: reuse it in place.
/// - New/open while it is running: leave it running in the background and
///   open (or re-activate) another one.
/// - Background sessions idle for [idleGrace] are let go of; the core closes
///   them later, their files stay on disk and reopen on demand.
class AgentController extends ChangeNotifier {
  AgentController({
    required this.preferences,
    AgentBackend? backend,
    SessionStore? sessionStore,
    this.idleGrace = const Duration(minutes: 5),
    this.maxProcesses = 8,
    DateTime Function()? clock,
  }) : backend = backend ?? CoreBackend(),
       _clock = clock ?? DateTime.now,
       sessionStore = sessionStore ?? SessionStore();

  final Preferences preferences;
  final SessionStore sessionStore;
  final AgentBackend backend;
  final DateTime Function() _clock;

  /// How long an idle background session stays attached.
  final Duration idleGrace;

  /// Soft cap on attached sessions; idle background ones are let go first.
  final int maxProcesses;

  final List<SessionRuntime> _runtimes = [];
  final Map<SessionRuntime, String> _backgroundSignature = {};
  final Set<String> _unseen = {};
  final _toasts = StreamController<String>.broadcast();
  final _emptyTranscript = Transcript();
  StreamSubscription<Json>? _backendEvents;
  Timer? _reaper;
  var _disposed = false;
  var _reconnecting = false;

  SessionRuntime? _active;
  String workspace = '';
  List<SessionSummary> _diskSessions = const [];

  /// Last `core.hello` (version, pid, data dir...), for the settings page.
  Json coreInfo = const {};

  /// Agent settings owned by the core (approval mode, default model...).
  Json coreSettings = const {};

  /// Why the core is unreachable (null when connected).
  String? backendProblem;

  /// Runs a previous core process left unfinished.
  List<InterruptedRun> interruptedRuns = const [];

  /// Short user-facing messages (errors, extension notifications).
  Stream<String> get toasts => _toasts.stream;

  // --- The active session, as the chat view sees it -------------------------

  SessionRuntime? get active => _active;
  List<SessionRuntime> get runtimes => List.unmodifiable(_runtimes);
  Transcript get transcript => _active?.transcript ?? _emptyTranscript;
  ConnectionStatus get status => backendProblem != null && _active == null
      ? ConnectionStatus.missingRuntime
      : _active?.status ?? ConnectionStatus.starting;
  String get statusDetail => _active?.statusDetail ?? backendProblem ?? '';
  bool get isReady => _active?.isReady ?? false;
  bool get isRunning => _active?.isRunning ?? false;
  PiModel? get model => _active?.model;
  String get thinkingLevel => _active?.thinkingLevel ?? 'off';
  List<PiModel> get models => _active?.models ?? const [];
  List<String> get thinkingLevels => _active?.thinkingLevels ?? const [];
  SessionStats get stats => _active?.stats ?? SessionStats.empty;
  String? get currentSessionPath => _active?.sessionPath;
  String get sessionTitle => _active?.title ?? '新会话';
  List<SlashCommand> get commands => _active?.commands ?? const [];
  bool get isCompacting => (_active?.isCompacting ?? false) || transcript.isCompacting;
  bool get autoCompactionEnabled => _active?.state?.autoCompactionEnabled ?? defaultAutoCompaction;

  /// The oldest extension dialog of the active session awaiting an answer.
  ExtensionUiRequest? get pendingDialog => _active?.pendingDialogs.firstOrNull;
  Map<String, String> get extensionStatuses => _active?.extensionStatuses ?? const {};
  Map<String, List<String>> get extensionWidgets => _active?.extensionWidgets ?? const {};

  // --- Settings and workspaces ----------------------------------------------

  /// Theme and text size, separate from the main notifier so streaming
  /// updates do not rebuild the whole app.
  late final appearance = ValueNotifier<(ThemeMode, double)>((preferences.themeMode, preferences.textScale));

  ThemeMode get themeMode => preferences.themeMode;
  double get textScale => preferences.textScale;
  ApprovalMode get approvalMode => ApprovalMode.parse(coreSettings['approvalMode'] as String?);
  bool get defaultAutoCompaction => coreSettings['autoCompaction'] != false;
  String? get defaultModelKey => coreSettings['defaultModel'] as String?;
  String? get defaultThinkingLevel => coreSettings['defaultThinking'] as String?;

  /// Recently used workspaces plus folders that have sessions, most recent first.
  List<String> recentWorkspaces = const [];

  /// Number of sessions running in the background.
  int get backgroundRunning => _runtimes.where((r) => r != _active && r.isRunning).length;

  // --- Sidebar --------------------------------------------------------------

  /// Sessions of the current workspace: persisted ones merged with live ones
  /// (a live session may not have a file yet), newest first.
  List<SidebarEntry> get sidebar {
    final byPath = <String, SidebarEntry>{};

    for (final s in _diskSessions) {
      byPath[_key(s.path)] = SidebarEntry(
        isFork: s.parentSession != null,
        path: s.path,
        title: s.title,
        modifiedAt: s.modifiedAt,
        isActive: false,
        isRunning: false,
        hasUnseenResult: _unseen.contains(_key(s.path)),
        hasError: false,
      );
    }
    for (final runtime in _runtimes) {
      final path = runtime.sessionPath;
      if (path == null || !SessionStore.samePath(runtime.workspace, workspace)) continue;
      final isActive = runtime == _active;
      if (runtime.isPristine && !isActive) continue;
      final disk = byPath[_key(path)];
      final diskSummary = _diskSessions.where((s) => _key(s.path) == _key(path)).firstOrNull;
      byPath[_key(path)] = SidebarEntry(
        needsAttention: runtime.pendingDialogs.isNotEmpty,
        isFork: diskSummary?.parentSession != null,
        path: path,
        title: runtime.isPristine && disk != null ? disk.title : runtime.title,
        modifiedAt: disk == null || runtime.lastActivity.isAfter(disk.modifiedAt) ? runtime.lastActivity : disk.modifiedAt,
        isActive: isActive,
        isRunning: runtime.isRunning,
        hasUnseenResult: _unseen.contains(_key(path)),
        hasError: runtime.status == ConnectionStatus.crashed,
      );
    }
    return byPath.values.toList()..sort((a, b) => b.modifiedAt.compareTo(a.modifiedAt));
  }

  // --- Lifecycle -----------------------------------------------------------

  Future<void> init() async {
    workspace = preferences.workspace ?? Preferences.defaultWorkspace();
    _notify(); // show the workspace name while the core starts
    await Directory(workspace).create(recursive: true);
    await preferences.setWorkspace(workspace);
    _backendEvents = backend.events.listen(_onBackendEvent);
    _reaper = Timer.periodic(const Duration(seconds: 30), (_) => reapIdle());
    final hello = await _connect();
    if (hello == null) return;
    await _attachLiveSlots(hello);
    final blank = _runtimes.where((r) => r.isPristine && SessionStore.samePath(r.workspace, workspace)).firstOrNull;
    await _activate(blank ?? await _spawn());
    unawaited(refreshSessions());
  }

  /// Connects to the core; on failure records why and returns null.
  Future<Json?> _connect() async {
    try {
      final hello = await backend.connect();
      backendProblem = null;
      _applyHello(hello);
      await _migratePreferences();
      unawaited(backend.disconnected.then((_) => _onBackendLost()));
      _notify();
      return hello;
    } catch (e) {
      backendProblem = '无法启动后台服务：${SessionRuntime.describeError(e)}';
      _notify();
      return null;
    }
  }

  void _applyHello(Json hello) {
    coreInfo = hello;
    coreSettings = asJsonMap(hello['settings']);
    interruptedRuns = [
      for (final run in (hello['interruptedRuns'] as List? ?? const []))
        if (run is Map) InterruptedRun.fromJson(run.cast<String, dynamic>()),
    ];
  }

  /// Settings that used to live in the window move to the core once.
  Future<void> _migratePreferences() async {
    if (preferences.migratedToCore) return;
    try {
      await updateCoreSettings({
        'approvalMode': preferences.approvalMode.id,
        'autoCompaction': preferences.autoCompaction,
        'defaultModel': preferences.modelKey,
        'defaultThinking': ?preferences.thinkingLevel,
      });
      await preferences.setMigratedToCore();
    } catch (_) {}
  }

  /// Sessions still open in the core from before this window started (they
  /// kept running while no window was open).
  Future<void> _attachLiveSlots(Json hello) async {
    for (final slot in (hello['slots'] as List? ?? const []).whereType<Map>()) {
      final info = slot.cast<String, dynamic>();
      final slotId = info['slotId'] as String?;
      final cwd = info['cwd'] as String?;
      if (slotId == null || cwd == null || info['unattended'] == true) continue;
      if (_runtimes.any((r) => r.slotId == slotId)) continue;
      final runtime = _newRuntime(cwd);
      await runtime.start(attachSlotId: slotId);
      if (runtime.status != ConnectionStatus.ready) _close(runtime);
    }
  }

  Future<void> _onBackendLost() async {
    if (_disposed || _reconnecting) return;
    _reconnecting = true;
    backendProblem = '与后台的连接断开了，正在重新连接…';
    _notify();
    for (var attempt = 1; !_disposed; attempt++) {
      final hello = await _connect();
      if (hello != null) {
        // A new core has none of the old sessions: reopen them from disk.
        for (final runtime in List.of(_runtimes)) {
          if (runtime.status == ConnectionStatus.crashed || !runtime.isReady) await runtime.restart();
        }
        await _attachLiveSlots(hello);
        break;
      }
      await Future<void>.delayed(Duration(seconds: attempt.clamp(1, 10)));
    }
    _reconnecting = false;
    _notify();
  }

  void _onBackendEvent(Json message) {
    switch (message['event']) {
      case 'settings.changed':
        coreSettings = asJsonMap(message['settings']);
        _notify();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _reaper?.cancel();
    _backendEvents?.cancel();
    for (final runtime in _runtimes) {
      runtime.dispose();
    }
    _runtimes.clear();
    _toasts.close();
    super.dispose();
  }

  SessionRuntime _newRuntime(String cwd) {
    final runtime = SessionRuntime(
      workspace: cwd,
      launch: backend.launch,
      onToast: _toast,
      onSettled: _onRuntimeSettled,
      onAttention: _onRuntimeAttention,
      onModelChosen: (model) => unawaited(updateCoreSettings({'defaultModel': model.key}).catchError((_) {})),
      onThinkingChosen: (level) => unawaited(updateCoreSettings({'defaultThinking': level}).catchError((_) {})),
      clock: _clock,
    );
    runtime.addListener(() => _onRuntimeChanged(runtime));
    _runtimes.add(runtime);
    return runtime;
  }

  /// Opens a session for [cwd] (default: the workspace) in the core.
  Future<SessionRuntime> _spawn({String? sessionPath, String? cwd}) async {
    reapIdle(makeRoomForOne: true);
    final runtime = _newRuntime(cwd ?? workspace);
    // Show the new session right away (with its startup spinner) instead of
    // leaving the previous one on screen while it opens.
    _active = runtime;
    final starting = runtime.start(sessionPath: sessionPath);
    _notify();
    await starting;
    return runtime;
  }

  Future<void> _activate(SessionRuntime runtime) async {
    _active = runtime;
    final path = runtime.sessionPath;
    if (path != null) _unseen.remove(_key(path));
    _notify();
  }

  void _onRuntimeChanged(SessionRuntime runtime) {
    if (runtime == _active) {
      _notify();
      return;
    }
    // Background sessions only matter to the sidebar: notify when their
    // visible state changes, not on every streamed token.
    final signature =
        '${runtime.isRunning}|${runtime.status}|${runtime.title}|${runtime.sessionPath}|${runtime.pendingDialogs.length}';
    if (_backgroundSignature[runtime] != signature) {
      _backgroundSignature[runtime] = signature;
      _notify();
    }
  }

  void _onRuntimeAttention(SessionRuntime runtime, ExtensionUiRequest request) {
    if (runtime != _active) _toast('后台会话「${runtime.title}」在等你确认，点左侧带提醒标记的会话查看。');
    _notify();
  }

  void _onRuntimeSettled(SessionRuntime runtime) {
    final path = runtime.sessionPath;
    if (runtime != _active && path != null) _unseen.add(_key(path));
    unawaited(refreshSessions());
  }

  /// Lets go of idle background sessions past [idleGrace]. With
  /// [makeRoomForOne], also the oldest idle ones when at the cap.
  @visibleForTesting
  void reapIdle({bool makeRoomForOne = false}) {
    final now = _clock();
    final idle = _runtimes.where((r) => r != _active && !r.isRunning && r.pendingDialogs.isEmpty).toList()
      ..sort((a, b) => a.lastActivity.compareTo(b.lastActivity));
    var live = _runtimes.length;
    for (final runtime in idle) {
      final expired = now.difference(runtime.lastActivity) >= idleGrace;
      final overCap = makeRoomForOne && live >= maxProcesses;
      if (!expired && !overCap) continue;
      _close(runtime);
      live--;
    }
  }

  /// Stops showing [runtime]. The session stays in the core until it is idle
  /// long enough for the core to close it.
  void _close(SessionRuntime runtime) {
    _runtimes.remove(runtime);
    _backgroundSignature.remove(runtime);
    runtime.dispose();
    _notify();
  }

  /// Closes the session in the core as well (delete, reload configuration).
  Future<void> _closeInCore(SessionRuntime runtime) async {
    final slotId = runtime.slotId;
    _close(runtime);
    if (slotId == null) return;
    try {
      await backend.call('slot.close', {'slotId': slotId});
    } catch (_) {}
  }

  SessionRuntime? _liveRuntimeFor(String path) =>
      _runtimes.where((r) => r.sessionPath != null && SessionStore.samePath(r.sessionPath!, path)).firstOrNull;

  // --- Actions -------------------------------------------------------------

  /// Starts a new session. A running session keeps running in the background.
  Future<void> newSession() async {
    final current = _active;
    if (current != null && current.isPristine && current.isReady) return; // already on a blank session
    final idleOther = _runtimes.where((r) => r != current && r.isPristine && r.isReady && SessionStore.samePath(r.workspace, workspace)).firstOrNull;
    if (idleOther != null) return _activate(idleOther);
    if (current != null && current.isReady && !current.isRunning && SessionStore.samePath(current.workspace, workspace)) {
      await current.newSessionInPlace();
      _notify();
      return;
    }
    final runtime = await _spawn();
    await _activate(runtime);
  }

  /// Opens a session from the sidebar. Running sessions are never interrupted.
  Future<void> openSession(String path) async {
    final current = _active;
    if (current?.sessionPath != null && SessionStore.samePath(current!.sessionPath!, path)) return;

    final live = _liveRuntimeFor(path);
    if (live != null) return _activate(live);

    final summary = _diskSessions.where((s) => SessionStore.samePath(s.path, path)).firstOrNull;
    final cwd = summary?.cwd ?? workspace;
    if (current != null && current.isReady && !current.isRunning && SessionStore.samePath(current.workspace, cwd)) {
      if (await current.switchInPlace(path)) _unseen.remove(_key(path));
      _notify();
      return;
    }
    final runtime = await _spawn(sessionPath: path, cwd: cwd);
    await _activate(runtime);
  }

  Future<void> setWorkspace(String directory) async {
    if (SessionStore.samePath(directory, workspace)) return;
    workspace = directory;
    await preferences.setWorkspace(directory);
    _diskSessions = const [];
    final blank = _runtimes.where((r) => r.isPristine && r.isReady && SessionStore.samePath(r.workspace, directory)).firstOrNull;
    await _activate(blank ?? await _spawn());
    await refreshSessions();
  }

  Future<void> send(String text, {List<ImageBlock> images = const []}) async => _active?.send(text, images: images);
  Future<void> abort() async => _active?.abort();
  Future<void> selectModel(PiModel model) async => _active?.selectModel(model);
  Future<void> selectThinkingLevel(String level) async => _active?.selectThinkingLevel(level);

  /// Reconnects to the core if needed and reopens the active session.
  Future<void> restart() async {
    if (!backend.isConnected) {
      final hello = await _connect();
      if (hello == null) return;
    }
    final active = _active;
    if (active == null) {
      await _activate(await _spawn());
    } else {
      await active.restart();
    }
  }

  Future<void> refreshSessions() async {
    try {
      _diskSessions = await sessionStore.list(cwd: workspace);
    } catch (_) {
      _diskSessions = const [];
    }
    try {
      final seen = <String>{};
      recentWorkspaces = [
        for (final w in [...preferences.recentWorkspaces, ...await sessionStore.workspaces()])
          if (seen.add(_key(w)) && Directory(w).existsSync()) w,
      ].take(Preferences.maxRecentWorkspaces).toList();
    } catch (_) {}
    _notify();
  }

  Future<void> forgetWorkspace(String directory) async {
    await preferences.removeRecentWorkspace(directory);
    await refreshSessions();
  }

  /// Opens a folder in Windows Explorer.
  Future<void> revealInExplorer(String path) async {
    try {
      await Process.start(Platform.isWindows ? 'explorer' : 'xdg-open', [path]);
    } catch (e) {
      _toast('无法打开文件夹：$e');
    }
  }

  // --- Interrupted runs ------------------------------------------------------

  /// Reopens the session of an interrupted run and asks the agent to go on.
  Future<void> resumeInterrupted(InterruptedRun run) async {
    await dismissInterrupted(run);
    final file = run.sessionFile;
    if (file == null || !File(file).existsSync()) {
      _toast('这个任务的会话文件已经不在了。');
      return;
    }
    if (!SessionStore.samePath(run.cwd, workspace) && Directory(run.cwd).existsSync()) await setWorkspace(run.cwd);
    await openSession(file);
    await _active?.send('上次运行被中断了（后台重启或电脑关机）。请检查已经完成到哪一步，然后继续完成剩下的部分。');
  }

  Future<void> dismissInterrupted(InterruptedRun run) async {
    interruptedRuns = interruptedRuns.where((r) => r.id != run.id).toList();
    _notify();
    try {
      await backend.call('runs.acknowledge', {'id': run.id});
    } catch (_) {}
  }

  // --- Extension dialogs ----------------------------------------------------

  void answerDialog(ExtensionUiRequest request, {String? value, bool? confirmed, bool cancelled = false}) {
    for (final runtime in _runtimes) {
      if (runtime.pendingDialogs.contains(request)) {
        runtime.answerDialog(request, value: value, confirmed: confirmed, cancelled: cancelled);
      }
    }
  }

  /// Puts [text] into the input box of the active session.
  void insertIntoComposer(String text) {
    final runtime = _active;
    if (runtime == null) return;
    runtime.editorText = text;
    runtime.editorTextRevision++;
    _notify();
  }

  // --- Context ---------------------------------------------------------------

  Future<CompactionResult?> compact({String? instructions}) async => _active?.compact(instructions: instructions);

  Future<void> setSessionAutoCompaction(bool enabled) async => _active?.setAutoCompaction(enabled);

  // --- Session management -----------------------------------------------------

  Future<void> forkFrom(UserItem message) async {
    final runtime = _active;
    if (runtime == null) return;
    if (runtime.isRunning) {
      _toast('当前回复还没结束，先停止它再分叉。');
      return;
    }
    if (await runtime.forkFrom(message)) await refreshSessions();
  }

  /// Duplicates the session at [path] (opening it first if needed).
  Future<void> cloneSession(String path) async {
    await openSession(path);
    final runtime = _active;
    if (runtime == null || runtime.isRunning) {
      _toast('会话正在运行，等它结束后再复制。');
      return;
    }
    if (await runtime.cloneSession()) await refreshSessions();
  }

  /// Renames the session at [path] (opening it first if needed).
  Future<void> renameSession(String path, String name) async {
    var runtime = _liveRuntimeFor(path);
    if (runtime == null) {
      await openSession(path);
      runtime = _active;
    }
    if (runtime == null) return;
    await runtime.rename(name);
    await refreshSessions();
  }

  /// Moves a session file to the Recycle Bin, closing it in the core first.
  Future<void> deleteSession(String path) async {
    final live = _liveRuntimeFor(path);
    final wasActive = live != null && live == _active;
    if (live != null) {
      if (live.isRunning) await live.abort();
      if (wasActive) _active = null;
      await _closeInCore(live);
    }
    final deleted = await SessionStore.deleteSession(path);
    if (!deleted) _toast('删除失败：文件可能正被占用。');
    _unseen.remove(_key(path));
    if (wasActive || _active == null) {
      final blank = _runtimes.where((r) => r.isPristine && r.isReady && SessionStore.samePath(r.workspace, workspace)).firstOrNull;
      await _activate(blank ?? await _spawn());
    }
    await refreshSessions();
  }

  // --- Settings ----------------------------------------------------------------

  Future<void> updateCoreSettings(Json patch) async {
    final result = await backend.call('settings.update', patch);
    coreSettings = asJsonMap(result);
    _notify();
  }

  Future<void> setThemeMode(ThemeMode mode) async {
    await preferences.setThemeMode(mode);
    appearance.value = (mode, preferences.textScale);
    _notify();
  }

  Future<void> setTextScale(double scale) async {
    await preferences.setTextScale(scale);
    appearance.value = (preferences.themeMode, scale);
    _notify();
  }

  Future<void> setApprovalMode(ApprovalMode mode) => _setting({'approvalMode': mode.id});

  /// Default for new sessions; also applied to the active session.
  Future<void> setDefaultAutoCompaction(bool enabled) async {
    await _setting({'autoCompaction': enabled});
    await _active?.setAutoCompaction(enabled);
  }

  Future<void> setDefaultModel(PiModel model) => _setting({'defaultModel': model.key});

  Future<void> setDefaultThinkingLevel(String level) => _setting({'defaultThinking': level});

  Future<void> _setting(Json patch) async {
    try {
      await updateCoreSettings(patch);
    } catch (e) {
      _toast('保存设置失败：${SessionRuntime.describeError(e)}');
    }
  }

  /// Reopens idle sessions so they pick up changed Pi configuration (models,
  /// credentials, extensions). Running sessions are left alone.
  Future<void> reloadIdleSessions() async {
    for (final runtime in List.of(_runtimes)) {
      if (runtime.isRunning) continue;
      if (runtime == _active) {
        final slotId = runtime.slotId;
        if (slotId != null) {
          try {
            await backend.call('slot.close', {'slotId': slotId});
          } catch (_) {}
        }
        await runtime.restart();
      } else {
        await _closeInCore(runtime);
      }
    }
    _toast('已重新加载 Pi 配置。');
    _notify();
  }

  /// Stops the core (and every session in it). Used by "quit and stop background work".
  Future<void> shutdownCore() async {
    try {
      await backend.call('core.shutdown');
    } catch (_) {}
  }

  void _toast(String message) {
    if (!_toasts.isClosed) _toasts.add(message);
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  static String _key(String path) => Platform.isWindows ? p.normalize(path).toLowerCase() : p.normalize(path);
}
