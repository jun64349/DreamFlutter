/**
 * Copies the model channels configured in the app (with their keys, still
 * encrypted: the DPAPI files are copied as they are) into another data dir,
 * so a test core uses the user's channels without anyone handling a key.
 * Used by the window's E2E before it starts its own core.
 *   node --disable-warning=ExperimentalWarning scripts/copy-channels.ts <from-data-dir> <to-data-dir> [platform]
 * Prints one JSON line: [{ "channel": id, "name": ..., "models": [ids] }].
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Db } from "../src/db.ts";
import { SecretStore, relocateSecretRef, secretFileOf } from "../src/modules/secrets.ts";
import { corePaths } from "../src/paths.ts";

const [from, to, platform = "opencode-go"] = process.argv.slice(2);
if (!from || !to) {
	console.error("usage: copy-channels.ts <from-data-dir> <to-data-dir> [platform]");
	process.exit(2);
}
const source = corePaths(from);
const destination = corePaths(to);
const pathKey = (path: string) => resolve(path).toLowerCase();
if (pathKey(source.dbFile) === pathKey(destination.dbFile)) throw new Error("The destination database must differ from the source");
if (!existsSync(source.dbFile)) {
	console.error(`no database in ${from}`);
	process.exit(1);
}

type Row = Record<string, string | number | null>;
const read = new DatabaseSync(source.dbFile, { readOnly: true });
const channels = read.prepare("SELECT * FROM gateway_channels WHERE platform = ? AND enabled = 1 ORDER BY sort, created_at").all(platform) as Row[];
const keys = channels.flatMap((c) => read.prepare("SELECT * FROM gateway_keys WHERE channel_id = ? AND enabled = 1").all(c.id) as Row[]);
read.close();

mkdirSync(to, { recursive: true });
// Opening through Db creates the schema the core expects.
const target = new Db(destination.dbFile);
const insert = (table: string, row: Row) => {
	const columns = Object.keys(row);
	target.raw.prepare(`INSERT OR REPLACE INTO ${table}(${columns.join(", ")}) VALUES(${columns.map(() => "?").join(", ")})`).run(...columns.map((c) => row[c]!));
};
const fromSecrets = new SecretStore(from);
const toSecrets = new SecretStore(to);
try {
	if (pathKey(fromSecrets.dir) === pathKey(toSecrets.dir)) throw new Error("The destination secrets directory must differ from the source");
	mkdirSync(toSecrets.dir, { recursive: true });
	const copiedKeys = keys.map(key => {
		const ref = String(key.secret ?? "");
		const sourceFile = fromSecrets.fileFor(`gateway-${key.id}`), file = secretFileOf(ref);
		if (!file || pathKey(file) !== pathKey(sourceFile)) throw new Error("Expected a key stored in the source secrets directory");
		copyFileSync(sourceFile, toSecrets.fileFor(`gateway-${key.id}`));
		return { ...key, secret: relocateSecretRef(ref, toSecrets.dir) };
	});
	target.raw.exec("BEGIN");
	for (const channel of channels) insert("gateway_channels", channel);
	for (const key of copiedKeys) insert("gateway_keys", key);
	target.raw.exec("COMMIT");
} finally { target.raw.close(); }

console.log(JSON.stringify(channels.map((c) => ({ channel: c.id, name: c.name, models: (JSON.parse(String(c.models)) as { id: string }[]).map((m) => m.id) }))));
