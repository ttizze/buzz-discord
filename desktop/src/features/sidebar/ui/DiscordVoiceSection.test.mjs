import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pickDiscordVoiceChannel } from "./DiscordVoiceSection.tsx";

function channel(id, name, channelType = "stream", archivedAt = null) {
  return { id, name, channelType, archivedAt };
}

describe("pickDiscordVoiceChannel", () => {
  it("uses the selected stream", () => {
    const channels = [channel("general", "general"), channel("dev", "dev")];
    assert.equal(pickDiscordVoiceChannel(channels, "dev")?.id, "dev");
  });

  it("falls back to general when the selection is not a stream", () => {
    const channels = [
      channel("general", "General"),
      channel("forum", "ideas", "forum"),
    ];
    assert.equal(pickDiscordVoiceChannel(channels, "forum")?.id, "general");
  });

  it("ignores archived streams and returns null without a usable room", () => {
    const channels = [
      channel("old", "general", "stream", "2026-07-31T00:00:00Z"),
      channel("forum", "ideas", "forum"),
    ];
    assert.equal(pickDiscordVoiceChannel(channels, "old"), null);
  });
});
