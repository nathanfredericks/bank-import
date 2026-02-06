import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import logger from "./logger";

async function uploadFile(
  basePath: string,
  key?: string,
  _contentType?: string,
  body?: Buffer | Uint8Array | string,
) {
  if (!key) {
    throw new Error("Key is required for upload");
  }
  const filePath = join(basePath, key);
  logger.debug(`Uploading file to: ${filePath}`);

  await mkdir(dirname(filePath), { recursive: true });

  if (body instanceof Buffer || body instanceof Uint8Array) {
    await writeFile(filePath, body);
  } else if (typeof body === "string") {
    await writeFile(filePath, body);
  } else {
    throw new Error("Unsupported body type for upload");
  }

  logger.debug(`Uploaded file to: ${filePath}`);
}

async function downloadFile(
  basePath: string,
  key: string,
  destinationPath: string,
): Promise<void> {
  const filePath = join(basePath, key);
  logger.debug(`Downloading file from: ${filePath}`);

  const content = await readFile(filePath);
  await writeFile(destinationPath, content);

  logger.debug(`Successfully downloaded file from: ${filePath}`);
}

async function deleteFile(basePath: string, key: string): Promise<void> {
  const filePath = join(basePath, key);
  logger.debug(`Deleting file: ${filePath}`);
  await unlink(filePath);
  logger.debug(`Successfully deleted file: ${filePath}`);
}

export { deleteFile, downloadFile, uploadFile };
