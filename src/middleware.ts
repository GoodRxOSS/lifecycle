import { chain } from 'server/middlewares/chain';
import { authMiddleware, corsMiddleware, requestIdMiddleware } from 'server/middlewares';

// The order in this array is the order of execution.
const middlewares = [corsMiddleware, requestIdMiddleware, authMiddleware];

export const middleware = chain(middlewares);

export const config = {
  matcher: ['/api/v1/:path*', '/api/v2/:path*'],
};
