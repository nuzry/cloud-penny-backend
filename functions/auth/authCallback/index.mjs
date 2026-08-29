const COGNITO_DOMAIN = process.env.COGNITO_DOMAIN;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const ALLOWED_REDIRECT_URIS = (process.env.ALLOWED_REDIRECT_URIS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const REFRESH_COOKIE_MAX_AGE = Number(process.env.REFRESH_TOKEN_MAX_AGE_SECONDS ?? 5 * 86400);

// Public route (see infra/functions.json "public": true) — there is no
// bearer token yet at this point, this endpoint is what mints one. Access
// control is the OAuth code itself (single-use, short-lived, issued only by
// Cognito to our own registered redirect_uri) plus the redirect_uri
// allow-list check below, which is defense-in-depth: Cognito independently
// validates redirect_uri against the app client's own CallbackURLs, so this
// check can only make things stricter, never looser.
export const handler = async (event) => {
  let body;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "invalid_request", message: "Malformed JSON body" }) };
  }

  const { code, code_verifier: codeVerifier, redirect_uri: redirectUri } = body;

  if (!code || !codeVerifier || !redirectUri) {
    return { statusCode: 400, body: JSON.stringify({ error: "invalid_request", message: "code, code_verifier and redirect_uri are required" }) };
  }

  if (ALLOWED_REDIRECT_URIS.length > 0 && !ALLOWED_REDIRECT_URIS.includes(redirectUri)) {
    console.warn("AUTH_CALLBACK_REJECTED_REDIRECT_URI:", redirectUri);
    return { statusCode: 400, body: JSON.stringify({ error: "invalid_redirect_uri" }) };
  }

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  let tokenRes;
  try {
    tokenRes = await fetch(`https://${COGNITO_DOMAIN}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
  } catch (err) {
    console.error("AUTH_CALLBACK_FETCH_ERROR:", err.message);
    return { statusCode: 502, body: JSON.stringify({ error: "cognito_unreachable" }) };
  }

  const tokenBody = await tokenRes.json().catch(() => ({}));

  if (!tokenRes.ok) {
    console.warn("AUTH_CALLBACK_TOKEN_EXCHANGE_FAILED:", tokenRes.status, JSON.stringify(tokenBody));
    return {
      statusCode: 400,
      body: JSON.stringify({ error: tokenBody.error ?? "token_exchange_failed", message: tokenBody.error_description }),
    };
  }

  const { access_token: accessToken, id_token: idToken, refresh_token: refreshToken, expires_in: expiresIn } = tokenBody;

  if (!refreshToken) {
    // Shouldn't happen for an authorization_code grant with offline access
    // scope, but if it ever does there's nothing to persist server-side —
    // fail loudly rather than silently degrade to a session that can never
    // survive a page reload.
    console.error("AUTH_CALLBACK_NO_REFRESH_TOKEN_IN_RESPONSE");
    return { statusCode: 502, body: JSON.stringify({ error: "no_refresh_token" }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ access_token: accessToken, id_token: idToken, expires_in: expiresIn }),
    cookies: [
      `cp_refresh=${refreshToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${REFRESH_COOKIE_MAX_AGE}`,
    ],
  };
};
