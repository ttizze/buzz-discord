import assert from "node:assert/strict";
import test from "node:test";

import { resolveExpandedProjectId } from "./projectSidebar.ts";

const PROJECTS = [
  { id: "owner:buzz", projectChannelId: "channel-buzz" },
  { id: "owner:cinema", projectChannelId: "channel-cinema" },
];

test("project route selects the matching project", () => {
  assert.equal(
    resolveExpandedProjectId(PROJECTS, "owner:cinema", null),
    "owner:cinema",
  );
});

test("linked channel keeps its project expanded", () => {
  assert.equal(
    resolveExpandedProjectId(PROJECTS, null, "channel-cinema"),
    "owner:cinema",
  );
});

test("unrelated routes leave every project collapsed", () => {
  assert.equal(
    resolveExpandedProjectId(PROJECTS, "missing", "unlinked-channel"),
    null,
  );
});

test("the projects overview can expand the first project", () => {
  assert.equal(
    resolveExpandedProjectId(PROJECTS, null, null, true),
    "owner:buzz",
  );
});

test("an empty project list has no expanded project", () => {
  assert.equal(resolveExpandedProjectId([], null, null), null);
});
