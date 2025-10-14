import { NextRequest } from 'next/server';
import { createRemoteJWKSet, jwtVerify } from 'jose';

interface AuthResult {
  success: boolean;
  error?: {
    message: string;
    status: number;
  };
}

export async function verifyAuth(request: NextRequest): Promise<AuthResult> {
  // 1. Extract token from the "Bearer <token>" format in the Authorization header.
  const authHeader = request.headers.get('Authorization');

  if (!authHeader) {
    return {
      success: false,
      error: { message: 'Authorization header is missing', status: 401 },
    };
  }

  const token = authHeader.split(' ')[1];

  if (!token) {
    return {
      success: false,
      error: { message: 'Bearer token is missing or malformed', status: 401 },
    };
  }

  // 2. Get Keycloak configuration from environment variables.
  const issuer = process.env.KEYCLOAK_ISSUER;
  const audience = process.env.KEYCLOAK_CLIENT_ID;
  const jwksUrl = process.env.KEYCLOAK_JWKS_URL;

  if (!issuer || !audience || !jwksUrl) {
    console.error('Missing required Keycloak environment variables');
    return {
      success: false,
      error: { message: 'Server configuration error', status: 500 },
    };
  }

  try {
    // 3. Fetch the JSON Web Key Set (JWKS) from your Keycloak server.
    const JWKS = createRemoteJWKSet(new URL(jwksUrl));

    // 4. Verify the token. This function checks the signature, expiration, issuer, and audience.
    await jwtVerify(token, JWKS, {
      issuer: issuer,
      audience: audience,
    });

    // 5. If verification is successful, return a success result.
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    console.error('JWT Verification Error:', errorMessage);

    // 6. If any part of the verification fails, return an error.
    return {
      success: false,
      error: { message: `Authentication failed: ${errorMessage}`, status: 401 },
    };
  }
}
