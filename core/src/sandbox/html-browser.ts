import { spawn } from "node:child_process";
import { browserEnvironment, managedBrowserPipe, OFFLINE_BROWSER_FLAGS } from "../agent/render-html-browser.ts";
import type { BrowserPipe } from "../agent/render-html-cdp.ts";

const BROWSER_PATHS = ["/usr/bin/chromium-headless-shell", "/usr/local/bin/chromium-headless-shell"];
// Debian 13 installation plan on the shipped pre-browser image (download bytes).
export const CHROMIUM_DOWNLOAD_MB = 158;
const PIPE_SUPERVISOR = String.raw
`
import os, select, shutil, signal, subprocess, sys, tempfile

profile = tempfile.mkdtemp(prefix="df-html-chromium-")
browser = None
try:
    os.dup2(0, 3, inheritable=True)
    os.dup2(1, 4, inheritable=True)
    browser = subprocess.Popen(
        [sys.argv[1], *sys.argv[2:], "--user-data-dir=" + profile, "about:blank"],
        pass_fds=(3, 4), start_new_session=True,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    os.close(3)
    os.close(4)
    watcher = select.poll()
    watcher.register(0, select.POLLHUP | select.POLLERR)
    while browser.poll() is None and not watcher.poll(80):
        pass
finally:
    if browser:
        try:
            os.killpg(browser.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        browser.wait()
    shutil.rmtree(profile)
`;

export interface HtmlSandbox { distro: string; ready(): Promise<void> }

export class SandboxHtmlBrowser {
	private static readonly installations = new Map<string, Promise<void>>();
	private readonly distro: string;
	constructor(distro: string) { this.distro = distro; }

	private env(): NodeJS.ProcessEnv { return { ...browserEnvironment(), WSLENV: "", WSL_UTF8: "1" }; }

	install(): Promise<void> {
		const pending = SandboxHtmlBrowser.installations.get(this.distro);
		if (pending) return pending;
		const installation = this.installFromMirror().finally(() => SandboxHtmlBrowser.installations.delete(this.distro));
		SandboxHtmlBrowser.installations.set(this.distro, installation);
		return installation;
	}

	private async installFromMirror(): Promise<void> {
		// Only this fixed Debian package may be installed, using APT's existing sources and signature checks.
		for (const args of [
			["--error-on=any", "update"],
			["--yes", "--no-install-recommends", "--no-remove", "install", "chromium-headless-shell"],
		]) {
			const child = spawn("wsl.exe", ["-d", this.distro, "-u", "root", "--cd", "/", "--exec",
				"/usr/bin/env", "-i", "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8", "DEBIAN_FRONTEND=noninteractive",
				"/usr/bin/apt-get", "-o", "Acquire::Retries=1", "-o", "Acquire::http::Timeout=30",
				"-o", "Acquire::https::Timeout=30", "-o", "DPkg::Lock::Timeout=60", ...args], {
				windowsHide: true, env: this.env(), stdio: "ignore",
			});
			const status = await new Promise<number | null>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", resolve);
			});
			if (status !== 0) throw new Error("无法从当前沙箱镜像源安装截图浏览器。");
		}
	}

	async find(signal: AbortSignal): Promise<string | undefined> {
		for (const file of BROWSER_PATHS) {
			signal.throwIfAborted();
			const child = spawn("wsl.exe", ["-d", this.distro, "-u", "agent", "--exec", "/usr/bin/test", "-x", file], {
				windowsHide: true, env: this.env(), stdio: "ignore", signal,
			});
			const status = await new Promise<number | null>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", resolve);
			});
			if (status === 0) return file;
		}
	}

	async launch(binary: string, signal: AbortSignal): Promise<BrowserPipe> {
		signal.throwIfAborted();
		// The fixed launcher creates a private network namespace then drops to agent
		// before starting Chromium. No change to the sandbox's shared network rules.
		const child = spawn("wsl.exe", ["-d", this.distro, "-u", "root", "--cd", "/", "--exec",
			"/usr/bin/unshare", "--net", "--", "/usr/bin/setpriv", "--reuid=agent", "--regid=agent", "--init-groups",
			"/usr/bin/env", "-i", "HOME=/workspace", "PATH=/usr/bin:/bin", "LANG=C.UTF-8",
			"/usr/bin/python3", "-I", "-c", PIPE_SUPERVISOR, binary, ...OFFLINE_BROWSER_FLAGS, "--disable-dev-shm-usage"], {
			windowsHide: true, env: this.env(), stdio: ["pipe", "pipe", "ignore"],
		});
		return managedBrowserPipe(child, child.stdin!, child.stdout!, async () => {});
	}
}
