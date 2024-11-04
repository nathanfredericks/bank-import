import axios from "axios";
import logger from "./logger.js";
import secrets from "./secrets.js";

async function sendSMS(phoneNumber: string, message: string) {
  logger.debug(`Sending MMS to ${phoneNumber}`);
  const {
    data: { status },
  } = await axios.get("https://voip.ms/api/v1/rest.php", {
    params: {
      api_username: secrets.VOIPMS_API_USERNAME || "",
      api_password: secrets.VOIPMS_API_PASSWORD || "",
      method: "sendSMS",
      did: secrets.VOIPMS_DID || "",
      dst: phoneNumber,
      message,
    },
  });
  if (status !== "success") {
    logger.error("Failed to send SMS");
    throw new Error("Failed to send SMS");
  }
  logger.debug(`Sent MMS to ${phoneNumber}`);
}

export { sendSMS };
