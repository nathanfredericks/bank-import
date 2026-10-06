export async function executeJob(
  run: () => Promise<void>,
  notify: (message: string) => Promise<void>,
  log: (message: string) => void,
): Promise<number> {
  try {
    await run();
    return 0;
  } catch (error) {
    const message = failureMessage(error);
    log(message);
    try {
      await notify(message);
    } catch {
      log(
        "Failure notification could not be delivered; check AWS logs and credentials.",
      );
    }
    return 1;
  }
}

export function failureMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown bank import error";
  const firstLine = (error.stack ?? error.message).split(/\r?\n/, 1)[0]?.trim();
  return firstLine || `${error.name}: Bank import failed`;
}
