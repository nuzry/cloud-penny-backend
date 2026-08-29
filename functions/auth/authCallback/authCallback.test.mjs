import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handler } from './index.mjs';

const ALLOWED_REDIRECT = 'http://localhost:5173/';

const mockFetchOnce = (ok, body) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok,
    json: async () => body,
  }));
};

const bodyEvent = (body) => ({ body: JSON.stringify(body) });

describe('authCallback', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('returns 400 when required fields are missing', async () => {
    const res = await handler(bodyEvent({ code: 'abc' }));
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for a redirect_uri outside the allow-list', async () => {
    const res = await handler(bodyEvent({
      code: 'abc', code_verifier: 'v', redirect_uri: 'https://evil.example/',
    }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_redirect_uri');
  });

  it('returns 502 when Cognito is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const res = await handler(bodyEvent({ code: 'abc', code_verifier: 'v', redirect_uri: ALLOWED_REDIRECT }));
    expect(res.statusCode).toBe(502);
  });

  it('passes through a Cognito token-exchange rejection as 400', async () => {
    mockFetchOnce(false, { error: 'invalid_grant', error_description: 'code expired' });
    const res = await handler(bodyEvent({ code: 'abc', code_verifier: 'v', redirect_uri: ALLOWED_REDIRECT }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_grant');
  });

  it('returns 502 if Cognito omits a refresh_token', async () => {
    mockFetchOnce(true, { access_token: 'at', id_token: 'it', expires_in: 3600 });
    const res = await handler(bodyEvent({ code: 'abc', code_verifier: 'v', redirect_uri: ALLOWED_REDIRECT }));
    expect(res.statusCode).toBe(502);
  });

  it('on success, returns the access/id tokens and sets the httpOnly refresh cookie', async () => {
    mockFetchOnce(true, { access_token: 'at', id_token: 'it', refresh_token: 'rt', expires_in: 3600 });
    const res = await handler(bodyEvent({ code: 'abc', code_verifier: 'v', redirect_uri: ALLOWED_REDIRECT }));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.access_token).toBe('at');
    expect(body.id_token).toBe('it');
    expect(body).not.toHaveProperty('refresh_token');

    expect(res.cookies).toHaveLength(1);
    expect(res.cookies[0]).toContain('cp_refresh=rt');
    expect(res.cookies[0]).toContain('HttpOnly');
    expect(res.cookies[0]).toContain('Secure');
    expect(res.cookies[0]).toContain('SameSite=Lax');
  });
});
