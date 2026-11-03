import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, type ScryptOptions } from "node:crypto";

/**
 * The API keys in a package, under the migration password the user sets:
 * scrypt (parameters stored, capped when reading) + AES-256-GCM. A wrong
 * password fails the GCM check; nothing falls back to plain text.
 */

export interface SealedBox {
	kdf: "scrypt";
	N: number;
	r: number;
	p: number;
	salt: string;
	iv: string;
	tag: string;
	data: string;
}

const PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const MAX = { N: 2 ** 20, r: 16, p: 4 };

function scrypt(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
	return new Promise((resolve, reject) =>
		scryptCb(password.normalize("NFC"), salt, 32, { ...options, maxmem: 256 * options.N! * options.r! }, (error, key) => (error ? reject(error) : resolve(key))),
	);
}

export async function seal(plain: Buffer, password: string): Promise<SealedBox> {
	const salt = randomBytes(16);
	const iv = randomBytes(12);
	const key = await scrypt(password, salt, PARAMS);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const data = Buffer.concat([cipher.update(plain), cipher.final()]);
	return { kdf: "scrypt", ...PARAMS, salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

export class WrongPassword extends Error {
	constructor() {
		super("迁移密码不对");
	}
}

export async function open(box: SealedBox, password: string): Promise<Buffer> {
	if (box.kdf !== "scrypt") throw new Error("不认识的加密方式");
	const { N, r, p } = box;
	const valid = (v: unknown, max: number) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max;
	if (!valid(N, MAX.N) || !valid(r, MAX.r) || !valid(p, MAX.p) || (N & (N - 1)) !== 0) throw new Error("加密参数超出允许的范围");
	const key = await scrypt(password, Buffer.from(box.salt, "base64"), { N, r, p });
	const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
	decipher.setAuthTag(Buffer.from(box.tag, "base64"));
	try {
		return Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]);
	} catch {
		throw new WrongPassword();
	}
}
