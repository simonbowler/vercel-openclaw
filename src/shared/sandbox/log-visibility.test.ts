import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  isSandboxLogReadableStatus,
  canReadSandboxLogs,
  isSandboxLifecyclePending,
} from "@/shared/sandbox/log-visibility";
import type { SingleStatus } from "@/shared/types";

describe("isSandboxLogReadableStatus", () => {
  const readable: SingleStatus[] = ["setup", "booting", "restoring", "running"];
  const notReadable: SingleStatus[] = ["creating", "stopped", "error", "uninitialized"];

  for (const status of readable) {
    test(`returns true for "${status}"`, () => {
      assert.equal(isSandboxLogReadableStatus(status), true);
    });
  }

  for (const status of notReadable) {
    test(`returns false for "${status}"`, () => {
      assert.equal(isSandboxLogReadableStatus(status), false);
    });
  }
});

describe("canReadSandboxLogs", () => {
  test("returns true when status is readable and sandboxId exists", () => {
    assert.equal(canReadSandboxLogs("running", "sbx-123"), true);
  });

  test("returns false when sandboxId is null", () => {
    assert.equal(canReadSandboxLogs("running", null), false);
  });

  test("returns false when status is not readable even with sandboxId", () => {
    assert.equal(canReadSandboxLogs("stopped", "sbx-123"), false);
  });
});

describe("isSandboxLifecyclePending", () => {
  const pending: SingleStatus[] = ["creating", "setup", "booting", "restoring"];
  const notPending: SingleStatus[] = ["uninitialized", "running", "stopped", "error"];

  for (const status of pending) {
    test(`returns true for "${status}"`, () => {
      assert.equal(isSandboxLifecyclePending(status), true);
    });
  }

  for (const status of notPending) {
    test(`returns false for "${status}"`, () => {
      assert.equal(isSandboxLifecyclePending(status), false);
    });
  }
});
