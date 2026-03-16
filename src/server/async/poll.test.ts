import assert from "node:assert/strict";
import { test } from "node:test";

import { pollUntil } from "@/server/async/poll";

test("pollUntil returns when step signals done", async () => {
  let attempts = 0;

  const result = await pollUntil<string>({
    label: "unit.ready",
    timeoutMs: 50,
    initialDelayMs: 1,
    sleep: async () => {},
    step: async () => {
      attempts += 1;
      return attempts === 3
        ? { done: true, result: "ready" }
        : { done: false };
    },
    timeoutError: () => new Error("unexpected timeout"),
  });

  assert.equal(result, "ready");
  assert.equal(attempts, 3);
});

test("pollUntil includes last state in timeout error", async () => {
  await assert.rejects(
    () =>
      pollUntil({
        label: "unit.timeout",
        timeoutMs: 2,
        initialDelayMs: 1,
        sleep: async () => {},
        state: { status: "booting" },
        step: async ({ state }) => ({ done: false, state }),
        timeoutError: ({ state }) =>
          new Error(
            `timed out with ${(state as { status: string })?.status ?? "unknown"}`,
          ),
      }),
    /timed out with booting/,
  );
});

test("pollUntil respects step-level delayMs override", async () => {
  const sleepCalls: number[] = [];
  let attempts = 0;

  await pollUntil<string>({
    label: "unit.delay",
    timeoutMs: 1000,
    initialDelayMs: 100,
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
    step: async () => {
      attempts += 1;
      if (attempts === 2) return { done: true, result: "ok" };
      return { done: false, delayMs: 42 };
    },
    timeoutError: () => new Error("timeout"),
  });

  assert.equal(sleepCalls[0], 42);
});
