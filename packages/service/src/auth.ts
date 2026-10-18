import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { recoverMessageAddress } from 'viem';
import { AddressSchema, hashBytes } from '@faultline/protocol';
import { check, parse } from './errors';
import type { AuthChallenge, AuthOptions, Store } from './types';

export interface BearerIdentity { address: string; expiresAt: number }
export interface AuthToken extends BearerIdentity { token: string; tokenType: 'Bearer' }
/** EOA proof of control for API authorization. Never signs or sends chain transactions. */
export class WalletAuth {
  private readonly now: () => number;
  private readonly challengeTtl: number;
  private readonly tokenTtl: number;
  constructor(private readonly store: Store, private readonly options: AuthOptions) {
    check(typeof options.secret === 'string' && Buffer.byteLength(options.secret) >= 32, 'AUTH_CONFIGURATION', 'A server-only auth secret of at least 32 bytes is required');
    const url = new URL(options.origin);
    check(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname)), 'AUTH_CONFIGURATION', 'Auth origin must use HTTPS');
    check(url.origin === options.origin && options.audience.length > 0, 'AUTH_CONFIGURATION', 'Provide an exact origin and nonempty audience');
    this.now = options.now ?? Date.now; this.challengeTtl = options.challengeTtlMs ?? 300_000; this.tokenTtl = options.tokenTtlMs ?? 900_000;
    check(Number.isSafeInteger(this.challengeTtl) && this.challengeTtl > 0 && this.challengeTtl <= 600_000 && Number.isSafeInteger(this.tokenTtl) && this.tokenTtl > 0 && this.tokenTtl <= 3_600_000, 'AUTH_CONFIGURATION', 'Invalid auth lifetimes');
  }
  static fromEnv(store: Store, env: NodeJS.ProcessEnv = process.env): WalletAuth {
    check(store.durability === 'durable', 'AUTH_CONFIGURATION', 'Production authentication requires durable challenge storage');
    return new WalletAuth(store, { secret: env.FAULTLINE_AUTH_SECRET ?? '', origin: env.FAULTLINE_AUTH_ORIGIN ?? '', audience: env.FAULTLINE_AUTH_AUDIENCE ?? 'faultline-api-v1' });
  }
  async createChallenge(address: string): Promise<AuthChallenge> {
    address = parse(AddressSchema,address); const now = this.now();
    const nonce = randomBytes(32).toString('hex');
    const c: AuthChallenge = { id: hashBytes(Buffer.from(nonce)), address, expiresAt: now + this.challengeTtl, message: `${new URL(this.options.origin).host} requests wallet authentication for Faultline.\n\nAddress: ${address}\nURI: ${this.options.origin}\nAudience: ${this.options.audience}\nNonce: ${nonce}\nIssued At: ${new Date(now).toISOString()}\nExpiration Time: ${new Date(now + this.challengeTtl).toISOString()}\n\nThis signature authorizes API requests only. It does not authorize spending or chain transactions.` };
    await this.store.putChallenge(c); return c;
  }
  async verifyChallenge(id: string, signature: string): Promise<AuthToken> {
    const c = await this.store.getChallenge(id);
    check(c && c.consumedAt === undefined && c.expiresAt > this.now(), 'INVALID_CHALLENGE', 'Challenge is missing, expired, or already used');
    check(/^0x[0-9a-fA-F]{130}$/.test(signature), 'INVALID_SIGNATURE', 'An EOA personal-message signature is required');
    let signer: string;
    try { signer = (await recoverMessageAddress({ message: c.message, signature: signature as `0x${string}` })).toLowerCase(); }
    catch { check(false,'INVALID_SIGNATURE','Wallet signature could not be verified'); }
    check(signer === c.address, 'WRONG_WALLET', 'Signature does not match the challenged wallet');
    check(await this.store.consumeChallenge(id, this.now()), 'INVALID_CHALLENGE', 'Challenge is expired or already used');
    const issuedAt = this.now(), expiresAt = issuedAt + this.tokenTtl;
    const payload = Buffer.from(JSON.stringify({ version: 1, sub: c.address, iss: this.options.origin, aud: this.options.audience, iat: issuedAt, exp: expiresAt, jti: randomBytes(24).toString('hex') })).toString('base64url');
    const token = `${payload}.${this.mac(payload)}`;
    return { address: c.address, expiresAt, token, tokenType: 'Bearer' };
  }
  verifyBearer(authorization: string): BearerIdentity {
    check(typeof authorization === 'string' && authorization.length < 4096 && /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(authorization), 'UNAUTHORIZED', 'A valid wallet-bound bearer token is required');
    const [payload, signature] = authorization.slice(7).split('.') as [string,string];
    const actual = Buffer.from(signature,'base64url'), expected = Buffer.from(this.mac(payload),'base64url');
    check(actual.length === expected.length && timingSafeEqual(actual,expected), 'UNAUTHORIZED', 'Invalid bearer token');
    let claims: Record<string,unknown>;
    try { claims = JSON.parse(Buffer.from(payload,'base64url').toString('utf8')); } catch { check(false,'UNAUTHORIZED','Invalid bearer token'); }
    check(claims && claims.version === 1 && claims.iss === this.options.origin && claims.aud === this.options.audience && Number.isSafeInteger(claims.iat) && Number.isSafeInteger(claims.exp) && (claims.iat as number) <= this.now() && (claims.exp as number) > this.now() && (claims.exp as number) > (claims.iat as number) && (claims.exp as number) - (claims.iat as number) <= this.tokenTtl, 'UNAUTHORIZED', 'Bearer token has expired or has invalid claims');
    return { address: parse(AddressSchema,claims.sub), expiresAt: claims.exp as number };
  }
  private mac(payload: string) { return createHmac('sha256',this.options.secret).update(`faultline-auth-v1.${payload}`).digest('base64url'); }
}
