import { readFileSync, readdirSync } from "node:fs";
import type { Page, Request } from "playwright-core";

// Retain only transport metadata. URLs, query strings, headers and bodies can
// contain authentication material and must never enter a diagnostic record.
export class EQDiagnostics {
  private events: Record<string, unknown>[] = [];

  private add(event: string, fields: Record<string, unknown> = {}) {
    this.events.push({ at: new Date().toISOString(), event, ...fields });
    if (this.events.length > 250) this.events.shift();
  }

  private request(request: Request) {
    const url = new URL(request.url());
    return {
      host: url.hostname,
      route:
        /^\/(u\/login\/(identifier|password)|u\/mfa-email-challenge|authorize(?:\/resume)?|oauth\/token|web\/v1\.1\/accounts\/v2\/accounts)$/.test(
          url.pathname,
        )
          ? url.pathname
          : "[other]",
      method: request.method(),
      type: request.resourceType(),
    };
  }

  attach(page: Page) {
    page.on("crash", () => this.add("page-crashed"));
    page.on("close", () => this.add("page-closed"));
    page.on("pageerror", (error) =>
      this.add("page-error", { name: error.name }),
    );
    page
      .context()
      .browser()
      ?.on("disconnected", () => this.add("browser-disconnected"));
    page.on("request", (request) => {
      if (
        new URL(request.url()).hostname.endsWith("eqbank.ca") &&
        ["document", "xhr", "fetch"].includes(request.resourceType())
      )
        this.add("request", this.request(request));
    });
    page.on("response", (response) => {
      const request = response.request();
      if (
        new URL(request.url()).hostname.endsWith("eqbank.ca") &&
        ["document", "xhr", "fetch"].includes(request.resourceType())
      )
        this.add("response", {
          ...this.request(request),
          status: response.status(),
        });
    });
    page.on("requestfailed", (request) => {
      const failure = request.failure()?.errorText ?? "";
      this.add("request-failed", {
        ...this.request(request),
        failure: /^net::[A-Z_0-9.]+$/.test(failure) ? failure : "unavailable",
      });
    });
  }

  resources() {
    if (process.platform !== "linux") return {};
    const read = (file: string, fallback?: string): string => {
      try {
        return readFileSync(file, "utf8").trim();
      } catch {
        return fallback ? read(fallback) : "unavailable";
      }
    };
    let chromiumRssKb = 0;
    let chromiumProcesses = 0;
    for (const pid of readdirSync("/proc").filter((name) =>
      /^\d+$/.test(name),
    )) {
      const status = read(`/proc/${pid}/status`);
      if (!/^Name:\s+(chrome|chromium)/m.test(status)) continue;
      chromiumProcesses++;
      chromiumRssKb += Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0);
    }
    return {
      memoryCurrent: read(
        "/sys/fs/cgroup/memory.current",
        "/sys/fs/cgroup/memory/memory.usage_in_bytes",
      ),
      memoryMax: read(
        "/sys/fs/cgroup/memory.max",
        "/sys/fs/cgroup/memory/memory.limit_in_bytes",
      ),
      memoryEvents: read(
        "/sys/fs/cgroup/memory.events",
        "/sys/fs/cgroup/memory/memory.oom_control",
      ),
      memoryFailures: read("/sys/fs/cgroup/memory/memory.failcnt"),
      cpuStat: read("/sys/fs/cgroup/cpu.stat", "/sys/fs/cgroup/cpu/cpu.stat"),
      chromiumProcesses,
      chromiumRssKb,
    };
  }

  snapshot(stage: string, error?: unknown) {
    return {
      version: 1,
      stage,
      failureName: error instanceof Error ? error.name : undefined,
      failureOperation:
        error instanceof Error
          ? error.message.match(/^([a-zA-Z.]+):/)?.[1]
          : undefined,
      resources: this.resources(),
      events: this.events,
    };
  }
}
