/**
 * Tests for channels/keys.ts — queue key generation for all channel names.
 *
 * Validates correct prefix, structure, and per-channel uniqueness.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ChannelName } from "@/shared/channels";
import { _setInstanceIdOverrideForTesting } from "@/server/env";
import {
  channelQueueKey,
  channelProcessingKey,
  channelFailedKey,
  channelDrainLockKey,
  channelSessionHistoryKey,
  channelDedupKey,
} from "@/server/channels/keys";
import {
  channelDedupKey as keyspaceChannelDedupKey,
  channelDrainLockKey as keyspaceChannelDrainLockKey,
  channelFailedKey as keyspaceChannelFailedKey,
  channelProcessingKey as keyspaceChannelProcessingKey,
  channelQueueKey as keyspaceChannelQueueKey,
  channelSessionHistoryKey as keyspaceChannelSessionHistoryKey,
} from "@/server/store/keyspace";

const CHANNELS: ChannelName[] = ["slack", "telegram", "discord", "whatsapp"];

function withInstanceId<T>(
  instanceId: string | null,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const original = process.env.OPENCLAW_INSTANCE_ID;
  if (instanceId === null) {
    delete process.env.OPENCLAW_INSTANCE_ID;
  } else {
    process.env.OPENCLAW_INSTANCE_ID = instanceId;
  }
  _setInstanceIdOverrideForTesting(null);

  const restore = () => {
    if (original === undefined) {
      delete process.env.OPENCLAW_INSTANCE_ID;
    } else {
      process.env.OPENCLAW_INSTANCE_ID = original;
    }
    _setInstanceIdOverrideForTesting(null);
  };

  let result: T | Promise<T>;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }

  if (result instanceof Promise) {
    return result.finally(restore);
  }

  restore();
  return result;
}

// ---------------------------------------------------------------------------
// channelQueueKey
// ---------------------------------------------------------------------------

test("keys: channelQueueKey uses correct prefix and suffix", () => {
  for (const ch of CHANNELS) {
    const key = channelQueueKey(ch);
    assert.equal(key, keyspaceChannelQueueKey(ch));
  }
});

// ---------------------------------------------------------------------------
// channelProcessingKey
// ---------------------------------------------------------------------------

test("keys: channelProcessingKey uses correct prefix and suffix", () => {
  for (const ch of CHANNELS) {
    const key = channelProcessingKey(ch);
    assert.equal(key, keyspaceChannelProcessingKey(ch));
  }
});

// ---------------------------------------------------------------------------
// channelFailedKey
// ---------------------------------------------------------------------------

test("keys: channelFailedKey uses correct prefix and suffix", () => {
  for (const ch of CHANNELS) {
    const key = channelFailedKey(ch);
    assert.equal(key, keyspaceChannelFailedKey(ch));
  }
});

// ---------------------------------------------------------------------------
// channelDrainLockKey
// ---------------------------------------------------------------------------

test("keys: channelDrainLockKey uses correct prefix and suffix", () => {
  for (const ch of CHANNELS) {
    const key = channelDrainLockKey(ch);
    assert.equal(key, keyspaceChannelDrainLockKey(ch));
  }
});

// ---------------------------------------------------------------------------
// channelSessionHistoryKey
// ---------------------------------------------------------------------------

test("keys: channelSessionHistoryKey includes channel and session key", () => {
  for (const ch of CHANNELS) {
    const key = channelSessionHistoryKey(ch, "user-123");
    assert.equal(key, keyspaceChannelSessionHistoryKey(ch, "user-123"));
  }
});

test("keys: channelSessionHistoryKey handles complex session keys", () => {
  const key = channelSessionHistoryKey("slack", "T123:C456:U789");
  assert.equal(
    key,
    keyspaceChannelSessionHistoryKey("slack", "T123:C456:U789"),
  );
});

// ---------------------------------------------------------------------------
// channelDedupKey
// ---------------------------------------------------------------------------

test("keys: channelDedupKey includes channel and dedup id", () => {
  for (const ch of CHANNELS) {
    const key = channelDedupKey(ch, "abc-123");
    assert.equal(key, keyspaceChannelDedupKey(ch, "abc-123"));
  }
});

// ---------------------------------------------------------------------------
// Uniqueness across channels
// ---------------------------------------------------------------------------

test("keys: all key functions produce unique keys per channel", () => {
  const allKeys = new Set<string>();
  for (const ch of CHANNELS) {
    allKeys.add(channelQueueKey(ch));
    allKeys.add(channelProcessingKey(ch));
    allKeys.add(channelFailedKey(ch));
    allKeys.add(channelDrainLockKey(ch));
    allKeys.add(channelSessionHistoryKey(ch, "s1"));
    allKeys.add(channelDedupKey(ch, "d1"));
  }
  // 6 key functions × 4 channels = 24 unique keys
  assert.equal(allKeys.size, 24);
});

// ---------------------------------------------------------------------------
// Uniqueness across key types for same channel
// ---------------------------------------------------------------------------

test("keys: different key functions for same channel produce distinct keys", () => {
  const ch: ChannelName = "slack";
  const keys = [
    channelQueueKey(ch),
    channelProcessingKey(ch),
    channelFailedKey(ch),
    channelDrainLockKey(ch),
    channelSessionHistoryKey(ch, "s"),
    channelDedupKey(ch, "d"),
  ];
  assert.equal(new Set(keys).size, keys.length, "all keys should be distinct");
});

test("keys: channel key exports follow custom instance id changes", () => {
  withInstanceId("fork-a", () => {
    assert.equal(channelQueueKey("slack"), "fork-a:channels:slack:queue");
    assert.equal(
      channelProcessingKey("slack"),
      "fork-a:channels:slack:processing",
    );
    assert.equal(channelFailedKey("slack"), "fork-a:channels:slack:failed");
    assert.equal(
      channelDrainLockKey("slack"),
      "fork-a:channels:slack:drain-lock",
    );
    assert.equal(
      channelSessionHistoryKey("slack", "session-1"),
      "fork-a:channels:slack:history:session-1",
    );
    assert.equal(
      channelDedupKey("slack", "dedup-1"),
      "fork-a:channels:slack:dedup:dedup-1",
    );

    _setInstanceIdOverrideForTesting("fork-b");
    assert.equal(channelQueueKey("slack"), "fork-b:channels:slack:queue");
  });
});
