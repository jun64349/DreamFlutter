import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

/** Minimal zip (no zip64, no encryption): enough for `.card.zip` packages. */

export interface ZipEntry {
	name: string;
	data: Buffer;
}

export function writeZip(entries: ZipEntry[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
		const deflated = deflateRawSync(entry.data);
		const stored = deflated.length >= entry.data.length;
		const body = stored ? entry.data : deflated;
		const crc = crc32(entry.data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6); // UTF-8 names
		local.writeUInt16LE(stored ? 0 : 8, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(entry.data.length, 22);
		local.writeUInt16LE(name.length, 26);
		locals.push(local, name, body);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(stored ? 0 : 8, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(entry.data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);
		offset += local.length + name.length + body.length;
	}
	const centralSize = centrals.reduce((n, b) => n + b.length, 0);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralSize, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, ...centrals, end]);
}

/** Entries of a zip archive; refuses archives over [maxTotal] bytes uncompressed. */
export function readZip(buffer: Buffer, maxTotal = 200 * 1024 * 1024): ZipEntry[] {
	let endAt = -1;
	for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
		if (buffer.readUInt32LE(i) === 0x06054b50) {
			endAt = i;
			break;
		}
	}
	if (endAt < 0) throw new Error("不是有效的 zip 文件");
	const count = buffer.readUInt16LE(endAt + 10);
	let at = buffer.readUInt32LE(endAt + 16);
	const entries: ZipEntry[] = [];
	let total = 0;
	for (let i = 0; i < count; i++) {
		if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error("zip 目录损坏");
		const method = buffer.readUInt16LE(at + 10);
		const compressed = buffer.readUInt32LE(at + 20);
		const size = buffer.readUInt32LE(at + 24);
		const nameLength = buffer.readUInt16LE(at + 28);
		const extraLength = buffer.readUInt16LE(at + 30);
		const commentLength = buffer.readUInt16LE(at + 32);
		const localAt = buffer.readUInt32LE(at + 42);
		const name = buffer.subarray(at + 46, at + 46 + nameLength).toString("utf8");
		at += 46 + nameLength + extraLength + commentLength;
		if (name.endsWith("/")) continue;
		// A stored entry is copied as is: its two sizes must agree, or a forged
		// "size 0" would slip past the total while copying the whole archive.
		if (method === 0 && compressed !== size) throw new Error("zip 条目大小不一致");
		total += size;
		if (total > maxTotal) throw new Error("zip 解压后太大");
		const localName = buffer.readUInt16LE(localAt + 26);
		const localExtra = buffer.readUInt16LE(localAt + 28);
		const start = localAt + 30 + localName + localExtra;
		if (start + compressed > buffer.length) throw new Error("zip 条目超出文件范围");
		const raw = buffer.subarray(start, start + compressed);
		let data: Buffer;
		if (method === 0) data = Buffer.from(raw);
		else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
		else throw new Error(`不支持的压缩方式 ${method}`);
		entries.push({ name, data });
	}
	return entries;
}
