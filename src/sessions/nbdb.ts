import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { APIRequestContext } from "playwright-core";
import { BankFailure, type BankSession } from "./types";

export async function renewNBDB(
  session: BankSession,
  client: APIRequestContext,
  token: (
    url: string,
    headers: Record<string, string>,
    body: Record<string, string>,
  ) => Promise<any>,
) {
  const config = session.authorization!;
  const endpoint = new URL(config.tokenUrl);
  const redirect = new URL(config.redirectUri);
  if (
    endpoint.origin !== "https://api.bnc.ca" ||
    !/^\/bnc\/prod-okta\/sso\/oauth2\/[^/]+\/v1\/token$/.test(
      endpoint.pathname,
    ) ||
    redirect.origin !== "https://client.bnc.ca"
  )
    throw new BankFailure("invalid-response");
  const verifier = randomBytes(32).toString("base64url");
  const state = randomUUID();
  const authorize = new URL(
    endpoint.toString().replace(/\/token$/, "/authorize"),
  );
  authorize.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    response_mode: "query",
    scope: config.scope,
    prompt: "none",
    state,
    nonce: randomUUID(),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  let url = authorize;
  for (let redirects = 0; redirects < 6; redirects++) {
    // Never follow the callback into the SPA or transmit cookies to another host.
    if (
      url.origin !== endpoint.origin ||
      !url.pathname.startsWith("/bnc/prod-okta/sso/")
    )
      throw new BankFailure("authentication-required");
    let response;
    try {
      response = await client.get(url.toString(), {
        headers: {
          "user-agent": session.headers["user-agent"]!,
          accept: "text/html",
        },
        maxRedirects: 0,
      });
    } catch {
      throw new BankFailure("transport-failed");
    }
    console.info(
      JSON.stringify({
        event: "bank-api-response",
        bank: session.bank,
        operation: "session-authorization",
        status: response.status(),
      }),
    );
    if (response.status() === 429) throw new BankFailure("throttled");
    if (response.status() >= 500) throw new BankFailure("transport-failed");
    const location = response.headers().location;
    if (!location) throw new BankFailure("authentication-required");
    const next = new URL(location, url);
    if (
      next.origin === redirect.origin &&
      next.pathname === redirect.pathname
    ) {
      if (
        next.searchParams.get("state") !== state ||
        next.searchParams.has("error")
      )
        throw new BankFailure("authentication-required");
      const code = next.searchParams.get("code");
      if (!code) throw new BankFailure("authentication-required");
      const data = await token(
        config.tokenUrl,
        {
          ...config.headers,
          "content-type": "application/x-www-form-urlencoded",
        },
        {
          grant_type: "authorization_code",
          client_id: config.clientId,
          redirect_uri: config.redirectUri,
          code_verifier: verifier,
          code,
        },
      );
      if (typeof data.access_token !== "string")
        throw new BankFailure("authentication-required");
      return data;
    }
    url = next;
  }
  throw new BankFailure("authentication-required");
}
