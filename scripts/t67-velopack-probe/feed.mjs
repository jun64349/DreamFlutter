import { createServer } from 'node:http';
import { readFileSync, writeFileSync, createReadStream, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
const [folder, control, ready] = process.argv.slice(2), requests = [];
const server = createServer((req, res) => {
  const name = basename(new URL(req.url, 'http://127.0.0.1').pathname);
  requests.push({ at: Date.now(), name });
  writeFileSync(ready + '.requests.json', JSON.stringify(requests, null, 2));
  if (name.endsWith('.json') && name.startsWith('releases.')) {
    const feed = JSON.parse(readFileSync(join(folder, name), 'utf8'));
    const versions = JSON.parse(readFileSync(control, 'utf8'));
    const key = Array.isArray(feed.Assets) ? 'Assets' : 'assets';
    feed[key] = feed[key].filter(asset => versions.includes(asset.Version ?? asset.version));
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(feed)); return;
  }
  const file = join(folder, name);
  if (!existsSync(file) || !statSync(file).isFile()) { res.statusCode = 404; res.end(); return; }
  res.setHeader('Content-Length', statSync(file).size); createReadStream(file).pipe(res);
});
server.listen(0, '127.0.0.1', () => writeFileSync(ready, JSON.stringify({ pid: process.pid, port: server.address().port })));
