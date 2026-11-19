#!/usr/bin/env node
/**
 * Build-time helper for macOS arm64 packaging:
 * prepares Node.js, uv, rg, fd, portable Python 3.13 + Office libraries,
 * WenQuanYi Micro Hei Matplotlib font, and Sherpa-ONNX small files (omitting the 228 MB model)
 * inside DreamFlutter.app/Contents/Resources.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const repository = resolve(import.meta.dirname, '..');
const bundledLockPath = join(repository, 'core/bundled-runtime.lock.json');
const voiceLockPath = join(repository, 'core/src/modules/voice/runtime.lock.json');

const MACOS_TOOLS = {
  uv: {
    file: 'uv-aarch64-apple-darwin.tar.gz',
    url: 'https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz',
    binaries: ['uv', 'uvx'],
  },
  rg: {
    file: 'ripgrep-14.1.1-aarch64-apple-darwin.tar.gz',
    url: 'https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-aarch64-apple-darwin.tar.gz',
    binaries: ['rg'],
  },
  fd: {
    file: 'fd-v10.2.0-aarch64-apple-darwin.tar.gz',
    url: 'https://github.com/sharkdp/fd/releases/download/v10.2.0/fd-v10.2.0-aarch64-apple-darwin.tar.gz',
    binaries: ['fd'],
  },
};

const OFFICE_PACKAGES = [
  'python-docx>=1.1.0,<2',
  'openpyxl>=3.1.2,<4',
  'python-pptx>=1.0.0,<2',
  'pypdf>=5.0.0,<8',
  'pandas>=2.2.0,<4',
  'matplotlib>=3.9.0,<4',
  'pillow>=11.0.0,<14',
  'xlsxwriter>=3.2.0,<4',
  'lxml>=5.3.0,<7',
];

function run(exe, args, options = {}) {
  return execFileSync(exe, args, { encoding: 'utf8', maxBuffer: 32e6, ...options });
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function downloadFile(url, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  run('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '3', url, '--output', dest]);
}

function ensureCached(entry, cacheDir) {
  mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, entry.file);
  if (existsSync(file)) {
    if (entry.sha256 && sha256(file) !== entry.sha256) {
      throw new Error(`Pinned SHA-256 mismatch in cache: ${entry.file}`);
    }
    return file;
  }
  downloadFile(entry.url, file);
  if (entry.sha256 && sha256(file) !== entry.sha256) {
    unlinkSync(file);
    throw new Error(`Downloaded SHA-256 mismatch: ${entry.file}`);
  }
  return file;
}

function findFileRecursive(root, filename) {
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, item.name);
    if (item.isDirectory()) {
      const hit = findFileRecursive(full, filename);
      if (hit) return hit;
    } else if (item.name === filename) {
      return full;
    }
  }
  return undefined;
}

function installMacTools(target, cacheDir, scratch) {
  const binDir = join(target, 'core', 'bin');
  mkdirSync(binDir, { recursive: true });
  for (const [key, spec] of Object.entries(MACOS_TOOLS)) {
    const archive = ensureCached(spec, cacheDir);
    const unpackDir = join(scratch, `tool-${key}`);
    mkdirSync(unpackDir, { recursive: true });
    run('tar', ['-xzf', archive, '-C', unpackDir]);
    for (const binName of spec.binaries) {
      const found = findFileRecursive(unpackDir, binName);
      if (!found) throw new Error(`Binary ${binName} not found in ${spec.file}`);
      const out = join(binDir, binName);
      copyFileSync(found, out);
      chmodSync(out, 0o755);
    }
  }
}

function installNodeRuntime(target, licensesDir) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error(`prepare-bundled-runtime-macos.mjs must run on darwin/arm64 (got ${process.platform}/${process.arch})`);
  }
  const nodeBin = process.execPath;
  const destDir = join(target, 'runtime', 'bin');
  mkdirSync(destDir, { recursive: true });
  const destNode = join(destDir, 'node');
  copyFileSync(nodeBin, destNode);
  chmodSync(destNode, 0o755);

  const licenseCandidate = join(dirname(dirname(nodeBin)), 'share', 'doc', 'node', 'LICENSE');
  const rootLicenseCandidate = join(dirname(dirname(nodeBin)), 'LICENSE');
  for (const src of [licenseCandidate, rootLicenseCandidate]) {
    if (existsSync(src)) {
      copyFileSync(src, join(licensesDir, 'Node-LICENSE.txt'));
      break;
    }
  }
}

function installPythonAndOffice(target, bundledLock, cacheDir, scratch) {
  const uv = join(target, 'core', 'bin', 'uv');
  const pythonDir = join(target, 'core', 'python');
  mkdirSync(pythonDir, { recursive: true });
  run(uv, ['python', 'install', '3.13', '--install-dir', pythonDir]);

  // Remove alias symlinks so codesign does not choke on dangling symlinks inside .app bundle;
  // keep real cpython-3.13.* directories only.
  for (const entry of readdirSync(pythonDir)) {
    const full = join(pythonDir, entry);
    if (lstatSync(full).isSymbolicLink()) unlinkSync(full);
  }
  const installs = readdirSync(pythonDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('cpython-'))
    .map((d) => d.name)
    .sort()
    .reverse();
  if (!installs.length) throw new Error('uv python install did not produce a cpython-* directory');
  const python3 = join(pythonDir, installs[0], 'bin', 'python3');
  if (!existsSync(python3)) throw new Error(`Missing python3 binary at ${python3}`);

  // Install Office stack directly into the bundled Python environment using uv pip install.
  run(uv, ['pip', 'install', '--system', '--break-system-packages', '--python', python3, '--no-cache', ...OFFICE_PACKAGES]);

  const mplData = run(python3, [
    '-I',
    '-B',
    '-c',
    "import matplotlib, os; print(os.path.join(os.path.dirname(matplotlib.__file__), 'mpl-data'))",
  ]).trim();

  // Bundle WenQuanYi Micro Hei Chinese font inside Matplotlib for readable charts without host fonts.
  const fontArchive = ensureCached(bundledLock.font, cacheDir);
  const fontScratch = join(scratch, 'font');
  mkdirSync(fontScratch, { recursive: true });
  run('ar', ['-x', fontArchive], { cwd: fontScratch });
  const dataTar = readdirSync(fontScratch).find((n) => n.startsWith('data.tar.'));
  if (!dataTar) throw new Error('Font .deb payload missing');
  run('tar', ['-xf', join(fontScratch, dataTar), '-C', fontScratch]);
  const ttfDir = join(mplData, 'fonts', 'ttf');
  mkdirSync(ttfDir, { recursive: true });
  copyFileSync(join(fontScratch, 'usr/share/fonts/truetype/wqy/wqy-microhei.ttc'), join(ttfDir, 'wqy-microhei.ttc'));
  const copyrightSrc = join(fontScratch, 'usr/share/doc/fonts-wqy-microhei/copyright');
  if (existsSync(copyrightSrc)) copyFileSync(copyrightSrc, join(ttfDir, 'wqy-microhei-COPYRIGHT.txt'));

  const apacheEntry = (bundledLock.licenses || []).find((e) => e.file.endsWith('LICENSE-APACHE.txt'));
  if (apacheEntry) {
    const apacheFile = ensureCached(apacheEntry, cacheDir);
    copyFileSync(apacheFile, join(ttfDir, 'wqy-microhei-Apache-2.0.txt'));
  }

  const rcPath = join(mplData, 'matplotlibrc');
  const original = readFileSync(rcPath, 'utf8').replace(/\n#{1,2} DreamFlutter bundled Chinese font[\s\S]*$/, '');
  const updated = original
    .replace(/^#?font\.sans-serif:.*$/m, 'font.sans-serif: WenQuanYi Micro Hei, DejaVu Sans')
    .replace(/^#?axes\.unicode_minus:.*$/m, 'axes.unicode_minus: False');
  writeFileSync(rcPath, `${updated}\n## DreamFlutter bundled Chinese font\n`, 'utf8');
}

function installVoiceSmallFiles(target, voiceLock, cacheDir, scratch) {
  const { senseVoice, sileroVad } = voiceLock;
  const senseArchive = ensureCached(senseVoice, cacheDir);
  const vadFile = ensureCached(sileroVad, cacheDir);
  const root = senseVoice.file.replace(/\.tar\.bz2$/, '');
  const voiceScratch = join(scratch, 'voice');
  mkdirSync(voiceScratch, { recursive: true });

  // Ship tokens, VAD, and LICENSE only; omit the 228 MB model.int8.onnx so first voice use downloads it.
  const extractFiles = ['tokens.txt', 'LICENSE'];
  run('tar', ['-xf', senseArchive, '-C', voiceScratch, ...extractFiles.map((f) => `${root}/${f}`)]);

  const voiceDest = join(target, 'core', 'bin', 'voice');
  mkdirSync(voiceDest, { recursive: true });
  for (const file of extractFiles) {
    copyFileSync(join(voiceScratch, root, file), join(voiceDest, file));
  }
  copyFileSync(vadFile, join(voiceDest, sileroVad.file));

  const largeModel = join(voiceDest, 'model.int8.onnx');
  if (existsSync(largeModel)) unlinkSync(largeModel);
  if (existsSync(largeModel)) throw new Error('model.int8.onnx must not be bundled in core/bin/voice');
}

function writeNotices(licensesDir) {
  const text = [
    'DreamFlutter macOS Apple Silicon (arm64) Third-Party Notices',
    '',
    '- Node.js (runtime/bin/node): MIT / OpenJS Foundation',
    '- ripgrep (core/bin/rg): Unlicense / MIT (BurntSushi/ripgrep)',
    '- fd (core/bin/fd): MIT / Apache-2.0 (sharkdp/fd)',
    '- uv / uvx (core/bin/uv, uvx): MIT / Apache-2.0 (astral-sh/uv)',
    '- CPython (core/python/): Python Software Foundation License (python-build-standalone)',
    '- Python office libraries: python-docx, openpyxl, python-pptx, pypdf, pandas, matplotlib, pillow, xlsxwriter, lxml',
    '- WenQuanYi Micro Hei: bundled in Matplotlib fonts/ttf/, Apache-2.0 option retained',
    '- sherpa-onnx-node & sherpa-onnx-darwin-arm64 (1.13.8) + tokens.txt / silero_vad.onnx: Apache-2.0',
    '- desktop_drop (vendored in packages/desktop_drop): Apache-2.0',
    '',
  ].join('\n');
  writeFileSync(join(licensesDir, 'THIRD-PARTY.txt'), text, 'utf8');
}

export function prepareMacRuntime({ target, cacheDir }) {
  const absTarget = resolve(target);
  if (!existsSync(join(absTarget, 'core', 'package.json'))) {
    throw new Error(`Target does not contain core/package.json: ${absTarget}`);
  }
  const bundledLock = JSON.parse(readFileSync(bundledLockPath, 'utf8'));
  const voiceLock = JSON.parse(readFileSync(voiceLockPath, 'utf8'));
  const licensesDir = join(absTarget, 'licenses');
  mkdirSync(licensesDir, { recursive: true });

  const scratch = mkdtempSync(join(tmpdir(), 'df-macos-runtime-'));
  try {
    installNodeRuntime(absTarget, licensesDir);
    installMacTools(absTarget, cacheDir, scratch);
    installPythonAndOffice(absTarget, bundledLock, cacheDir, scratch);
    installVoiceSmallFiles(absTarget, voiceLock, cacheDir, scratch);
    writeNotices(licensesDir);
    console.log(JSON.stringify({ ok: true, target: absTarget }));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/prepare-bundled-runtime-macos.mjs --target <ResourcesDir> [--cache <dir>]');
    process.exit(0);
  }
  const opt = (flag, fallback) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : fallback;
  };
  const target = opt('--target');
  if (!target) {
    console.error('Missing --target <DreamFlutter.app/Contents/Resources>');
    process.exit(2);
  }
  const cacheDir = resolve(opt('--cache', join(repository, 'core', 'bin', '.bundle-cache-macos')));
  prepareMacRuntime({ target, cacheDir });
}
