import { execFile } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { toolchainEnv } from '../../core/src/agent/toolchain.ts';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
if (!resolve(config.temporary).startsWith(resolve(tmpdir()) + '\\df-t67-velopack-')) throw Error('Not an isolated T67 directory');
const env = toolchainEnv();
await Promise.all([
  ['sdk.zip', config.sdkUrl],
  ['vpk.zip', 'https://github.com/velopack/velopack/releases/download/1.2.161/vpk.1.2.161.nupkg'],
].map(([name, url]) => {
  const path = join(config.temporary, name);
  if (existsSync(path) && (name === 'sdk.zip' ? createHash('sha512').update(readFileSync(path)).digest('hex') === config.sdkHash : statSync(path).size === 146884263)) { console.log(`${name}: already present`); return; }
  return new Promise((done, reject) => execFile('curl.exe', ['-fL', '--max-time', '150', '--silent', '--show-error', url, '-o', path], { env, windowsHide: true, timeout: 160000 }, (error) => { if (error) reject(error); else { console.log(`${name}: downloaded`); done(); } }));
}));
