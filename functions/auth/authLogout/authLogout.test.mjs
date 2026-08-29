import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handler } from './index.mjs';

describe('authLogout', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('clears the cookie and returns 200 even with no cookie present', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const res = await handler({ cookies: [] });
    expect(res.statusCode).toBe(200);
    expect(res.cookies[0]).toContain('Max-Age=0');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('revokes the token with Cognito when a cookie is present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const res = await handler({ cookies: ['cp_refresh=token-abc'] });
    expect(res.statusCode).toBe(200);
    expect(res.cookies[0]).toContain('Max-Age=0');
  });

  it('still returns 200 and clears the cookie if revocation fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('cognito down')));
    const res = await handler({ cookies: ['cp_refresh=token-abc'] });
    expect(res.statusCode).toBe(200);
    expect(res.cookies[0]).toContain('Max-Age=0');
  });
});
