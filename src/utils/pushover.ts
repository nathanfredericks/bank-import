import axios from "axios";
import secrets from "./secrets.js";

async function sendNotification(message: string, options = {}) {
  console.log(`Sending notification to Pushover: ${message}`);
  const {
    data: { status },
  } = await axios.postForm("https://api.pushover.net/1/messages.json", {
    token: secrets.PUSHOVER_TOKEN,
    user: secrets.PUSHOVER_USER,
    message,
    ...options,
  });
  if (status !== 1) {
    throw new Error(`Failed to send notification to Pushover: ${status}`);
  }
  console.log(`Sent notification to Pushover`);
}

export { sendNotification };
