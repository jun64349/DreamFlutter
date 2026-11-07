import { createServer } from 'node:http';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const data = process.env.T67_DATA, version = process.env.T67_VERSION;
if (!data || !version) process.exit(40);
if (process.env.T67_FAIL === 'true') process.exit(42);
mkdirSync(data, { recursive: true });
const sentinel = join(data, 'fixture-data.txt');
if (!existsSync(sentinel)) writeFileSync(sentinel, 'T67-DATA-MUST-SURVIVE');
const server = createServer((req, res) => {
  if (req.url === '/shutdown') { res.end('stopped'); server.close(() => process.exit(0)); }
  else res.end(JSON.stringify({ version, pid: process.pid }));
});
server.listen(0, '127.0.0.1', () => writeFileSync(join(data, `backend-${version}.json`), JSON.stringify({ version, pid: process.pid, port: server.address().port })));
