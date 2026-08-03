import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

const FEATURE_OVERRIDES_KEY = "buzz-feature-overrides-v1";

test.beforeEach(async ({ page }) => {
  await page.addInitScript((storageKey) => {
    window.localStorage.setItem(storageKey, JSON.stringify({ projects: true }));
  }, FEATURE_OVERRIDES_KEY);
  await installMockBridge(page);
});

test("an empty relay can create its first project", async ({ page }) => {
  await page.addInitScript(() => {
    window.__BUZZ_E2E_EMPTY_PROJECTS__ = true;
  });
  await page.goto("/");
  await page.getByTestId("open-projects-view").click();

  await expect(page.getByText("No projects yet")).toBeVisible();
  await page.getByTestId("empty-projects-create").click();
  await expect(page.getByTestId("create-project-dialog")).toBeVisible();
  await page.getByTestId("create-project-folder").click();
  await page.getByTestId("create-project-name").fill("First Project");
  await page.getByTestId("create-project-submit").click();

  await expect(
    page.getByText('Project "First Project" created.'),
  ).toBeVisible();
  await expect(page.getByTestId("project-card-first-project")).toContainText(
    "First Project",
  );
  await expect(page.getByTestId("project-sidebar-first-project")).toBeVisible();
});

test("projects own aligned channel and agent-task navigation", async ({
  page,
}) => {
  await page.goto("/");

  const tree = page.getByTestId("project-sidebar-tree");
  const streamList = page.getByTestId("stream-list");
  await expect(tree).toBeVisible();
  await expect(streamList.getByTestId("channel-general")).toBeVisible();
  await expect(streamList.getByTestId("channel-agents")).toBeVisible();
  await page.getByTestId("open-projects-view").click();
  await expect(page.getByTestId("project-sidebar-buzz")).toBeVisible();
  await expect(page.getByTestId("project-sidebar-relay-tools")).toBeVisible();
  await expect(page.getByTestId("project-sidebar-design-system")).toBeVisible();

  const channelsTitle = page.getByTestId("project-buzz-channels-title");
  const agentChatsTitle = page.getByTestId("project-buzz-agent-tasks-title");
  await expect(channelsTitle).toBeVisible();
  await expect(agentChatsTitle).toBeVisible();
  await expect(page.getByText("Release readiness review")).toBeVisible();
  await expect(
    page
      .getByTestId("project-buzz-channel-list")
      .getByTestId("channel-general"),
  ).toBeVisible();
  await expect(streamList.getByTestId("channel-general")).toHaveCount(0);
  await expect(streamList.getByTestId("channel-agents")).toBeVisible();

  await page.getByTestId("channel-general").click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Archive channel" }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Delete channel" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  const [channelsBox, agentChatsBox] = await Promise.all([
    channelsTitle.boundingBox(),
    agentChatsTitle.boundingBox(),
  ]);
  expect(channelsBox).not.toBeNull();
  expect(agentChatsBox).not.toBeNull();
  expect(Math.round(channelsBox?.x ?? -1)).toBe(
    Math.round(agentChatsBox?.x ?? -2),
  );

  await page.getByTestId("project-sidebar-relay-tools").click();
  await expect(
    page.getByTestId("project-relay-tools-channels-title"),
  ).toBeVisible();
  await expect(
    page
      .getByTestId("project-relay-tools-channel-list")
      .getByTestId("channel-agents"),
  ).toBeVisible();
  await expect(streamList.getByTestId("channel-agents")).toHaveCount(0);
  await expect(streamList.getByTestId("channel-general")).toBeVisible();
  await expect(page.getByTestId("project-buzz-channels-title")).toHaveCount(0);

  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/project-sidebar/project-sidebar.png",
  });
});

test("project agent task opens the Codex-style execution transcript", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("open-projects-view").click();
  await page.getByText("Release readiness review").click();

  const screen = page.getByTestId("project-agent-task-screen");
  await expect(screen).toBeVisible();
  await expect(screen.getByText("Release readiness review")).toBeVisible();
  await expect(
    screen.getByText(
      "Inspect the repository and verify whether the release is ready.",
    ),
  ).toBeVisible();
  await expect(screen.getByText("Plan")).toBeVisible();
  await expect(
    screen.getByText("just ci", { exact: false }).first(),
  ).toBeVisible();
  await expect(screen.getByText("Completed")).toBeVisible();

  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/project-sidebar/project-agent-task.png",
  });
});
