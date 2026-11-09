import { spawn } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { Core } from "../core.ts";
import { minimalMcpEnv } from "../security/mcp.ts";
import { redact, redactValue } from "../security/redaction.ts";

export interface TrialBundle { files: Record<string, string>; script: string; args?: string[]; timeoutMs?: number; maxOutputBytes?: number; }
export interface TrialResult {
	ok: boolean; status: string; runtime: "butterfly-sandbox"; reason?: string; exitCode?: number | null;
	stdout?: string; stderr?: string; timedOut?: boolean; outputTruncated?: boolean; durationMs?: number;
	artifacts?: { path: string; size: number; sha256: string; textPreview?: string }[];
}
export type TrialRunner = (distro: string, input: string, timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** Runs in WSL as agent, never on the host. No root or sandbox startup/config changes. */
export const TRIAL_PYTHON = String.raw`
import os,sys,json,base64,tempfile,shutil,subprocess,selectors,time,signal,hashlib,stat,resource
data=json.load(sys.stdin)
root=tempfile.mkdtemp(prefix='df-skill-trial-')
result={'ok':False,'status':'failed','runtime':'butterfly-sandbox','artifacts':[]}
proc=None
started=time.monotonic()
def kill():
 if proc:
  try: os.killpg(proc.pid,signal.SIGKILL)
  except ProcessLookupError: pass
try:
 if os.getuid()==0 or os.environ.get('USER','agent')=='root': raise ValueError('trial must run as agent, never root')
 original={}
 for name,encoded in data['files'].items():
  if name.startswith('/') or '\\' in name or any(p in ('','..','.') for p in name.split('/')): raise ValueError('unsafe bundle path')
  dest=os.path.join(root,name); os.makedirs(os.path.dirname(dest),exist_ok=True)
  raw=base64.b64decode(encoded,validate=True); open(dest,'wb').write(raw); original[name]=hashlib.sha256(raw).hexdigest()
 script=data['script']
 if script not in original: raise ValueError('script is missing from bundle')
 extension=os.path.splitext(script)[1].lower()
 runner={'.py':'python3','.js':'node','.mjs':'node','.cjs':'node','.sh':'bash'}.get(extension)
 if not runner: raise ValueError('unsupported sandbox script type: '+extension)
 executable=shutil.which(runner)
 if not executable: raise ValueError('sandbox interpreter unavailable: '+runner)
 def limits():
  resource.setrlimit(resource.RLIMIT_CORE,(0,0))
  resource.setrlimit(resource.RLIMIT_FSIZE,(16*1024*1024,16*1024*1024))
  resource.setrlimit(resource.RLIMIT_CPU,(int(data['timeoutMs']/1000)+1,int(data['timeoutMs']/1000)+2))
 proc=subprocess.Popen([executable,os.path.join(root,script)]+data['args'],cwd=root,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,preexec_fn=limits,env={**os.environ,'PYTHONUTF8':'1','PYTHONDONTWRITEBYTECODE':'1'})
 selector=selectors.DefaultSelector(); selector.register(proc.stdout,selectors.EVENT_READ,'stdout'); selector.register(proc.stderr,selectors.EVENT_READ,'stderr')
 outputs={'stdout':bytearray(),'stderr':bytearray()}; kept=0; truncated=False; timedout=False
 while selector.get_map():
  if (time.monotonic()-started)*1000>data['timeoutMs']: timedout=True; kill(); break
  for key,_ in selector.select(0.05):
   chunk=os.read(key.fileobj.fileno(),4096)
   if not chunk: selector.unregister(key.fileobj); continue
   room=max(0,data['maxOutputBytes']-kept); outputs[key.data].extend(chunk[:room]); kept+=min(room,len(chunk))
   if len(chunk)>room: truncated=True; kill()
  if truncated: break
 kill(); proc.wait(timeout=3)
 result.update(exitCode=proc.returncode,stdout=outputs['stdout'].decode('utf8','replace'),stderr=outputs['stderr'].decode('utf8','replace'),timedOut=timedout,outputTruncated=truncated,ok=proc.returncode==0 and not timedout and not truncated,status='timeout' if timedout else 'output-limit' if truncated else 'passed' if proc.returncode==0 else 'failed')
 if timedout: result['reason']='sandbox trial exceeded time limit'
 if truncated: result['reason']='sandbox trial exceeded output limit'
 hashed=0
 for parent,dirs,files in os.walk(root,followlinks=False):
  dirs[:]=[d for d in dirs if not os.path.islink(os.path.join(parent,d))]
  for name in files:
   path=os.path.join(parent,name); item=os.lstat(path); rel=os.path.relpath(path,root)
   if not stat.S_ISREG(item.st_mode) or item.st_size>16*1024*1024 or hashed+item.st_size>32*1024*1024: continue
   raw=open(path,'rb').read(); hashed+=len(raw); digest=hashlib.sha256(raw).hexdigest()
   if original.get(rel)==digest: continue
   artifact={'path':rel,'size':len(raw),'sha256':digest}
   if len(raw)<=4096:
    try: artifact['textPreview']=raw.decode('utf8')
    except UnicodeDecodeError: pass
   result['artifacts'].append(artifact)
   if len(result['artifacts'])>=100: break
  if len(result['artifacts'])>=100: break
except Exception as error:
 result.update(ok=False,status='failed',reason=str(error))
finally:
 kill()
 if proc:
  try: proc.wait(timeout=3)
  except Exception: pass
 shutil.rmtree(root,ignore_errors=True)
 result['durationMs']=round((time.monotonic()-started)*1000)
 print(json.dumps(result,ensure_ascii=False))
`;

/** Host captures only the bounded harness response; it never runs the supplied script/interpreter. */
export const runTrialWsl: TrialRunner = (distro, input, timeoutMs) => new Promise((done) => {
	const child = spawn("wsl.exe", ["-d", distro, "-u", "agent", "--exec", "python3", "-c", TRIAL_PYTHON], { windowsHide: true, env: { ...minimalMcpEnv(), WSL_UTF8: "1" } });
	let stdout = "", stderr = "", finished = false;
	const finish = (code: number | null, error?: string) => { if (finished) return; finished = true; clearTimeout(timer); done({ code, stdout, stderr: error ?? stderr }); };
	const timer = setTimeout(() => { child.kill(); finish(null, "沙箱试运行控制进程超时"); }, timeoutMs + 8_000);
	child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => { if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > 2 * 1024 * 1024) { child.kill(); finish(null, "沙箱试运行响应超过上限"); } else stdout += chunk; });
	child.stderr.on("data", (chunk: string) => { if (Buffer.byteLength(stderr) < 64 * 1024) stderr += chunk.slice(0, 4096); });
	child.on("error", (error) => finish(null, error.message)); child.on("close", (code) => finish(code)); child.stdin.on("error", () => {}); child.stdin.end(input);
});

export function skillBundle(root: string): Record<string, string> {
	const files: Record<string, string> = {}; let size = 0, count = 0;
	const visit = (dir: string) => { for (const name of readdirSync(dir)) {
		const path = join(dir, name), stat = lstatSync(path);
		if (stat.isSymbolicLink()) throw new Error("技能不能包含符号链接或目录联接");
		if (stat.isDirectory()) { visit(path); continue; }
		if (!stat.isFile() || ++count > 2000 || (size += stat.size) > 32 * 1024 * 1024) throw new Error("技能文件过多、过大或包含特殊文件");
		files[relative(root, path).replaceAll("\\", "/")] = readFileSync(path).toString("base64");
	} };
	visit(root); return files;
}
export async function trialSkill(core: Pick<Core, "sandboxProvider" | "security">, bundle: TrialBundle, runner: TrialRunner = runTrialWsl): Promise<TrialResult> {
	const fail = (status: string, reason: string): TrialResult => ({ ok: false, status, runtime: "butterfly-sandbox", reason });
	if (!bundle.script || bundle.script.split(/[\\/]/).some((p) => !p || p === "." || p === "..") || bundle.script.startsWith("/") || bundle.script.includes(":")) return fail("invalid-script", "请选择技能目录内的相对脚本路径");
	if (!Object.hasOwn(bundle.files, bundle.script)) return fail("invalid-script", "技能目录没有这个脚本");
	if (Object.entries(bundle.files).some(([name, value]) => typeof value !== "string" || name.includes(":") || name.startsWith("/") || name.includes("\\") || name.split("/").some((p) => !p || p === "." || p === ".."))) return fail("invalid-bundle", "技能文件路径无效");
	const timeoutMs = Math.min(60_000, Math.max(100, Math.trunc(bundle.timeoutMs ?? 15_000))), maxOutputBytes = Math.min(256 * 1024, Math.max(1024, Math.trunc(bundle.maxOutputBytes ?? 64 * 1024)));
	if (!Number.isFinite(timeoutMs) || !Number.isFinite(maxOutputBytes) || bundle.args && (!Array.isArray(bundle.args) || bundle.args.length > 128 || bundle.args.some((arg) => typeof arg !== "string" || arg.length > 4096))) return fail("invalid-request", "参数、超时或输出限制无效");
	const input = JSON.stringify({ ...bundle, args: bundle.args ?? [], timeoutMs, maxOutputBytes });
	if (Object.keys(bundle.files).length > 2000 || Buffer.byteLength(input) > 48 * 1024 * 1024) return fail("invalid-bundle", "技能文件过多或超过复制上限");
	const sandbox = core.sandboxProvider?.();
	if (!sandbox) return fail("not-ready", "蝶君沙箱尚未准备好，请先完成沙箱设置；没有在本机执行脚本");
	try {
		await sandbox.ready();
		await core.security.loadKnownSecrets();
		core.security.audit.record("skill-trial", bundle.script, "sandbox", "复制技能目录到临时目录，以 agent 用户限时限输出试运行，不改变信任或启用");
		const response = await runner(sandbox.distro, input, timeoutMs);
		if (response.code !== 0) return fail("runner-error", redact(response.stderr || "沙箱执行器未正常退出", true));
		const result: unknown = JSON.parse(response.stdout);
		if (!result || typeof result !== "object" || !("runtime" in result) || result.runtime !== "butterfly-sandbox" || !("ok" in result) || typeof result.ok !== "boolean") return fail("runner-error", "沙箱执行器返回了无效结果");
		return redactValue(result) as TrialResult;
	} catch (error) { return fail("not-ready", redact(`沙箱试运行未完成：${(error as Error).message}`, true)); }
}
