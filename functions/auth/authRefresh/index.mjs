const COGNITO_DOMAIN = process.env.COGNITO_DOMAIN;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const REFRESH_COOKIE_MAX_AGE = Number(process.env.REFRESH_TOKEN_MAX_AGE_SECONDS ?? 5 * 86400);

const CLEAR_COOKIE = "cp_refresh=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";

function getCookie(event, name) {
  for (const pair of event.cookies ?? []) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    if (pair.slice(0, idx) === name) return pair.slice(idx + 1);
  }
  return null;
}

// Public route — auth here comes from the httpOnly refresh cookie itself,
// not a bearer token (there may be none, or an expired one, which is the
// whole point of calling this). Called both to silently restore a session
// on page load and to renew an access token before/after it expires.
export const handler = async (event) => {
  const refreshToken = getCookie(event, "cp_refresh");

  if (!refreshToken) {
    return { statusCode: 401, body: JSON.stringify({ error: "no_session" }) };
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });

  let tokenRes;
  try {
    tokenRes = await fetch(`https://${COGNITO_DOMAIN}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
  } catch (err) {
    console.error("AUTH_REFRESH_FETCH_ERROR:", err.message);
    return { statusCode: 502, body: JSON.stringify({ error: "cognito_unreachable" }) };
  }

  const tokenBody = await tokenRes.json().catch(() => ({}));

  if (!tokenRes.ok) {
    // Refresh token expired or was revoked — clear the now-useless cookie so
    // the frontend doesn't keep retrying a session that can never succeed.
    console.warn("AUTH_REFRESH_FAILED:", tokenRes.status, JSON.stringify(tokenBody));
    return {
      statusCode: 401,
      body: JSON.stringify({ error: tokenBody.error ?? "refresh_failed" }),
      cookies: [CLEAR_COOKIE],
    };
  }

  const { access_token: accessToken, id_token: idToken, refresh_token: rotatedRefreshToken } = tokenBody;

  const response = {
    statusCode: 200,
    body: JSON.stringify({ access_token: accessToken, id_token: idToken }),
  };

  // The refresh grant doesn't return a new refresh_token today (rotation is
  // off), but if that's ever enabled on the Cognito app client, re-issuing
  // the cookie here (rather than assuming it stays valid) keeps this correct
  // without another code change.
  if (rotatedRefreshToken) {
    response.cookies = [
      `cp_refresh=${rotatedRefreshToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${REFRESH_COOKIE_MAX_AGE}`,
    ];
  }

  return response;
};
