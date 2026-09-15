import type { Principal } from './principal';

// Request-lifetime only. Bearers must never become enumerable principal fields,
// audit data, or serialized browser Viewer records. Viewer mint may separately
// retain an encrypted, short-lived copy for exact-token introspection.
const requestBearers = new WeakMap<Principal, string>();

export function rememberVerifiedOAuthBearer(principal: Principal, bearer: string): void {
  requestBearers.set(principal, bearer);
}

export function getVerifiedOAuthBearer(principal: Principal): string | undefined {
  return requestBearers.get(principal);
}
