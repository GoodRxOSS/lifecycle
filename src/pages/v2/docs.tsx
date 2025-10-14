/**
 * Copyright 2025 GoodRx, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// src/pages/docs.tsx
import React from 'react';
import dynamic from 'next/dynamic';
import { GetServerSideProps } from 'next';
import 'swagger-ui-react/swagger-ui.css';

// Import Swagger UI dynamically so it doesn't run on the server.
const SwaggerUI = dynamic(() => import('swagger-ui-react'), { ssr: false });

interface DocsPageProps {
  swaggerSpec: any;
}

export default function DocsPage({ swaggerSpec }: DocsPageProps) {
  return (
    <div style={{ height: '100vh' }}>
      <SwaggerUI spec={swaggerSpec} />
    </div>
  );
}

export const openApiSpecification = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Lifecycle API',
      version: '2.0.0',
      description: 'API documentation for lifecycle',
    },
  },
  // Adjust this glob pattern to match your API files
  apis: ['./src/app/api/**/*.ts'],
};

export const getServerSideProps: GetServerSideProps = async () => {
  // Dynamically import swagger-jsdoc so it's only loaded on the server.
  const swaggerJSDoc = (await import('swagger-jsdoc')).default;

  const swaggerSpec = swaggerJSDoc(openApiSpecification);

  return {
    props: {
      swaggerSpec,
    },
  };
};
