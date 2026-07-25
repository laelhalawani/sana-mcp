import { sana } from "../../../src/tools/dispatch.js";
import { contractEvents } from "./auth-model.js";

const scenario = process.env.SANA_TEST_AUTH_SCENARIO;
if (!scenario) throw new Error("SANA_TEST_AUTH_SCENARIO is required");

const recording = scenario === "cache-recording-changed-after-await";
const search = scenario === "cache-search-changed-after-await";
const output = await sana(
  recording ? "recording" : search ? "search" : "list",
  recording
    ? { meeting_id: "meeting-alpha" }
    : search
      ? { query: "contract" }
      : {},
);

console.log(JSON.stringify({
  output,
  events: contractEvents().filter(
    (event) =>
      event === "search-read-complete" ||
      event === "search-yield" ||
      event === "recording-fetch-complete" ||
      event.startsWith("cache-mutation:") ||
      event === "cache-guard-rejected",
  ),
}));
