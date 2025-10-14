import { NextResponse } from 'next/server';
import { openApiSpecification } from 'src/pages/v2/docs';
import swaggerJsdoc from 'swagger-jsdoc';

export async function GET() {
  const swaggerSpec = swaggerJsdoc(openApiSpecification);
  return NextResponse.json(swaggerSpec);
}
