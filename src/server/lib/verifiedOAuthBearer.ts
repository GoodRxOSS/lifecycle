import type { Principal } from './principal';

// Request-lifetime only. Bearers must never become enumerable principal fields,
// audit data, or serialized browser Viewer records. Only incoming-request
// authorization uses this association; Site grants never retain OAuth tokens.
const requestBearers = new WeakMap<Principal, string>();

export function rememberVerifiedOAuthBearer(principal: Principal, bearer: string): void {
  requestBearers.set(principal, bearer);
}

export function getVerifiedOAuthBearer(principal: Principal): string | undefined {
  return requestBearers.get(principal);
}
