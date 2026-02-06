import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import logger from "./logger";

async function saveFile(
  basePath: string,
  key?: string,
  _contentType?: string,
  body?: Buffer | Uint8Array | string,
) {
  if (!key) {
    throw new Error("Key is required for save");
  }
  const filePath = join(basePath, key);
  logger.debug(`Saving file to: ${filePath}`);

  await mkdir(dirname(filePath), { recursive: true });

  if (body instanceof Buffer || body instanceof Uint8Array) {
    await writeFile(filePath, body);
  } else if (typeof body === "string") {
    await writeFile(filePath, body);
  } else {
    throw new Error("Unsupported body type for save");
  }

  logger.debug(`Saved file to: ${filePath}`);
}


export { saveFile };
