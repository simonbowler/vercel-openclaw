/**
 * Tests for channels/keys.ts — queue key generation for all channel names.
 *
 * Validates correct prefix, structure, and per-channel uniqueness.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ChannelName } from "@/shared/channels";
import {
  channelQueueKey,
  channelProcessingKey,
  channelFailedKey,
  channelDrainLockKey,
  channelSessionHistoryKey,
  channelDedupKey,
} from "@/server/channels/keys";

const CHANNELS: ChannelName[] = ["slack", "telegram", "discord"];
const PREFIX = "openclaw-single";

// ---------------------------------------------------------------------------
// channelQueueKey
// ---------------------------------------------------------------------------

test("keys: channelQueueKey uses correct prefix and suffix", () => {
  for (const ch of CHANNELS) {
    const key = channelQueueKey(ch);
    assert.equal(key, `${PREFIX}:channels:${ch}:queue`);
  }
});

// ---------------------------------------------------------------------------
// channelProcessingKey
// ---------------------------------------------------------------------------

test("keys: channelProcessingKey uses correct prefix and suffix", () => {
  for (const ch of CHANNELS) {
    const key = channelProcessingKey(ch);
    assert.equal(key, `${PREFIX}:channels:${ch}:processing`);
  }
});

// ---------------------------------------------------------------------------
// channelFailedKey
// ---------------------------------------------------------------------------

test("keys: channelFailedKey uses correct prefix and suffix", () => {
  for (const ch of CHANNELS) {
    const key = channelFailedKey(ch);
    assert.equal(key, `${PREFIX}:channels:${ch}:failed`);
  }
});

// ---------------------------------------------------------------------------
// channelDrainLockKey
// ---------------------------------------------------------------------------

test("keys: channelDrainLockKey uses correct prefix and suffix", () => {
  for (const ch of CHANNELS) {
    const key = channelDrainLockKey(ch);
    assert.equal(key, `${PREFIX}:channels:${ch}:drain-lock`);
  }
});

// ---------------------------------------------------------------------------
// channelSessionHistoryKey
// ---------------------------------------------------------------------------

test("keys: channelSessionHistoryKey includes channel and session key", () => {
  for (const ch of CHANNELS) {
    const key = channelSessionHistoryKey(ch, "user-123");
    assert.equal(key, `${PREFIX}:channels:${ch}:history:user-123`);
  }
});

test("keys: channelSessionHistoryKey handles complex session keys", () => {
  const key = channelSessionHistoryKey("slack", "T123:C456:U789");
  assert.equal(key, `${PREFIX}:channels:slack:history:T123:C456:U789`);
});

// ---------------------------------------------------------------------------
// channelDedupKey
// ---------------------------------------------------------------------------

test("keys: channelDedupKey includes channel and dedup id", () => {
  for (const ch of CHANNELS) {
    const key = channelDedupKey(ch, "abc-123");
    assert.equal(key, `${PREFIX}:channels:${ch}:dedup:abc-123`);
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
  // 6 key functions × 3 channels = 18 unique keys
  assert.equal(allKeys.size, 18);
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
