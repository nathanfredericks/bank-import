import SecureLS from "secure-ls";
import type { BankSession } from "./types";

// Rogers' deployed application uses SecureLS AES with its per-key metadata.
// Recover tokens from the saved browser state when no auth response was emitted
// during a restored browser visit. Never replace tokens already rotated by API.
export function restoreRogersTokens(session: BankSession) {
  if (session.headers.accesstoken && session.headers.refreshtoken) return;
  const entries = session.state.origins.find(
    (origin) => origin.origin === "https://selfserve.rogersbank.com",
  )?.localStorage;
  if (!entries) return;
  const values = new Map(entries.map((entry) => [entry.name, entry.value]));
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
  const config = { encodingType: "aes", storage };
  const Constructor =
    typeof SecureLS === "function" ? SecureLS : (SecureLS as any).default;
  const secure = new Constructor(config);
  const saved = secure.get("tokens");
  const tokens = typeof saved === "string" ? JSON.parse(saved) : saved;
  if (
    typeof tokens?.accessToken !== "string" ||
    typeof tokens?.refreshToken !== "string"
  )
    return;
  if (session.headers.authorization !== `Bearer ${tokens.accessToken}`) return;
  session.headers.accesstoken = tokens.accessToken;
  session.headers.refreshtoken = tokens.refreshToken;
}
