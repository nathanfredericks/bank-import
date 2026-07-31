import { BankName } from "../banks/types";

export type MfaOption = {
  id: string;
  label: string;
};

export type MfaStage =
  | "awaiting_connection"
  | "starting_recovery"
  | "awaiting_method"
  | "awaiting_code"
  | "submitting_code"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled";

export type AuthSession = {
  id: string;
  bank: BankName;
  tokenHash: string;
  controlSecret: string;
  options?: MfaOption[];
  connectionId?: string;
  taskArn?: string;
  stage: MfaStage;
  createdAt: string;
  expiresAt: number;
  ttl: number;
  error?: string;
};

export type MfaHandoff = {
  waitForMethod: () => Promise<string>;
  waitForCode: () => Promise<string>;
  requestCode: () => void;
  retryCode: (message: string) => void;
  complete: () => Promise<void>;
  fail: (message: string) => Promise<void>;
};
