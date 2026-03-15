#!/usr/bin/env node
import { existsSync } from "node:fs";

const required = [
  "src/app/api/queues/channels/slack/route.ts",
  "src/app/api/queues/channels/telegram/route.ts",
  "src/app/api/queues/channels/discord/route.ts",
];

const missing = required.filter((file) => !existsSync(file));

if (missing.length > 0) {
  const result = {
    ok: false,
    code: "MISSING_QUEUE_CONSUMER_ROUTES",
    missing,
    checked: required,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
}

const result = {
  ok: true,
  checked: required,
};
console.log(JSON.stringify(result, null, 2));
