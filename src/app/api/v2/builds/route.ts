import { NextRequest, NextResponse } from 'next/server';

/**
 * @openapi
 * /api/v2/builds:
 *   get:
 *     summary: Returns a greeting message from the App Router.
 *     tags:
 *       - Builds
 *     responses:
 *       200:
 *         description: A successful response with a greeting message.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Hello from an app router!
 *                 request_id:
 *                   type: string
 *                   example: 123e4567-e89b-12d3-a456-426614174000
 */
export async function GET(req: NextRequest) {
  return NextResponse.json({ message: 'Hello from an app router!', request_id: req.headers.get('x-request-id') });
}
