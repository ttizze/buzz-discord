import assert from "node:assert/strict";
import test from "node:test";

import { parseProjectAgentTasks } from "./projectAgentTasks.mjs";

const repo = `30617:${"a".repeat(64)}:buzz`;
const channel = "11111111-1111-4111-8111-111111111111";
const agent = "b".repeat(64);
const user = "c".repeat(64);
const event = (id, kind, pubkey, content, created_at, tags = []) => ({
  id,
  kind,
  pubkey,
  content,
  created_at,
  tags: [["h", channel], ["a", repo], ...tags],
});

test("separates task roots and derives terminal status", () => {
  const root = "1".repeat(64);
  const other = "2".repeat(64);
  const tasks = parseProjectAgentTasks(
    [
      event(root, 43001, user, "Review the release", 1, [["p", agent]]),
      event("3".repeat(64), 43002, agent, "{}", 2, [["e", root, "", "root"]]),
      event("4".repeat(64), 43004, agent, "{}", 3, [["e", root, "", "root"]]),
      event(other, 43001, user, "Fix CI", 4, [["p", agent]]),
    ],
    repo,
    channel,
  );
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].id, other);
  assert.equal(tasks[0].status, "queued");
  assert.equal(tasks[1].status, "completed");
});

test("ignores lifecycle events not signed by the selected agent", () => {
  const root = "1".repeat(64);
  const tasks = parseProjectAgentTasks(
    [
      event(root, 43001, user, "Audit", 1, [["p", agent]]),
      event("3".repeat(64), 43006, user, "{}", 2, [["e", root, "", "root"]]),
    ],
    repo,
    channel,
  );
  assert.equal(tasks[0].status, "queued");
});
