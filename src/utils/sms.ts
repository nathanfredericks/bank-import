import logger from "./logger.js";
import secrets from "./secrets.js";

async function sendSMS(phoneNumber: string, message: string) {
  logger.debug(`Sending MMS to ${phoneNumber}`);
  const response = await fetch(
    "https://voip.ms/api/v1/rest.php?" +
      new URLSearchParams({
        api_username: secrets.VOIPMS_API_USERNAME || "",
        api_password: secrets.VOIPMS_API_PASSWORD || "",
        method: "sendSMS",
        did: secrets.VOIPMS_DID || "",
        dst: phoneNumber,
        message,
      }).toString(),
  );
  if (!response.ok) {
    logger.error("Failed to send SMS");
    throw new Error("Failed to send SMS");
  }
  logger.debug("Sent MMS");
}

export { sendSMS };
