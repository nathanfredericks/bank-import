import { executeJob } from "./job";
import logger from "./utils/logger";

// Dynamic imports allow configuration, secret-loading, and startup failures to be caught.
process.exitCode = await executeJob(
  async () => {
    const { run } = await import("./run");
    await run();
  },
  async (message) => {
    const { sendNotification } = await import("./utils/pushover");
    await sendNotification(message, {
      title: "Bank import failed",
      priority: -1,
    });
  },
  (message) => logger.error(message),
);
