const COGNITO_DOMAIN = process.env.COGNITO_DOMAIN;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID;

const CLEAR_COOKIE = "cp_refresh=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";

function getCookie(event, name) {
  for (const pair of event.cookies ?? []) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    if (pair.slice(0, idx) === name) return pair.slice(idx + 1);
  }
  return null;
}

// Public route. Always clears the cookie and always returns 200, even if
// revocation itself fails or there was no cookie to begin with — logout
// must never leave the user stuck unable to log out, and the frontend
// navigates to Cognito's own /logout regardless of this call's outcome.
export const handler = async (event) => {
  const refreshToken = getCookie(event, "cp_refresh");

  if (refreshToken) {
    try {
      const params = new URLSearchParams({ token: refreshToken, client_id: CLIENT_ID });
      const res = await fetch(`https://${COGNITO_DOMAIN}/oauth2/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      if (!res.ok) {
        console.warn("AUTH_LOGOUT_REVOKE_NON_OK:", res.status, await res.text().catch(() => ""));
      } else {
        console.log("AUTH_LOGOUT_REVOKED");
      }
    } catch (err) {
      console.error("AUTH_LOGOUT_REVOKE_ERROR:", err.message);
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true }),
    cookies: [CLEAR_COOKIE],
  };
};
