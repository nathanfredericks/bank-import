export async function executeJob(
  run: () => Promise<void>,
  notify: (message: string) => Promise<void>,
  log: (message: string) => void,
): Promise<number> {
  try {
    await run();
    return 0;
  } catch {
    // Upstream errors may contain tokens, email contents, or bank responses.
    const message =
      "Bank import failed. Check configuration, account mappings, and the private diagnostic trace.";
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
