/**
 * SandboxController — injectable interface over @vercel/sandbox.
 *
 * Production code uses the real Sandbox SDK.  Tests swap in
 * FakeSandboxController via `_setSandboxControllerForTesting()`.
 */
import type { NetworkPolicy, Sandbox } from "@vercel/sandbox";

// ---------------------------------------------------------------------------
// Minimal result types that mirror what lifecycle.ts actually reads
// ---------------------------------------------------------------------------

export type CommandResult = {
  exitCode: number;
  output(stream?: "stdout" | "stderr" | "both"): Promise<string>;
};

export type SnapshotResult = {
  snapshotId: string;
};

export type CreateParams = {
  ports?: number[];
  timeout?: number;
  resources?: { vcpus: number };
  source?: { type: "snapshot"; snapshotId: string };
  env?: Record<string, string>;
};

// ---------------------------------------------------------------------------
// SandboxHandle — the instance-level surface lifecycle.ts touches
// ---------------------------------------------------------------------------

export interface SandboxHandle {
  sandboxId: string;
  runCommand(
    command: string,
    args?: string[],
  ): Promise<CommandResult>;
  writeFiles(
    files: { path: string; content: Buffer }[],
  ): Promise<void>;
  domain(port: number): string;
  snapshot(): Promise<SnapshotResult>;
  extendTimeout(duration: number): Promise<void>;
  updateNetworkPolicy(policy: NetworkPolicy): Promise<NetworkPolicy>;
}

// ---------------------------------------------------------------------------
// SandboxController — the static-level surface (create / get)
// ---------------------------------------------------------------------------

export interface SandboxController {
  create(params: CreateParams): Promise<SandboxHandle>;
  get(params: { sandboxId: string }): Promise<SandboxHandle>;
}

// ---------------------------------------------------------------------------
// Real implementation — wraps @vercel/sandbox
// ---------------------------------------------------------------------------

function wrapSandbox(sandbox: Sandbox): SandboxHandle {
  return {
    sandboxId: sandbox.sandboxId,
    async runCommand(command, args) {
      const result = await sandbox.runCommand(command, args ?? []);
      return {
        exitCode: result.exitCode,
        output: (stream) => result.output(stream),
      };
    },
    async writeFiles(files) {
      await sandbox.writeFiles(files);
    },
    domain(port) {
      return sandbox.domain(port);
    },
    async snapshot() {
      const snap = await sandbox.snapshot();
      return { snapshotId: snap.snapshotId };
    },
    async extendTimeout(duration) {
      await sandbox.extendTimeout(duration);
    },
    async updateNetworkPolicy(policy) {
      return sandbox.updateNetworkPolicy(policy);
    },
  };
}

const realController: SandboxController = {
  async create(params) {
    const { Sandbox: SandboxClass } = await import("@vercel/sandbox");
    // CreateParams is a simplified subset — cast to satisfy the SDK's union type.
    const sandbox = await SandboxClass.create(params as Parameters<typeof SandboxClass.create>[0]);
    return wrapSandbox(sandbox);
  },
  async get(params) {
    const { Sandbox: SandboxClass } = await import("@vercel/sandbox");
    const sandbox = await SandboxClass.get(params);
    return wrapSandbox(sandbox);
  },
};

// ---------------------------------------------------------------------------
// Module-level singleton with test override
// ---------------------------------------------------------------------------

let activeController: SandboxController = realController;

export function getSandboxController(): SandboxController {
  return activeController;
}

export function _setSandboxControllerForTesting(
  controller: SandboxController | null,
): void {
  activeController = controller ?? realController;
}
