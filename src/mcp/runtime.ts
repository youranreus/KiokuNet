import { join } from "node:path";
import { rm } from "node:fs/promises";
import { Config, atomicJson } from "../core.js";
import { revision, settings } from "./config.js";
import { startMcpServer } from "./server.js";

// Reconciled outside the CLI mutation lock: enable/disable can wait for the
// listener without blocking source registration or restarting Syncthing.
export class McpRuntime {
  private server?: Awaited<ReturnType<typeof startMcpServer>>;
  private applied?: string;
  private error?: string;
  private retryAt = 0;
  constructor(private home: string) {}
  async reconcile(c: Config) {
    const wanted = revision(c),
      config = settings(c);
    if (
      wanted !== this.applied ||
      (config.enabled && !this.server?.running && Date.now() >= this.retryAt)
    ) {
      await this.server?.close();
      this.server = undefined;
      this.error = undefined;
      this.applied = wanted;
      if (config.enabled) {
        try {
          if (c.mode !== "hub") throw new Error("HUB_REQUIRED");
          this.server = await startMcpServer(this.home, config);
        } catch (e) {
          this.error =
            (e as NodeJS.ErrnoException).code || (e as Error).message;
          this.retryAt = Date.now() + 5000;
        }
      }
    }
    await atomicJson(join(this.home, "mcp.json"), {
      pid: process.pid,
      revision: this.applied,
      running: this.server?.running || false,
      updatedAt: new Date().toISOString(),
      error: this.error || this.server?.error,
    });
  }
  async close() {
    await this.server?.close();
    await rm(join(this.home, "mcp.json"), { force: true });
  }
}
