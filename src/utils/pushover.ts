import axios from "axios";
import logger from "./logger";
import secrets from "./secrets";

async function sendNotification(message: string | null, options = {}) {
  logger.debug(`Sending notification to Pushover: ${message}`);
  const {
    data: { status },
  } = await axios.postForm("https://api.pushover.net/1/messages.json", {
    token: secrets.PUSHOVER_TOKEN,
    user: secrets.PUSHOVER_USER,
    message,
    ...options,
  });
  if (status !== 1) {
    logger.error(`Failed to send notification to Pushover: ${status}`);
  }
  logger.debug(`Sent notification to Pushover`);
}

export { sendNotification };
