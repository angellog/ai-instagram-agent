import type { FastifyRequest } from "fastify";
import type { Principal } from "./users.js";

/** The principal the auth hook resolved for this request. */
export function principalOf(req: FastifyRequest): Principal | undefined {
  return (req as FastifyRequest & { principal?: Principal }).principal;
}

export function setPrincipal(req: FastifyRequest, p: Principal): void {
  (req as FastifyRequest & { principal?: Principal }).principal = p;
}
