import assert from "node:assert/strict";
import test from "node:test";

import { Sandbox } from "@vercel/sandbox";

import { ApiError } from "@/shared/http";
import type { SingleMeta } from "@/shared/types";
import {
  approveDomains,
  getFirewallState,
  promoteLearnedDomainsToEnforcing,
  removeDomains,
  setFirewallMode,
} from "@/server/firewall/state";
import { _resetStoreForTesting, mutateMeta } from "@/server/store/store";

async function withFirewallTestStore(fn: () => Promise<void>): Promise<void> {
  const overrides: Record<string, string | undefined> = {
    NODE_ENV: "test",
    VERCEL: undefined,
    UPSTASH_REDIS_REST_URL: undefined,
    UPSTASH_REDIS_REST_TOKEN: undefined,
    KV_REST_API_URL: undefined,
    KV_REST_API_TOKEN: undefined,
  };
  const originals: Record<string, string | undefined> = {};

  for (const key of Object.keys(overrides)) {
    originals[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }

  try {
    await fn();
  } finally {
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
    _resetStoreForTesting();
  }
}

async function prepareRunningSandbox(
  configure?: (meta: SingleMeta) => void,
): Promise<void> {
  await mutateMeta((meta) => {
    meta.status = "running";
    meta.sandboxId = "sandbox-123";
    configure?.(meta);
  });
}

function installFailingSandboxSync(): {
  readonly updateCalls: number;
  restore(): void;
} {
  const originalGet = Sandbox.get;
  let updateCalls = 0;

  Object.assign(Sandbox, {
    get: (async () =>
      ({
        async updateNetworkPolicy() {
          updateCalls += 1;
          throw new Error("sandbox policy update failed");
        },
      }) as unknown as Sandbox) as typeof Sandbox.get,
  });

  return {
    get updateCalls() {
      return updateCalls;
    },
    restore() {
      Object.assign(Sandbox, { get: originalGet });
    },
  };
}

async function assertFirewallSyncFailed(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 502);
    assert.equal(error.code, "FIREWALL_SYNC_FAILED");
    assert.equal(
      error.message,
      "Failed to sync firewall policy to the running sandbox.",
    );
    return true;
  });
}

test(
  "setFirewallMode throws FIREWALL_SYNC_FAILED when sandbox sync fails after persisting mode update",
  async () => {
    await withFirewallTestStore(async () => {
      const sandbox = installFailingSandboxSync();

      try {
        await prepareRunningSandbox();

        await assertFirewallSyncFailed(setFirewallMode("learning"));

        const firewall = await getFirewallState();
        assert.equal(firewall.mode, "learning");
        assert.equal(sandbox.updateCalls, 1);
      } finally {
        sandbox.restore();
      }
    });
  },
);

test(
  "approveDomains throws FIREWALL_SYNC_FAILED when sandbox sync fails after persisting allowlist update",
  async () => {
    await withFirewallTestStore(async () => {
      const sandbox = installFailingSandboxSync();

      try {
        await prepareRunningSandbox();

        await assertFirewallSyncFailed(approveDomains(["api.openai.com"]));

        const firewall = await getFirewallState();
        assert.deepEqual(firewall.allowlist, ["api.openai.com"]);
        assert.equal(sandbox.updateCalls, 1);
      } finally {
        sandbox.restore();
      }
    });
  },
);

test(
  "removeDomains throws FIREWALL_SYNC_FAILED when sandbox sync fails after persisting allowlist removal",
  async () => {
    await withFirewallTestStore(async () => {
      const sandbox = installFailingSandboxSync();

      try {
        await prepareRunningSandbox((meta) => {
          meta.firewall.allowlist = ["api.openai.com", "vercel.com"];
        });

        await assertFirewallSyncFailed(removeDomains(["api.openai.com"]));

        const firewall = await getFirewallState();
        assert.deepEqual(firewall.allowlist, ["vercel.com"]);
        assert.equal(sandbox.updateCalls, 1);
      } finally {
        sandbox.restore();
      }
    });
  },
);

test(
  "promoteLearnedDomainsToEnforcing throws FIREWALL_SYNC_FAILED when sandbox sync fails after persisting promotion",
  async () => {
    await withFirewallTestStore(async () => {
      const sandbox = installFailingSandboxSync();

      try {
        await prepareRunningSandbox((meta) => {
          meta.firewall.mode = "learning";
          meta.firewall.learned = [
            {
              domain: "api.openai.com",
              firstSeenAt: 1,
              lastSeenAt: 2,
              hitCount: 3,
            },
          ];
        });

        await assertFirewallSyncFailed(promoteLearnedDomainsToEnforcing());

        const firewall = await getFirewallState();
        assert.equal(firewall.mode, "enforcing");
        assert.deepEqual(firewall.allowlist, ["api.openai.com"]);
        assert.deepEqual(firewall.learned, []);
        assert.equal(sandbox.updateCalls, 1);
      } finally {
        sandbox.restore();
      }
    });
  },
);
