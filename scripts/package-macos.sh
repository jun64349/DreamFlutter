#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/dist/macos"
BETA=false
SKIP_BUILD=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --beta)
      BETA=true
      shift
      ;;
    --out-dir)
      OUT_DIR="$2"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "package-macos.sh must run on Apple Silicon (Darwin arm64)." >&2
  exit 1
fi

PUBSPEC_VERSION_LINE="$(grep -E '^version:' "$ROOT/app/pubspec.yaml" | head -n1 | sed -E 's/^version:[[:space:]]*//')"
VERSION="${PUBSPEC_VERSION_LINE%%+*}"
BUILD_NUMBER="${PUBSPEC_VERSION_LINE##*+}"
if [[ -z "$VERSION" || -z "$BUILD_NUMBER" ]]; then
  echo "Failed to parse version/build from app/pubspec.yaml" >&2
  exit 1
fi

echo "Packaging DreamFlutter $VERSION+$BUILD_NUMBER (beta=$BETA) for macOS arm64..."

if [[ "$SKIP_BUILD" != "true" ]]; then
  pushd "$ROOT/app" >/dev/null
  DART_DEFINES=(
    "--dart-define=DREAMFLUTTER_VERSION=$VERSION"
    "--dart-define=DREAMFLUTTER_BUILD=$BUILD_NUMBER"
  )
  if [[ "$BETA" == "true" ]]; then
    DART_DEFINES+=("--dart-define=DREAMFLUTTER_BETA=true")
  fi
  flutter build macos --release \
    --build-name="$VERSION" \
    --build-number="$BUILD_NUMBER" \
    "${DART_DEFINES[@]}"
  popd >/dev/null
fi

BUILT_APP="$ROOT/app/build/macos/Build/Products/Release/DreamFlutter.app"
if [[ ! -d "$BUILT_APP" ]]; then
  echo "Built .app not found at $BUILT_APP" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
APP_OUT="$OUT_DIR/DreamFlutter.app"
rm -rf "$APP_OUT"
ditto "$BUILT_APP" "$APP_OUT"

RESOURCES="$APP_OUT/Contents/Resources"
CORE_OUT="$RESOURCES/core"
mkdir -p "$CORE_OUT"

for item in src assets package.json; do
  cp -R "$ROOT/core/$item" "$CORE_OUT/$item"
done
if [[ -f "$ROOT/core/bin/secret.mjs" ]]; then
  mkdir -p "$CORE_OUT/bin"
  cp "$ROOT/core/bin/secret.mjs" "$CORE_OUT/bin/secret.mjs"
fi

pushd "$CORE_OUT" >/dev/null
# Use npm install (not npm ci) so macOS optionalDependencies such as sherpa-onnx-darwin-arm64 install natively.
npm install --omit=dev --no-audit --no-fund
rm -rf node_modules/sherpa-onnx-win-x64 node_modules/.cache
if [[ ! -d "node_modules/sherpa-onnx-darwin-arm64" ]]; then
  echo "Expected node_modules/sherpa-onnx-darwin-arm64 to be installed." >&2
  exit 1
fi
popd >/dev/null

if [[ "$BETA" == "true" ]]; then
  printf '{"edition":"beta"}\n' > "$RESOURCES/beta-edition.json"
fi

node "$ROOT/scripts/prepare-bundled-runtime-macos.mjs" --target "$RESOURCES"

# Strip macOS metadata and Python bytecode caches before signing.
find "$RESOURCES" -name ".DS_Store" -delete || true
find "$RESOURCES" -type d -name "__pycache__" -prune -exec rm -rf {} + || true
rm -f "$RESOURCES/core/bin/voice/model.int8.onnx"

chmod +x "$RESOURCES/runtime/bin/node" "$RESOURCES/core/bin/uv" "$RESOURCES/core/bin/uvx" "$RESOURCES/core/bin/rg" "$RESOURCES/core/bin/fd"
find "$RESOURCES/core/python" -maxdepth 3 -path "*/bin/python*" -exec chmod +x {} + || true

echo "Ad-hoc signing $APP_OUT (inside-out)..."
xattr -cr "$APP_OUT"
# 1. Sign all Mach-O binaries, shared libs, and native addons inside Contents/Resources
while IFS= read -r -d '' f; do
  if file -b "$f" | grep -q "Mach-O"; then
    codesign --force --sign - "$f"
  fi
done < <(find "$RESOURCES" -type f \( -name "*.dylib" -o -name "*.so" -o -name "*.node" -o -perm +111 \) -print0)
# 2. Sign frameworks and dylibs inside Contents/Frameworks
if [[ -d "$APP_OUT/Contents/Frameworks" ]]; then
  while IFS= read -r -d '' f; do
    codesign --force --sign - "$f"
  done < <(find "$APP_OUT/Contents/Frameworks" -maxdepth 2 \( -name "*.dylib" -o -name "*.framework" \) -print0)
fi
# 3. Sign main .app bundle with entitlements
codesign --force \
  --entitlements "$ROOT/app/macos/Runner/Release.entitlements" \
  --sign - "$APP_OUT"
codesign --verify --deep --strict --verbose=2 "$APP_OUT"

SUFFIX=""
if [[ "$BETA" == "true" ]]; then
  SUFFIX="-beta"
fi
DMG_NAME="DreamFlutter-${VERSION}${SUFFIX}-arm64.dmg"
DMG_PATH="$OUT_DIR/$DMG_NAME"
DMG_STAGE="$(mktemp -d)"
trap 'rm -rf "$DMG_STAGE"' EXIT

ditto "$APP_OUT" "$DMG_STAGE/DreamFlutter.app"
ln -s /Applications "$DMG_STAGE/Applications"

rm -f "$DMG_PATH"
hdiutil create -volname "DreamFlutter" -srcfolder "$DMG_STAGE" -ov -format UDZO "$DMG_PATH"

pushd "$OUT_DIR" >/dev/null
shasum -a 256 "$DMG_NAME" > SHA256SUMS
cat SHA256SUMS
popd >/dev/null

echo "Created $DMG_PATH"
