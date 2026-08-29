import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handler } from './index.mjs';

const mockFetchOnce = (ok, body) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok, json: async () => body }));
};

describe('authRefresh', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('returns 401 when there is no refresh cookie', async () => {
    const res = await handler({ cookies: [] });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('no_session');
  });

  it('returns 401 and clears the cookie when Cognito rejects the refresh token', async () => {
    mockFetchOnce(false, { error: 'invalid_grant' });
    const res = await handler({ cookies: ['cp_refresh=stale-token'] });
    expect(res.statusCode).toBe(401);
    expect(res.cookies[0]).toContain('Max-Age=0');
  });

  it('returns new access/id tokens on success without re-issuing the cookie', async () => {
    mockFetchOnce(true, { access_token: 'at2', id_token: 'it2' });
    const res = await handler({ cookies: ['other=1', 'cp_refresh=good-token'] });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.access_token).toBe('at2');
    expect(body.id_token).toBe('it2');
    expect(res.cookies).toBeUndefined();
  });

  it('re-issues the cookie if Cognito rotates the refresh token', async () => {
    mockFetchOnce(true, { access_token: 'at2', id_token: 'it2', refresh_token: 'rotated-token' });
    const res = await handler({ cookies: ['cp_refresh=good-token'] });

    expect(res.cookies).toHaveLength(1);
    expect(res.cookies[0]).toContain('cp_refresh=rotated-token');
  });
});
