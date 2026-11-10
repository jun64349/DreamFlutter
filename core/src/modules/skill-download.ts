import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { Archive } from "../backup/archive.ts";
import { RpcError } from "../core.ts";

/** Public GitHub repository/directory links, direct ZIPs, or standalone SKILL.md. */
export function skillDownloadTarget(raw: string): { url: URL; directory?: string } {
  let url: URL;
  try { url = new URL(raw); } catch { throw new RpcError("bad_request", "请填完整的网页链接"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new RpcError("bad_request", "请使用不带密码的网页链接");
  if (url.hostname === "github.com" && !url.pathname.endsWith(".zip")) {
    const [owner, repo, type, ref, ...path] = url.pathname.split("/").filter(Boolean);
    if (!owner || !repo || type && !["tree", "blob"].includes(type)) throw new RpcError("bad_request", "请使用仓库或技能文件夹的链接");
    return { url: new URL(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo.replace(/\.git$/, ""))}/zipball/${encodeURIComponent(ref ?? "HEAD")}`), directory: path.length ? (type === "blob" ? path.slice(0, -1) : path).join("/") : undefined };
  }
  return { url };
}

export async function withSkillDownload<T>(raw: string, consume: (folder: string) => T | Promise<T>, fetcher: typeof fetch = fetch): Promise<T> {
  const target = skillDownloadTarget(raw), folder = await mkdtemp(join(tmpdir(), "df-skill-import-"));
  const signal = AbortSignal.timeout(30_000);
  try {
    let url = target.url, response: Response | undefined;
    for (let redirects = 0; redirects <= 5; redirects++) {
      response = await fetcher(url, { signal, redirect: "manual", headers: { "User-Agent": "DreamFlutter", Accept: "application/octet-stream" } });
      if (response.status >= 300 && response.status < 400) {
        const next = response.headers.get("location"); await response.body?.cancel();
        if (!next || redirects === 5) throw new RpcError("download", "链接跳转过多，请换一个下载链接");
        url = skillDownloadTarget(new URL(next, url).href).url; continue;
      }
      break;
    }
    if (!response?.ok || !response.body) throw new RpcError("download", "没有下载成功，请检查链接是否公开可访问");
    const chunks: Uint8Array[] = []; let bytes = 0;
    const reader = response.body.getReader();
    try { for (;;) { const {done, value} = await reader.read(); if (done) break; bytes += value.length; if (bytes > 32 * 1024 ** 2) throw new RpcError("too_large", "技能下载超过32MB，请选择更小的技能文件夹"); chunks.push(value); } }
    finally { await reader.cancel().catch(() => {}); }
    const buffer = Buffer.concat(chunks);
    const unpacked = join(folder, "files"); await mkdir(unpacked);
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
      const zip = join(folder, "download.zip"); await writeFile(zip, buffer);
      const archive = await Archive.open(zip);
      try {
        if (archive.entries.size > 2000 || archive.totalSize > 32 * 1024 ** 2) throw new RpcError("too_large", "技能文件过多或解开后超过32MB");
        const candidates = [...archive.entries.keys()].filter((name) => name.endsWith("/SKILL.md") || name === "SKILL.md").filter((name) => !target.directory || name === `${target.directory}/SKILL.md` || name.endsWith(`/${target.directory}/SKILL.md`));
        if (candidates.length !== 1) throw new RpcError("bad_request", candidates.length ? "链接里有多个技能，请链接到具体技能文件夹" : "链接里没有找到技能文件");
        const skillRoot = dirname(candidates[0]!).replaceAll("\\", "/");
        for (const name of archive.entries.keys()) {
          if (skillRoot !== "." && !name.startsWith(skillRoot + "/")) continue;
          const suffix = skillRoot === "." ? name : name.slice(skillRoot.length + 1), dest = join(unpacked, suffix);
          if (relative(unpacked, dest).startsWith("..")) throw new RpcError("bad_request", "技能文件路径越界");
          await archive.extract(name, dest, signal);
        }
      } finally { archive.close(); }
    } else {
      if (!/\/SKILL\.md$/i.test(target.url.pathname)) throw new RpcError("bad_request", "请使用技能文件、ZIP或公开仓库链接");
      await writeFile(join(unpacked, "SKILL.md"), buffer);
    }
    return await consume(unpacked);
  } finally { await rm(folder, { recursive: true, force: true }); }
}
