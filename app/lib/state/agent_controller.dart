import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';

import 'preferences.dart';
import 'project_trust.dart';
import 'session_runtime.dart';

export 'project_trust.dart' show ProjectTrust, TrustChoice;
export 'session_runtime.dart' show ConfigResolver, ClientLauncher, ConnectionStatus, SessionRuntime;

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

/// Where the pieces Pi needs were found on this machine (settings page).
class RuntimeInfo {
  const RuntimeInfo({
    required this.cliPath,
    required this.nodePath,
    required this.bashDir,
    required this.piVersion,
    required this.extensionPath,
    required this.sessionsDir,
    required this.agentDir,
  });

  final String? cliPath;
  final String? nodePath;
  final String? bashDir;
  final String? piVersion;
  final String? extensionPath;
  final String sessionsDir;
  final String agentDir;
}

/// Manages the sessions of the current workspace. Each session that is
/// running (or recently used) has its own Pi process ([SessionRuntime]), so
/// switching away from a running session or starting a new one never
/// interrupts it.
///
/// Process reuse rules keep the process count low:
/// - New/open while the active session is idle: reuse its process in place.
/// - New/open while it is running: leave it running in the background and
///   start (or re-activate) another process.
/// - Background processes that have been idle for [idleGrace] are closed;
///   their sessions stay on disk and reopen on demand.
class AgentController extends ChangeNotifier {
  AgentController({
    required this.preferences,
    ConfigResolver? resolveConfig,
    ClientLauncher? launch,
    SessionStore? sessionStore,
    this.idleGrace = const Duration(minutes: 5),
    this.maxProcesses = 8,
    DateTime Function()? clock,
    ProjectTrust? projectTrust,
  }) : projectTrust = projectTrust ?? ProjectTrust(),
       _resolveConfig = resolveConfig ?? buildLaunchConfig,
       _launch = launch ?? PiRpcClient.launch,
       _clock = clock ?? DateTime.now,
       sessionStore = sessionStore ?? SessionStore();

  final Preferences preferences;
  final SessionStore sessionStore;
  final ProjectTrust projectTrust;

  /// Asks the user whether to trust a workspace's own Pi configuration. Set
  /// by the UI; without it Pi decides on its own (and skips untrusted config).
  Future<TrustChoice?> Function(String cwd)? trustPrompt;

  /// Trust arguments decided during this app run, per workspace.
  final Map<String, List<String>> _trustArgs = {};
  final ConfigResolver _resolveConfig;
  final ClientLauncher _launch;
  final DateTime Function() _clock;

  /// How long an idle background session keeps its process.
  final Duration idleGrace;

  /// Soft cap on live Pi processes; idle background ones are closed first.
  final int maxProcesses;

  final List<SessionRuntime> _runtimes = [];
  final Map<SessionRuntime, String> _backgroundSignature = {};
  final Set<String> _unseen = {};
  final _toasts = StreamController<String>.broadcast();
  final _emptyTranscript = Transcript();
  Timer? _reaper;
  var _disposed = false;

  SessionRuntime? _active;
  String workspace = '';
  List<SessionSummary> _diskSessions = const [];

  static List<String> get _searchRoots => [p.dirname(Platform.resolvedExecutable), Directory.current.path];

  /// The pinned `runtime/` folder, derived from the CLI path.
  static String? runtimeDir(String cliPath) {
    var dir = p.dirname(cliPath);
    for (var i = 0; i < 6; i++) {
      if (p.basename(dir) == 'node_modules') return p.dirname(dir);
      dir = p.dirname(dir);
    }
    return null;
  }

  static String? approvalExtensionPath(String cliPath) {
    final runtime = runtimeDir(cliPath);
    if (runtime == null) return null;
    final path = p.join(runtime, 'extensions', 'dreamflutter-approval.ts');
    return File(path).existsSync() ? path : null;
  }

  /// Launch config: pinned Pi, the approval extension, and the settings file
  /// it reads. [environment] entries are added on top (tests use this).
  static PiLaunchConfig? buildLaunchConfig(
    String workingDirectory,
    List<String> extraArgs, {
    Map<String, String> environment = const {},
  }) {
    final base = PiRuntimeLocator.defaultConfig(
      workingDirectory: workingDirectory,
      searchRoots: _searchRoots,
      extraArgs: extraArgs,
    );
    if (base == null) return null;
    final extension = approvalExtensionPath(base.cliPath);
    return PiLaunchConfig(
      cliPath: base.cliPath,
      nodeExecutable: base.nodeExecutable,
      workingDirectory: workingDirectory,
      extraArgs: [...extraArgs, if (extension != null) ...['--extension', extension]],
      environment: {...base.environment, 'DREAMFLUTTER_SETTINGS_FILE': Preferences.bridgeFile(), ...environment},
    );
  }

  RuntimeInfo runtimeInfo() {
    final cli = PiRuntimeLocator.findCli(_searchRoots);
    String? version;
    if (cli != null) {
      try {
        final pkg = File(p.join(p.dirname(cli), '..', '..', 'package.json')).readAsStringSync();
        version = RegExp(r'"version"\s*:\s*"([^"]+)"').firstMatch(pkg)?.group(1);
      } catch (_) {}
    }
    return RuntimeInfo(
      cliPath: cli,
      nodePath: PiRuntimeLocator.findOnPath('node'),
      bashDir: PiRuntimeLocator.findGitBashDir(),
      piVersion: version,
      extensionPath: cli == null ? null : approvalExtensionPath(cli),
      sessionsDir: sessionStore.sessionsDir,
      agentDir: SessionStore.defaultAgentDir(),
    );
  }

  /// Short user-facing messages (errors, extension notifications).
  Stream<String> get toasts => _toasts.stream;

  // --- The active session, as the chat view sees it -------------------------

  SessionRuntime? get active => _active;
  List<SessionRuntime> get runtimes => List.unmodifiable(_runtimes);
  Transcript get transcript => _active?.transcript ?? _emptyTranscript;
  ConnectionStatus get status => _active?.status ?? ConnectionStatus.starting;
  String get statusDetail => _active?.statusDetail ?? '';
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
  bool get autoCompactionEnabled => _active?.state?.autoCompactionEnabled ?? preferences.autoCompaction;

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
  ApprovalMode get approvalMode => preferences.approvalMode;

  /// Recently used workspaces plus folders that have sessions, most recent first.
  List<String> recentWorkspaces = const [];

  /// Number of sessions running in the background.
  int get backgroundRunning => _runtimes.where((r) => r != _active && r.isRunning).length;

  // --- Sidebar --------------------------------------------------------------

  /// Sessions of the current workspace: persisted ones merged with live ones
  /// (a live session may not have a file yet), newest first.
  List<SidebarEntry> get sidebar {
    final byPath = <String, SidebarEntry>{};
    String keyOf(String path) => Platform.isWindows ? p.normalize(path).toLowerCase() : p.normalize(path);

    for (final s in _diskSessions) {
      byPath[keyOf(s.path)] = SidebarEntry(
        isFork: s.parentSession != null,
        path: s.path,
        title: s.title,
        modifiedAt: s.modifiedAt,
        isActive: false,
        isRunning: false,
        hasUnseenResult: _unseen.contains(keyOf(s.path)),
        hasError: false,
      );
    }
    for (final runtime in _runtimes) {
      final path = runtime.sessionPath;
      if (path == null || !SessionStore.samePath(runtime.workspace, workspace)) continue;
      final isActive = runtime == _active;
      if (runtime.isPristine && !isActive) continue;
      final disk = byPath[keyOf(path)];
      final diskSummary = _diskSessions.where((s) => keyOf(s.path) == keyOf(path)).firstOrNull;
      byPath[keyOf(path)] = SidebarEntry(
        needsAttention: runtime.pendingDialogs.isNotEmpty,
        isFork: diskSummary?.parentSession != null,
        path: path,
        title: runtime.isPristine && disk != null ? disk.title : runtime.title,
        modifiedAt: disk == null || runtime.lastActivity.isAfter(disk.modifiedAt) ? runtime.lastActivity : disk.modifiedAt,
        isActive: isActive,
        isRunning: runtime.isRunning,
        hasUnseenResult: _unseen.contains(keyOf(path)),
        hasError: runtime.status == ConnectionStatus.crashed,
      );
    }
    return byPath.values.toList()..sort((a, b) => b.modifiedAt.compareTo(a.modifiedAt));
  }

  // --- Lifecycle -----------------------------------------------------------

  Future<void> init() async {
    workspace = preferences.workspace ?? Preferences.defaultWorkspace();
    _notify(); // show the workspace name while Pi starts (or a trust prompt waits)
    await Directory(workspace).create(recursive: true);
    await preferences.setWorkspace(workspace);
    await preferences.writeBridgeFile();
    _reaper = Timer.periodic(const Duration(seconds: 30), (_) => reapIdle());
    await _activate(await _spawn());
    unawaited(refreshSessions());
  }

  @override
  void dispose() {
    _disposed = true;
    _reaper?.cancel();
    for (final runtime in _runtimes) {
      runtime.dispose();
    }
    _runtimes.clear();
    _toasts.close();
    super.dispose();
  }

  /// Creates a runtime for [workspace] and starts its process.
  Future<SessionRuntime> _spawn({String? sessionPath, String? cwd}) async {
    reapIdle(makeRoomForOne: true);
    final dir = cwd ?? workspace;
    final trustArgs = _trustArgs[_key(dir)] ??= await projectTrust.launchArgs(dir, trustPrompt);
    final runtime = SessionRuntime(
      workspace: dir,
      launchArgs: trustArgs,
      preferences: preferences,
      resolveConfig: _resolveConfig,
      launch: _launch,
      onToast: _toast,
      onSettled: _onRuntimeSettled,
      onAttention: _onRuntimeAttention,
      clock: _clock,
    );
    runtime.addListener(() => _onRuntimeChanged(runtime));
    _runtimes.add(runtime);
    // Show the new session right away (with its startup spinner) instead of
    // leaving the previous one on screen while Pi starts.
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

  /// Closes idle background processes past [idleGrace]. With
  /// [makeRoomForOne], also closes the oldest idle ones when at the cap.
  @visibleForTesting
  void reapIdle({bool makeRoomForOne = false}) {
    final now = _clock();
    final idle = _runtimes.where((r) => r != _active && !r.isRunning).toList()
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

  void _close(SessionRuntime runtime) {
    _runtimes.remove(runtime);
    _backgroundSignature.remove(runtime);
    runtime.dispose();
    _notify();
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
  Future<void> restart() async => _active?.restart();
  Future<void> selectModel(PiModel model) async => _active?.selectModel(model);
  Future<void> selectThinkingLevel(String level) async => _active?.selectThinkingLevel(level);

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

  /// Moves a session file to the Recycle Bin, closing its process first.
  Future<void> deleteSession(String path) async {
    final live = _liveRuntimeFor(path);
    final wasActive = live != null && live == _active;
    if (live != null) {
      if (live.isRunning) await live.abort();
      _runtimes.remove(live);
      _backgroundSignature.remove(live);
      if (wasActive) _active = null;
      live.dispose();
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

  Future<void> setApprovalMode(ApprovalMode mode) async {
    await preferences.setApprovalMode(mode);
    _notify();
  }

  /// Default for new sessions; also applied to the active session.
  Future<void> setDefaultAutoCompaction(bool enabled) async {
    await preferences.setAutoCompaction(enabled);
    await _active?.setAutoCompaction(enabled);
    _notify();
  }

  Future<void> setDefaultModel(PiModel model) async {
    await preferences.setModelKey(model.key);
    _notify();
  }

  Future<void> setDefaultThinkingLevel(String level) async {
    await preferences.setThinkingLevel(level);
    _notify();
  }

  /// Restarts idle sessions so they pick up changed Pi configuration (models,
  /// credentials, extensions). Running sessions are left alone.
  Future<void> reloadIdleSessions() async {
    for (final runtime in List.of(_runtimes)) {
      if (runtime.isRunning) continue;
      if (runtime == _active) {
        await runtime.restart();
      } else {
        _close(runtime);
      }
    }
    _toast('已重新加载 Pi 配置。');
    _notify();
  }

  void _toast(String message) {
    if (!_toasts.isClosed) _toasts.add(message);
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  static String _key(String path) => Platform.isWindows ? p.normalize(path).toLowerCase() : p.normalize(path);
}
