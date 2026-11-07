import type { Core, CoreModule } from "../core.ts";
import { PYTHON_SOURCES, NPM_SOURCES, hostProjectFiles, packageEnvironment, projectPaths, sandboxProjectFiles } from "../agent/package-sources.ts";
import type { SourceSnapshot, ToolEnvironment, ToolEnvironmentProvider } from "../agent/tool-environment.ts";

export class PackageSourcesModule implements CoreModule, ToolEnvironmentProvider {
  readonly modelFacing = false;
  private readonly core: Core;
  private readonly recent: Partial<Record<"host" | "sandbox", SourceSnapshot>> = {};
  constructor(core: Core) {
    this.core = core;
    core.toolEnvironment = this;
    core.register("packageSources.status", (params) => {
      const cwd = typeof params.cwd === "string" && params.cwd.trim() ? params.cwd : process.cwd();
      return { nextHost: this.buildHost(cwd, cwd).snapshot, recent: this.recent, python: PYTHON_SOURCES, npm: NPM_SOURCES };
    });
  }
  private buildHost(cwd: string, workspace: string, command?: string): ToolEnvironment {
    return packageEnvironment(this.core.settings.get(), hostProjectFiles(projectPaths(cwd, workspace)), { cwd, workspace, platform: "host", command });
  }
  private record(result: ToolEnvironment): ToolEnvironment {
    const snapshot = result.snapshot;
    this.recent[snapshot.platform] = snapshot;
    // No proxy values, configuration contents, arbitrary index URLs or credentials enter this record.
    this.core.log.info("package sources", { platform: snapshot.platform, cwd: snapshot.cwd, uv: snapshot.uv.layer, pip: snapshot.pip.layer, npm: snapshot.npm.layer });
    return result;
  }
  host(cwd: string, workspace: string, command?: string): ToolEnvironment { return this.record(this.buildHost(cwd, workspace, command)); }
  async sandbox(distro: string, cwd: string, workspace: string, command?: string): Promise<ToolEnvironment> {
    const files = await sandboxProjectFiles(distro, projectPaths(cwd, workspace, true));
    return this.record(packageEnvironment(this.core.settings.get(), files, { cwd, workspace, platform: "sandbox", distro, command }));
  }
}
