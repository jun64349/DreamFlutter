# Builds a portable DreamFlutter folder for Windows x64:
#
#   dist\DreamFlutter-<version>\
#     app\        the window (Flutter release build + VC++ runtime DLLs)
#     core\       the background service (src, assets, production node_modules)
#     core\bin\   rg.exe, fd.exe for the search tools (core/src/agent/search-tools.ts); uv for the workbench
#     core\python\  portable Python for the workbench (core/scripts/fetch-toolchain.ts, core/src/agent/toolchain.ts)
#     core\bin\appcontainer-runner.exe  Windows isolated workspace launcher
#     core\bin\html-render.exe  fixed offline HTML screenshot tool
#     runtime\    node.exe (the window finds it: PiRuntimeLocator.findNode)
#     licenses\   Node.js, DSH and bundled tools
#
# Run from the repository root in PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\package-windows.ps1
#
# Start the result with app\dreamflutter.exe. Since v0.3.2 all data lives in its own
# data\ folder (next to app\ and core\), so the package and a development build
# keep separate data. The folder is not versioned: packaging again replaces
# everything in it except data\.

param(
    [string]$OutDir = "dist",
    [switch]$SkipBuild,
    [string]$FlutterRelease,
    # Accepted for compatibility with the 1.0 packaging commands.
    [switch]$NoSandboxImage,
    [switch]$UpdatePackage,
    [string]$PackageVersion,
    [string]$VelopackSdkDir,
    [string]$VelopackToolsDir,
    [string]$BundledCache,
    [string]$NodeRuntime = $env:DREAMFLUTTER_NODE,
    [switch]$FailStartupForTest,
    # 内测版（第 6 步朋友内测，用户 2026-11-19 定）：激活码一步、只走随想 GPT Pro、不检查更新、沙箱镜像随包。
    [switch]$Beta
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$candidates = if ($NodeRuntime) { @($NodeRuntime) } else { (Get-Command node.exe -All).Source }
$node = foreach ($candidate in $candidates) {
    $reported = & $candidate --version
    if ($LASTEXITCODE -ne 0 -or $reported -notmatch '^v(\d+\.\d+\.\d+)$') { continue }
    if ([version]$Matches[1] -lt [version]'24.9.0') { continue }
    if ((& $candidate -p process.arch) -eq 'x64') { (Resolve-Path -LiteralPath $candidate).Path; break }
}
if (-not $node) { throw 'The bundled DSH backend requires x64 Node.js >=24.9. Pass -NodeRuntime with its full path.' }
$npmCli = Join-Path (Split-Path -Parent (Get-Command npm.cmd -ErrorAction Stop).Source) 'node_modules/npm/bin/npm-cli.js'
& $node (Join-Path $PSScriptRoot 'verify-dsh-runtime.mjs') (Join-Path $root 'core')
if ($LASTEXITCODE -ne 0) { throw 'The source DSH runtime failed its compatibility check.' }
$version = ((Select-String -Path "$root\app\pubspec.yaml" -Pattern '^version:\s*([^+\s]+)').Matches[0].Groups[1].Value)
$buildNumber = ((Select-String -Path "$root\app\pubspec.yaml" -Pattern '^version:.*\+(\d+)').Matches | Select-Object -First 1).Groups[1].Value
if ($PackageVersion) { $version = $PackageVersion.TrimStart('v') }
if ($FlutterRelease -and -not $SkipBuild) { throw 'Pass -SkipBuild when providing a prebuilt -FlutterRelease.' }
if ($FailStartupForTest -and (-not $UpdatePackage -or $version -notmatch '^\d+\.\d+\.\d+-test\.\d+$')) { throw 'A deliberately failing build is permitted only for an explicit test update package.' }
if ($UpdatePackage) {
    if (-not (Test-Path -LiteralPath (Join-Path $VelopackSdkDir 'include/Velopack.hpp')) -or -not (Test-Path -LiteralPath (Join-Path $VelopackToolsDir 'dotnet/dotnet.exe'))) { throw 'Pass isolated -VelopackSdkDir and -VelopackToolsDir; no SDK is installed globally or shipped.' }
    $env:DREAMFLUTTER_VELOPACK_SDK = [IO.Path]::GetFullPath($VelopackSdkDir)
}
$outputRoot = if ([IO.Path]::IsPathRooted($OutDir)) { [IO.Path]::GetFullPath($OutDir) } else { [IO.Path]::GetFullPath((Join-Path $root $OutDir)) }
$target = [System.IO.Path]::GetFullPath((Join-Path $outputRoot 'DreamFlutter'))
# The cleanup below empties $target: never let it be the repository or a folder holding it.
if (($root.TrimEnd('\') + '\').StartsWith($target.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "The package folder $target would contain the repository; choose another -OutDir"
}
Write-Host "Packaging DreamFlutter $version -> $target"
if (-not $BundledCache) { $BundledCache = if ($env:DREAMFLUTTER_BUNDLE_CACHE) { $env:DREAMFLUTTER_BUNDLE_CACHE } else { Join-Path $root 'core/bin/.bundle-cache' } }
$BundledCache = [IO.Path]::GetFullPath($BundledCache)
$bundleCheck = @('--offline', '--verify-only', '--cache', $BundledCache)
& $node (Join-Path $PSScriptRoot 'prepare-bundled-runtime.mjs') @bundleCheck
if ($LASTEXITCODE -ne 0) { throw 'Bundled Windows runtime verification failed. Check the pinned asset cache before packaging.' }

# A new version replaces the program; the data\ folder (the user's data) is never touched.
if (Test-Path $target) {
    if (-not $target.StartsWith($outputRoot.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Package cleanup escaped the selected output directory' }
    Get-ChildItem -LiteralPath $target | Where-Object { $_.Name -ne "data" } | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
}

# 1. The window.
if (-not $SkipBuild) {
    Push-Location "$root\app"
    flutter build windows --release --no-pub "--build-name=$version" "--build-number=$buildNumber" "--dart-define=DREAMFLUTTER_VERSION=$version" "--dart-define=DREAMFLUTTER_BUILD=$buildNumber" $(if ($Beta) { "--dart-define=DREAMFLUTTER_BETA=true" })
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "flutter build failed" }
    Pop-Location
}
$release = if ($FlutterRelease) { (Resolve-Path -LiteralPath $FlutterRelease).Path } else { "$root\app\build\windows\x64\runner\Release" }
if (-not (Test-Path -LiteralPath (Join-Path $release 'dreamflutter.exe') -PathType Leaf)) { throw "Flutter Release executable missing: $release" }
New-Item -ItemType Directory -Force "$target\app" | Out-Null
Copy-Item "$release\*" "$target\app" -Recurse
# Machines without the VC++ redistributable still start the window.
foreach ($dll in "msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll", "msvcp140_atomic_wait.dll", "msvcp140_codecvt_ids.dll",
                 "vcruntime140.dll", "vcruntime140_1.dll", "vcruntime140_threads.dll", "concrt140.dll", "vccorlib140.dll") {
    $source = Join-Path $env:WINDIR "System32\$dll"
    if (Test-Path $source) { Copy-Item $source "$target\app" }
}

# 2. The background service, with production dependencies only.
New-Item -ItemType Directory -Force "$target\core" | Out-Null
foreach ($item in "src", "assets", "package.json", "package-lock.json") {
    Copy-Item "$root\core\$item" "$target\core" -Recurse
}
# Local test/bundler caches are not npm packages; npm prune does not remove them.
# Keep package assets, licenses and platform binaries intact.
robocopy "$root\core\node_modules" "$target\core\node_modules" /E /XJ /XD .vitest-cache .vite .cache /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "copying node_modules failed" }
Push-Location "$target\core"
& $node $npmCli prune --omit=dev --no-audit --no-fund --offline
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "npm prune failed" }
Pop-Location

# 3. Search tools: the copies Pi downloaded on this machine.
$piBin = Join-Path $env:USERPROFILE ".pi\agent\bin"
New-Item -ItemType Directory -Force "$target\core\bin" | Out-Null
foreach ($tool in "rg.exe", "fd.exe") {
    if (-not (Test-Path "$piBin\$tool")) { throw "$piBin\$tool is missing: run Pi once (it downloads rg and fd) or place the binary there." }
    Copy-Item "$piBin\$tool" "$target\core\bin"
}

# 3a. The workbench toolchain (roadmap 3.6): uv and a portable Python, from core/scripts/fetch-toolchain.ts.
foreach ($tool in "uv.exe", "uvx.exe", "uvw.exe") {
    if (-not (Test-Path "$root\core\bin\$tool")) { throw "core\bin\$tool is missing: run (cd core) node --disable-warning=ExperimentalWarning scripts\fetch-toolchain.ts" }
    Copy-Item "$root\core\bin\$tool" "$target\core\bin"
}
if (Test-Path -LiteralPath (Join-Path $root 'core/bin/secret.mjs')) { Copy-Item -LiteralPath (Join-Path $root 'core/bin/secret.mjs') -Destination (Join-Path $target 'core/bin/secret.mjs') }
$python = Get-ChildItem "$root\core\python" -Directory -Filter "cpython-*" | Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } | Select-Object -First 1
if (-not $python) { throw "core\python has no Python: run scripts\fetch-toolchain.ts" }
# /XJ: uv's version-alias junction would copy Python twice.
robocopy $python.FullName "$target\core\python\$($python.Name)" /E /XJ /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "copying Python failed" }
& $node (Join-Path $PSScriptRoot 'prepare-bundled-runtime.mjs') --offline --target $target --cache $BundledCache
if ($LASTEXITCODE -ne 0) { throw 'Installing pinned MinGit and Python office libraries failed' }
# 0.13.1 step 3 (user 2026-11-18): the SenseVoice model (228 MB) is downloaded on first local use
# (core/src/modules/voice/model.ts); tokens, VAD and the license still ship.
Remove-Item -LiteralPath "$target\core\bin\voice\model.int8.onnx" -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath "$target\core\bin\voice\model.int8.onnx") { throw 'The voice model must not ship in the package' }

& (Join-Path $root 'tools/appcontainer-runner/build.ps1') -OutputPath "$target\core\bin\appcontainer-runner.exe"
if (-not (Test-Path -LiteralPath "$target\core\bin\appcontainer-runner.exe")) { throw 'The Windows workspace launcher was not built.' }
& (Join-Path $root 'tools/appcontainer-html-render/build.ps1') -OutputPath "$target\core\bin\html-render.exe"
if ($Beta) {
    # core/src/paths.ts BETA_EDITION: no update checks or downloads.
    [IO.File]::WriteAllText((Join-Path $target 'beta-edition.json'), '{"edition":"beta"}')
}

# 4. Node.js.
New-Item -ItemType Directory -Force "$target\runtime", "$target\licenses" | Out-Null
Copy-Item $node "$target\runtime\node.exe"
$nodeLicense = Join-Path (Split-Path $node) "LICENSE"
if (Test-Path $nodeLicense) { Copy-Item $nodeLicense "$target\licenses\Node-LICENSE.txt" }
@"
ripgrep (rg.exe): https://github.com/BurntSushi/ripgrep, dual-licensed under the Unlicense and MIT.
fd (fd.exe): https://github.com/sharkdp/fd, dual-licensed under MIT and Apache-2.0.
uv (uv.exe, uvx.exe, uvw.exe): https://github.com/astral-sh/uv, dual-licensed under MIT and Apache-2.0.
Python (core\python\): CPython from python-build-standalone (https://github.com/astral-sh/python-build-standalone),
  Python Software Foundation License; its license text, with those of the libraries it bundles, is core\python\*\LICENSE.txt.
MinGit (core\bin\git\): pinned official Git for Windows; complete upstream license and component notices retained.
  Exact version, official asset SHA-256 and source URL: core\bundled-runtime.lock.json. GPL-2.0 and bundled component licenses.
Python office libraries: python-docx, openpyxl, python-pptx, pypdf, pandas and matplotlib, including pinned dependencies.
  Exact versions/hashes: core\office-windows.requirements.txt; individual license texts retained in Python dist-info directories.
WenQuanYi Micro Hei: bundled in Matplotlib for Chinese labels, Apache-2.0 option; font copyright and Apache text retained beside it.
desktop_drop (vendored in packages/desktop_drop): Apache-2.0, MixinNetwork/flutter-plugins.
"@ | Set-Content -Encoding utf8 "$target\licenses\THIRD-PARTY.txt"

@"
DreamFlutter $version（Windows x64 免安装版）

启动：双击 app\dreamflutter.exe。
已包含本地 DSH 后台、Node.js、蝶君的 Windows 隔离运行器、搜索工具、MinGit 和便携 Python 办公库。
所有数据都在这个文件夹下的 data\ 里（会话、记忆、模型配置、技能、设置、蝶君的沙箱），整个文件夹拷走就带走了数据。
升级：先从托盘「退出并停止后台」，再用新版本的文件覆盖这里（data\ 不要删）。
"@ | Set-Content -Encoding utf8 "$target\使用说明.txt"

Write-Host "Done: $target"
[IO.File]::WriteAllText((Join-Path $target 'build-info.json'), (@{version=$version;build=[string]$buildNumber;platform='win32';arch='x64';signed=$false;failStartup=[bool]$FailStartupForTest} | ConvertTo-Json))
if (Test-Path -LiteralPath (Join-Path $root 'docs/releases')) { New-Item -ItemType Directory -Force -Path (Join-Path $target 'docs') | Out-Null; Copy-Item -LiteralPath (Join-Path $root 'docs/releases') -Destination (Join-Path $target 'docs/releases') -Recurse -Force }
$flutterSdk = Split-Path -Parent (Split-Path -Parent (Get-Command flutter).Source)
& $node --disable-warning=ExperimentalWarning (Join-Path $PSScriptRoot 'generate-third-party.mjs') $target $root $flutterSdk --offline --cache $BundledCache
if ($LASTEXITCODE -ne 0) { throw 'Generating the third-party license manifest failed' }
# Only audited production-only artifacts: retain runtime modules, source maps,
# Pi self-help resources, all licenses/diagnostics and every bundled runtime/image.
& $node (Join-Path $PSScriptRoot 'package-trim.mjs') $target (Join-Path $outputRoot 'packaging-trim.json') --apply
if ($LASTEXITCODE -ne 0) { throw 'Audited package trimming failed' }
& "$target\runtime\node.exe" (Join-Path $PSScriptRoot 'verify-dsh-runtime.mjs') (Join-Path $target 'core')
if ($LASTEXITCODE -ne 0) { throw 'The bundled DSH runtime failed its compatibility check.' }
& "$target\runtime\node.exe" (Join-Path $PSScriptRoot 'verify-dsh-workbench.mjs') (Join-Path $target 'core')
if ($LASTEXITCODE -ne 0) { throw 'The packaged workbench failed its offline session restart check.' }
if ($UpdatePackage) {
    @"
DreamFlutter $version（Windows x64 可更新免安装版，测试版未签名）
从解压后的根目录 DreamFlutter.exe 启动；current 是可替换的程序目录，数据位于根目录 data，不在 current 内。
已包含本地 DSH 后台、Node.js、蝶君的 Windows 隔离运行器、搜索工具、MinGit 和便携 Python 办公库。本机语音模型在第一次用语音输入时下载。通过设置的“关于”检查、下载、校验并确认安装。
安装前等待现有任务结束并自动备份，启动验证失败时由 Velopack 回到旧程序，并用更新前备份恢复数据。
新版本已经接受用户写入后，不再自动恢复旧备份。请保留更新记录与诊断，按提示处理。
安装版请运行 DreamFlutter-Installer.exe：先选安装位置（默认 %LOCALAPPDATA%\DreamFlutter），数据位置在第一次启动的向导里选；也可以直接用免安装版。
"@ | Set-Content -LiteralPath (Join-Path $target '使用说明.txt') -Encoding utf8
    $env:DOTNET_CLI_HOME = Join-Path $VelopackToolsDir 'dotnet-home'
    $env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
    $env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
    $releases = Join-Path $outputRoot 'Velopack'
    foreach ($hookFile in @('runtime/node.exe', 'app/velopack_libc.dll', 'core/src/uninstall/hook.ts')) {
        if (-not (Test-Path -LiteralPath (Join-Path $target $hookFile) -PathType Leaf)) {
            throw "Velopack uninstall hook payload missing: $hookFile"
        }
    }
    & (Join-Path $VelopackToolsDir 'dotnet/dotnet.exe') (Join-Path $VelopackToolsDir 'vpk/tools/net8.0/any/vpk.dll') pack --packId DreamFlutter --packVersion $version --channel win-x64 --runtime win-x64 --packDir $target --mainExe 'app/dreamflutter.exe' --delta None --splashImage (Join-Path $root 'tools/installer/splash.png') --icon (Join-Path $root 'app/windows/runner/resources/app_icon.ico') --outputDir $releases
    if ($LASTEXITCODE -ne 0) { throw 'Velopack packaging failed' }
    # 0.13.1 step 3 (user 2026-11-18): the installer people download asks where to install first,
    # then runs Velopack's Setup.exe --installto (tools/installer).
    $velopackSetup = Join-Path $releases 'DreamFlutter-win-x64-Setup.exe'
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'tools\installer\build.ps1') -Setup $velopackSetup -Out (Join-Path $releases 'DreamFlutter-Installer.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Building the installer front failed' }
    Write-Host "Update package and self-updating portable output: $releases"
}
# Robocopy uses 1 for a successful copy; do not leak that as the script's exit code.
exit 0
