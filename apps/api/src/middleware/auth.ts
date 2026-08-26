import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Authentication Middleware — Phase 12 (§16.2)
 *
 * Single-merchant Buildathon authentication via X-Merchant-Key header.
 * Applied to all /api/v1/* routes.
 *
 * "This is single-merchant Buildathon authentication and is not production authentication." (§16.2)
 */
export async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const apiKey = request.headers['x-merchant-key'] as string | undefined;
  // biome-ignore lint/complexity/useLiteralKeys: TS strict noUncheckedIndexedAccess
  const expected = process.env['MERCHANT_API_KEY'];

  if (!apiKey || !expected || apiKey !== expected) {
    await reply.status(401).send({
      status: 'error',
      message: 'Unauthorized: Invalid or missing X-Merchant-Key',
    });
  }
}
