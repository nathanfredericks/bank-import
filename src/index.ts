import { BankName, bankNames } from "./banks/types";
import { executeJob } from "./job";
import logger from "./utils/logger";

const bankName = Object.values(BankName).includes(process.env.BANK as BankName)
  ? bankNames[process.env.BANK as BankName]
  : "Bank Import";

// Dynamic imports allow configuration, secret-loading, and startup failures to be caught.
process.exitCode = await executeJob(
  async () => {
    const { run } = await import("./run");
    await run();
  },
  async (message) => {
    if (process.env.BANK_JOB_ID) return; // Workflow owns notification and lease cleanup.
    const { sendNotification } = await import("./utils/pushover");
    await sendNotification(message, {
      title: `Error Logging Into ${bankName}`,
      url: "https://console.aws.amazon.com/cloudwatch/home#logsV2:log-groups",
      url_title: "Open AWS Console",
      priority: -1,
    });
  },
  (message) => logger.error(message),
);
// A stalled browser shutdown must not prevent the coordinator from reading an
// already published result. Managed workers exit after their callback completes.
if (process.env.BANK === BankName.EQBank || process.env.BANK_JOB_ID)
  process.exit(process.exitCode ?? 0);
