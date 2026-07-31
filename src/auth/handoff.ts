import { BankName, bankNames } from "../banks/types";
import { sendNotification } from "../utils/pushover";
import { createSession, getSession, setStage, updateSession } from "./sessions";
import { MfaHandoff, MfaOption, MfaStage } from "./types";

const responseWindowMs = 60_000;
const activeWindowMs = 10 * 60_000;
let activeHandoff: MfaHandoff | undefined;

class MfaHandoffEndedError extends Error {
  constructor(
    readonly outcome: "timed_out" | "cancelled",
    message: string,
  ) {
    super(message);
    this.name = "MfaHandoffEndedError";
  }
}

type PendingValue = {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
};

function waitFor(
  register: (pending: PendingValue) => void,
  timeoutMs: number,
  timeoutMessage: string,
) {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new MfaHandoffEndedError("timed_out", timeoutMessage)),
      timeoutMs,
    );
    register({
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
  });
}

async function waitForConnection(id: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await getSession(id);
    if (session?.stage !== "awaiting_connection") return;
    await Bun.sleep(1_000);
  }
  throw new MfaHandoffEndedError(
    "timed_out",
    "MFA reconnect link was not opened in time",
  );
}

async function presentMfaChallenge(bank: BankName, options: MfaOption[]) {
  const resumedSessionId = Bun.env.AUTH_SESSION_ID;
  const created = resumedSessionId ? undefined : await createSession(bank);
  const session = resumedSessionId
    ? await getSession(resumedSessionId)
    : created?.session;
  if (!session || session.bank !== bank || session.expiresAt < Date.now()) {
    throw new Error("MFA reconnect session is unavailable or expired");
  }
  const websocketUrl = Bun.env.AUTH_CONTROL_WEBSOCKET_URL;
  if (!websocketUrl) throw new Error("AUTH_CONTROL_WEBSOCKET_URL is required");

  let stage: MfaStage = "awaiting_connection";
  let error: string | undefined;
  let methodPending: PendingValue | undefined;
  let codePending: PendingValue | undefined;
  let queuedMethod: string | undefined;
  let queuedCode: string | undefined;
  const socket = new WebSocket(
    `${websocketUrl}?sessionId=${encodeURIComponent(session.id)}&secret=${encodeURIComponent(session.controlSecret)}`,
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("MFA control channel did not connect")),
      15_000,
    );
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("MFA control channel failed"));
    };
  });
  socket.onmessage = (event) => {
    const command = JSON.parse(String(event.data)) as {
      type: "select" | "code" | "cancel";
      optionId?: string;
      code?: string;
    };
    if (
      command.type === "select" &&
      command.optionId &&
      options.some((option) => option.id === command.optionId)
    ) {
      stage = "awaiting_code";
      if (methodPending) {
        methodPending.resolve(command.optionId);
        methodPending = undefined;
      } else {
        queuedMethod = command.optionId;
      }
      void setStage(session.id, stage);
    }
    if (
      command.type === "code" &&
      command.code &&
      /^\d{4,12}$/.test(command.code)
    ) {
      stage = "submitting_code";
      if (codePending) {
        codePending.resolve(command.code);
        codePending = undefined;
      } else {
        queuedCode = command.code;
      }
      void setStage(session.id, stage);
    }
    if (command.type === "cancel") {
      stage = "cancelled";
      void setStage(session.id, stage, "Reconnect was cancelled");
      const cancelled = new MfaHandoffEndedError(
        "cancelled",
        "MFA reconnect was cancelled",
      );
      methodPending?.reject(cancelled);
      codePending?.reject(cancelled);
    }
  };

  await updateSession(session.id, { options, stage });
  if (created) {
    const portalUrl = Bun.env.AUTH_PORTAL_URL;
    if (!portalUrl)
      throw new Error("AUTH_PORTAL_URL is required for MFA handoff");
    const bankName = bankNames[bank];
    await sendNotification(
      `Two-factor verification is required to login to ${bankName}.`,
      {
        title: "Two-Factor Authentication Required",
        url: `${portalUrl.replace(/\/$/, "")}/connect/${created.token}`,
        url_title: "Continue bank login",
        priority: 1,
      },
    );
  }

  try {
    if (resumedSessionId) {
      stage = "awaiting_method";
      await setStage(session.id, stage);
    } else {
      await waitForConnection(session.id, responseWindowMs);
      stage = "awaiting_method";
      await setStage(session.id, stage);
    }
    const activeDeadline = Date.now() + activeWindowMs;
    const handoff: MfaHandoff = {
      waitForMethod: () => {
        if (queuedMethod) {
          const method = queuedMethod;
          queuedMethod = undefined;
          return Promise.resolve(method);
        }
        return waitFor(
          (pending) => (methodPending = pending),
          Math.max(0, activeDeadline - Date.now()),
          "MFA reconnect timed out",
        );
      },
      requestCode: () => undefined,
      waitForCode: () => {
        if (queuedCode) {
          const code = queuedCode;
          queuedCode = undefined;
          return Promise.resolve(code);
        }
        return waitFor(
          (pending) => (codePending = pending),
          Math.max(0, activeDeadline - Date.now()),
          "MFA reconnect timed out",
        );
      },
      retryCode: (message) => {
        stage = "awaiting_code";
        error = message;
        void setStage(session.id, stage, message);
      },
      complete: async () => {
        stage = "completed";
        await setStage(session.id, stage);
        socket.close();
        activeHandoff = undefined;
      },
      fail: async (message) => {
        stage = "failed";
        error = message;
        await setStage(session.id, stage, error);
        socket.close();
        activeHandoff = undefined;
      },
    };
    activeHandoff = handoff;
    return handoff;
  } catch (error) {
    socket.close();
    activeHandoff = undefined;
    if (error instanceof MfaHandoffEndedError) {
      await setStage(session.id, error.outcome, error.message);
    } else {
      await setStage(
        session.id,
        "failed",
        "Secure verification could not start",
      );
    }
    throw error;
  }
}

async function failActiveMfaHandoff(message: string) {
  await activeHandoff?.fail(message);
}

function isExpectedMfaHandoffEnd(error: unknown) {
  return error instanceof MfaHandoffEndedError;
}

export { failActiveMfaHandoff, isExpectedMfaHandoffEnd, presentMfaChallenge };
