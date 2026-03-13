/**
 * Tests for SandboxController — the injectable interface over @vercel/sandbox.
 *
 * Validates the _setSandboxControllerForTesting swap mechanism and
 * verifies that FakeSandboxHandle conforms to the SandboxHandle interface shape.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  getSandboxController,
  _setSandboxControllerForTesting,
  type SandboxController,
  type SandboxHandle,
  type CommandResult,
  type SnapshotResult,
  type CreateParams,
} from "@/server/sandbox/controller";
import {
  FakeSandboxController,
  FakeSandboxHandle,
  type SandboxEvent,
} from "@/test-utils/fake-sandbox-controller";

test("controller: getSandboxController returns real controller by default", () => {
  // Reset to real controller first
  _setSandboxControllerForTesting(null);
  const controller = getSandboxController();
  assert.ok(controller, "should return a controller");
  assert.equal(typeof controller.create, "function", "create should be a function");
  assert.equal(typeof controller.get, "function", "get should be a function");
});

test("controller: _setSandboxControllerForTesting swaps in fake controller", () => {
  const fake = new FakeSandboxController();
  _setSandboxControllerForTesting(fake);
  assert.strictEqual(getSandboxController(), fake);
  _setSandboxControllerForTesting(null);
  assert.notStrictEqual(getSandboxController(), fake, "null should restore real controller");
});

test("controller: _setSandboxControllerForTesting(null) restores real controller", () => {
  const fake = new FakeSandboxController();
  _setSandboxControllerForTesting(fake);
  _setSandboxControllerForTesting(null);
  const restored = getSandboxController();
  // Real controller should not be the fake
  assert.notStrictEqual(restored, fake);
});

test("controller: FakeSandboxHandle conforms to SandboxHandle interface", async () => {
  const events: SandboxEvent[] = [];
  const handle: SandboxHandle = new FakeSandboxHandle("sbx-test", events);

  // sandboxId
  assert.equal(handle.sandboxId, "sbx-test");

  // runCommand
  const result = await handle.runCommand("echo", ["hello"]);
  assert.equal(typeof result.exitCode, "number");
  assert.equal(typeof (await result.output()), "string");

  // writeFiles
  await handle.writeFiles([{ path: "test.txt", content: Buffer.from("hello") }]);

  // domain
  const domain = handle.domain(3000);
  assert.equal(typeof domain, "string");
  assert.ok(domain.includes("sbx-test"), "domain should contain sandbox id");

  // snapshot
  const snap = await handle.snapshot();
  assert.equal(typeof snap.snapshotId, "string");
  assert.ok(snap.snapshotId.includes("sbx-test"));

  // extendTimeout
  await handle.extendTimeout(60_000);

  // updateNetworkPolicy
  const policy = await handle.updateNetworkPolicy("allow-all");
  assert.equal(policy, "allow-all");
});

test("controller: FakeSandboxController.create tracks events", async () => {
  const controller = new FakeSandboxController();
  const handle = await controller.create({ ports: [3000] });

  assert.ok(handle.sandboxId.startsWith("sbx-fake-"));
  assert.equal(controller.created.length, 1);
  assert.equal(controller.events.length, 1);
  assert.equal(controller.events[0]!.kind, "create");
});

test("controller: FakeSandboxController.create with snapshot source records restore event", async () => {
  const controller = new FakeSandboxController();
  const params: CreateParams = {
    ports: [3000],
    source: { type: "snapshot", snapshotId: "snap-123" },
  };
  await controller.create(params);

  assert.equal(controller.events[0]!.kind, "restore");
  assert.deepEqual(controller.events[0]!.detail, { snapshotId: "snap-123" });
});

test("controller: FakeSandboxController.get returns tracked handle", async () => {
  const controller = new FakeSandboxController();
  const created = await controller.create({});
  const retrieved = await controller.get({ sandboxId: created.sandboxId });

  assert.strictEqual(retrieved, created);
  assert.deepEqual(controller.retrieved, [created.sandboxId]);
});

test("controller: FakeSandboxController.get creates new handle for unknown id", async () => {
  const controller = new FakeSandboxController();
  const handle = await controller.get({ sandboxId: "sbx-unknown" });

  assert.equal(handle.sandboxId, "sbx-unknown");
  assert.deepEqual(controller.retrieved, ["sbx-unknown"]);
});

test("controller: FakeSandboxHandle.responders override default command result", async () => {
  const events: SandboxEvent[] = [];
  const handle = new FakeSandboxHandle("sbx-resp", events);

  handle.responders.push((cmd, args) => {
    if (cmd === "node") {
      return { exitCode: 42, output: async () => "custom output" };
    }
    return undefined;
  });

  const nodeResult = await handle.runCommand("node", ["-e", "1"]);
  assert.equal(nodeResult.exitCode, 42);
  assert.equal(await nodeResult.output(), "custom output");

  // Non-matching commands fall through to default
  const echoResult = await handle.runCommand("echo", ["hi"]);
  assert.equal(echoResult.exitCode, 0);
});

test("controller: FakeSandboxHandle tracks all operations in event log", async () => {
  const events: SandboxEvent[] = [];
  const handle = new FakeSandboxHandle("sbx-log", events);

  await handle.runCommand("ls", ["-la"]);
  await handle.writeFiles([{ path: "a.txt", content: Buffer.from("a") }]);
  await handle.extendTimeout(5000);
  await handle.updateNetworkPolicy({ allow: ["example.com"] });
  await handle.snapshot();

  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds, [
    "command",
    "write_files",
    "extend_timeout",
    "update_network_policy",
    "snapshot",
  ]);
});

test("controller: FakeSandboxController.eventsOfKind filters correctly", async () => {
  const controller = new FakeSandboxController();
  const h1 = await controller.create({});
  await h1.runCommand("echo", []);
  await h1.snapshot();
  const h2 = await controller.create({});
  await h2.runCommand("ls", []);

  assert.equal(controller.eventsOfKind("create").length, 2);
  assert.equal(controller.eventsOfKind("command").length, 2);
  assert.equal(controller.eventsOfKind("snapshot").length, 1);
});

test("controller: type exports are accessible", () => {
  // Compile-time check — these types should be importable
  const _params: CreateParams = { ports: [3000] };
  const _result: CommandResult = { exitCode: 0, output: async () => "" };
  const _snap: SnapshotResult = { snapshotId: "snap-1" };
  assert.ok(true, "type exports are accessible");
});
