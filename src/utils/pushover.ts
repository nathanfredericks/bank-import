import { z } from "zod";
import logger from "./logger";
import secrets from "./secrets";

const PushoverResponse = z.object({
  status: z.number(),
  request: z.string().optional(),
  errors: z.array(z.string()).optional(),
});

type PushoverOptions = {
  title?: string;
  url?: string;
  url_title?: string;
  priority?: number;
  sound?: string;
  device?: string;
  timestamp?: number;
  [key: string]: string | number | undefined;
};

async function sendNotification(
  message: string | null,
  options: PushoverOptions = {},
) {
  logger.debug(`Sending notification to Pushover: ${message}`);

  const formData = new FormData();
  formData.append("token", secrets.PUSHOVER_TOKEN);
  formData.append("user", secrets.PUSHOVER_USER);
  if (message) {
    formData.append("message", message);
  }

  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) {
      formData.append(key, String(value));
    }
  }

  const response = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    body: formData,
  });

  const json = await response.json();
  const { status } = PushoverResponse.parse(json);

  if (status !== 1) {
    logger.error(`Failed to send notification to Pushover: ${status}`);
  }
  logger.debug(`Sent notification to Pushover`);
}

export { sendNotification };
