import { expect, test } from "bun:test";
import { executeJob, failureMessage } from "../src/job";

test("uses the first line of the original error", () => {
  const error = new Error("Verification email timed out");
  error.stack = "Error: Verification email timed out\n    at private details";
  expect(failureMessage(error)).toBe("Error: Verification email timed out");
});

test("passes detailed failures to the notifier and exits nonzero", async () => {
  const notifications: string[] = [];
  const logs: string[] = [];
  const exitCode = await executeJob(
    async () => {
      throw new Error("NBDB account discovery failed");
    },
    async (message) => {
      notifications.push(message);
    },
    (message) => logs.push(message),
  );

  expect(exitCode).toBe(1);
  expect(notifications).toEqual(["Error: NBDB account discovery failed"]);
  expect(logs).toEqual(["Error: NBDB account discovery failed"]);
});

test("retains a safe fallback for non-Error failures", () => {
  expect(failureMessage({ secret: "must not be rendered" })).toBe(
    "Unknown bank import error",
  );
});
