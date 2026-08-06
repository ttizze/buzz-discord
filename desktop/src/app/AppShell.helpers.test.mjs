import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveShellRoute,
  shouldBounceForChannelNotification,
} from "./AppShell.helpers.ts";

test("deriveShellRoute exposes the selected project", () => {
  assert.deepEqual(deriveShellRoute("/projects/owner%3Abuzz"), {
    selectedChannelId: null,
    selectedProjectId: "owner:buzz",
    selectedView: "projects",
  });
});

test("deriveShellRoute leaves the projects overview unselected", () => {
  assert.deepEqual(deriveShellRoute("/projects"), {
    selectedChannelId: null,
    selectedProjectId: null,
    selectedView: "projects",
  });
});

test("shouldBounceForChannelNotification_allowsTopLevelChannelMessages", () => {
  assert.equal(shouldBounceForChannelNotification([["h", "channel"]]), true);
});

test("shouldBounceForChannelNotification_suppressesThreadReplies", () => {
  assert.equal(
    shouldBounceForChannelNotification([
      ["h", "channel"],
      ["e", "root", "", "reply"],
    ]),
    false,
  );
});

test("shouldBounceForChannelNotification_allowsBroadcastReplies", () => {
  assert.equal(
    shouldBounceForChannelNotification([
      ["h", "channel"],
      ["e", "root", "", "reply"],
      ["broadcast", "1"],
    ]),
    true,
  );
});
