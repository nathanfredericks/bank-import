import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { BankName } from "../banks/types";
import env from "./env";
import { deleteFile, downloadFile, uploadFile } from "./s3";

function stateKey(bank: BankName) {
  return `browser-state/${bank}.json`;
}

function statePath(bank: BankName) {
  return path.join("/tmp", `bank-import-${bank}-storage-state.json`);
}

async function restoreBrowserState(bank: BankName) {
  if (!env.AWS_S3_SESSION_STATES_BUCKET_NAME) return undefined;
  const filePath = statePath(bank);
  try {
    await downloadFile(
      env.AWS_S3_SESSION_STATES_BUCKET_NAME,
      stateKey(bank),
      filePath,
    );
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "NoSuchKey" || name === "NotFound") return undefined;
    throw error;
  }
}

async function saveBrowserState(bank: BankName, state: unknown) {
  if (!env.AWS_S3_SESSION_STATES_BUCKET_NAME) return;
  await uploadFile(
    env.AWS_S3_SESSION_STATES_BUCKET_NAME,
    stateKey(bank),
    "application/json",
    JSON.stringify(state),
  );
}

async function clearBrowserState(bank: BankName) {
  if (!env.AWS_S3_SESSION_STATES_BUCKET_NAME) return;
  await deleteFile(env.AWS_S3_SESSION_STATES_BUCKET_NAME, stateKey(bank));
  await rm(statePath(bank), { force: true });
}

export { clearBrowserState, restoreBrowserState, saveBrowserState };
