// SURF relay Worker entry point (see relay.ts). A module Worker may only export handlers, so the helpers and
// constants live in relay.ts.
import { type Env, handleRequest, type RelayContext } from './relay';

export default {
  fetch(req: Request, env: Env, ctx: RelayContext): Promise<Response> {
    return handleRequest(req, env, ctx);
  },
};
