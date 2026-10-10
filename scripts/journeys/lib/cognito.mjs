// Signing in without a browser, for global setup's /me guard and for cleanup: Cognito's public
// USER_AUTH flow on the web client (identity-stack.ts, authFlows: { user: true }), by password
// (plus a TOTP code for `owner`) or by email code. Signing a throwaway account up (J1, J3):
// SignUp with no password (the pool's choice-based sign-in lets an account sign in by email
// code alone), and ConfirmSignUp with the code Cognito mails it. Unauthenticated JSON calls to
// Cognito's regional endpoint, as any app client (and Managed Login) makes them: no AWS
// credentials, no admin API. And GlobalSignOut with the account's own access token, which ends
// every session the account has (refresh tokens stop working, Cognito refuses its access tokens).
//
// Errors carry Cognito's error type only, never its message or anything sent.

export class CognitoError extends Error {
  constructor(operation, type) {
    super(`Cognito ${operation} failed: ${type}`);
    this.type = type;
  }
}

/** A Cognito client for `clientId` in `region`. `fetch` is injectable for the unit tests. */
export function createCognito({ region, clientId, fetch = globalThis.fetch, timeoutMs = 15_000 }) {
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(region)) throw new Error("Not an AWS region");
  if (!/^[a-z0-9]{20,40}$/.test(clientId ?? "")) throw new Error("Not a Cognito app client ID");
  const endpoint = `https://cognito-idp.${region}.amazonaws.com/`;

  async function call(operation, body) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": `AWSCognitoIdentityProviderService.${operation}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json = {};
    try { json = await res.json(); } catch {}
    if (!res.ok) throw new CognitoError(operation, String(json.__type ?? `HTTP ${res.status}`).replace(/^.*#/, ""));
    return json;
  }

  const tokens = (r) => {
    const a = r.AuthenticationResult;
    if (!a?.AccessToken) throw new CognitoError("sign-in", `unexpected challenge ${r.ChallengeName ?? "none"}`);
    return { accessToken: a.AccessToken, idToken: a.IdToken, refreshToken: a.RefreshToken };
  };

  const respond = (session, challenge, responses) =>
    call("RespondToAuthChallenge", { ClientId: clientId, ChallengeName: challenge, Session: session, ChallengeResponses: responses });

  return {
    /**
     * Signs in with a password; `totpCode` is called (and may wait for a fresh step) only if
     * Cognito asks for the second factor.
     */
    async signInWithPassword(email, password, totpCode) {
      const r = await call("InitiateAuth", { AuthFlow: "USER_AUTH", ClientId: clientId, AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: "PASSWORD", PASSWORD: password } });
      if (r.ChallengeName === "SOFTWARE_TOKEN_MFA") {
        if (!totpCode) throw new CognitoError("sign-in", "two-step code asked for, but the account has no TOTP secret");
        const username = r.ChallengeParameters?.USERNAME ?? email;
        return tokens(await respond(r.Session, "SOFTWARE_TOKEN_MFA", { USERNAME: username, SOFTWARE_TOKEN_MFA_CODE: await totpCode() }));
      }
      return tokens(r);
    },
    /** Starts an email-code sign-in; returns what answerEmailCode needs. */
    async startEmailCode(email) {
      const r = await call("InitiateAuth", { AuthFlow: "USER_AUTH", ClientId: clientId, AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: "EMAIL_OTP" } });
      if (r.ChallengeName !== "EMAIL_OTP") throw new CognitoError("sign-in", `unexpected challenge ${r.ChallengeName ?? "none"}`);
      return { session: r.Session, username: r.ChallengeParameters?.USERNAME ?? email };
    },
    async answerEmailCode({ session, username }, code) {
      return tokens(await respond(session, "EMAIL_OTP", { USERNAME: username, EMAIL_OTP_CODE: code }));
    },
    /**
     * Signs `email` up, with no password: it signs in by email code. Cognito mails it a
     * confirmation code (confirmSignUp). Only for a run's throwaway address (the caller checks).
     */
    async signUp(email) {
      const r = await call("SignUp", { ClientId: clientId, Username: email, UserAttributes: [{ Name: "email", Value: email }] });
      return { confirmed: r.UserConfirmed === true };
    },
    /** Confirms a sign-up with the code Cognito mailed; this also verifies the address. */
    async confirmSignUp(email, code) {
      await call("ConfirmSignUp", { ClientId: clientId, Username: email, ConfirmationCode: code });
    },
    /** Mails an unconfirmed account a new confirmation code (cleanup, for a run that died mid-sign-up). */
    async resendConfirmationCode(email) {
      await call("ResendConfirmationCode", { ClientId: clientId, Username: email });
    },
    /** Ends every session the account has. */
    async globalSignOut(accessToken) {
      await call("GlobalSignOut", { AccessToken: accessToken });
    },
  };
}
