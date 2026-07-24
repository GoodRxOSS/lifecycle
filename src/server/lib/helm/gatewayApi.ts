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

import type Deploy from 'server/models/Deploy';
import type { GatewayApiConfig, Helm } from 'server/models/yaml/YamlService';

interface DomainDefaults {
  http: string;
  grpc: string;
  altHttp?: string[];
  altGrpc?: string[];
}

interface ServiceDefaults {
  defaultIPWhiteList?: string;
}

interface BuildGatewayApiConfigParams {
  deploy: Deploy;
  domainDefaults: DomainDefaults;
  serviceDefaults: ServiceDefaults;
  helmConfig?: Pick<Helm, 'gatewayApi' | 'grpc' | 'overrideDefaultIpWhitelist'>;
}

function clonePlain<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function parseDefaultIpAllowlist(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }

  return raw
    .trim()
    .slice(1, -1)
    .split(',')
    .map((cidr) => cidr.trim())
    .filter(Boolean);
}

function resolveGatewayApiProtocol(grpc: boolean | undefined, protocol?: string): 'http' | 'grpc' {
  if (protocol === 'http' || protocol === 'grpc') {
    if (grpc && protocol !== 'grpc') {
      throw new Error('helm.gatewayApi.protocol must be grpc when helm.grpc is enabled');
    }

    if (!grpc && protocol !== 'http') {
      throw new Error('helm.gatewayApi.protocol must be http when helm.grpc is disabled');
    }

    return protocol;
  }

  return grpc ? 'grpc' : 'http';
}

function generatedHostnames(protocol: 'http' | 'grpc', deployUuid: string, domainDefaults: DomainDefaults): string[] {
  const hosts =
    protocol === 'grpc'
      ? [domainDefaults.grpc, ...(domainDefaults.altGrpc || [])]
      : [domainDefaults.http, ...(domainDefaults.altHttp || [])];

  return hosts.map((host) => `${deployUuid}.${host}`);
}

function normalizeSecurityPolicy(
  gatewayApi: GatewayApiConfig,
  serviceDefaults: ServiceDefaults,
  overrideDefaultIpWhitelist: boolean | undefined
): Record<string, unknown> | undefined {
  if (gatewayApi.securityPolicy) {
    return clonePlain(gatewayApi.securityPolicy);
  }

  if (overrideDefaultIpWhitelist) {
    return undefined;
  }

  const allowedCIDRs = parseDefaultIpAllowlist(serviceDefaults.defaultIPWhiteList);
  if (allowedCIDRs.length === 0) {
    return undefined;
  }

  return {
    enabled: true,
    annotations: {},
    allowedCIDRs,
  };
}

function normalizeRoutes(
  routes: GatewayApiConfig['routes'],
  topLevelGateway: string | undefined,
  topLevelGatewayName: string | undefined,
  defaultHostnames: string[]
): GatewayApiConfig['routes'] | undefined {
  if (!routes?.length) {
    return undefined;
  }

  return routes.map((route) => {
    const normalizedRoute = clonePlain(route) as Record<string, unknown>;
    const routeGatewayName =
      typeof normalizedRoute.gatewayName === 'string' && normalizedRoute.gatewayName.length > 0
        ? normalizedRoute.gatewayName
        : topLevelGatewayName;
    const routeGateway =
      typeof normalizedRoute.gateway === 'string' && normalizedRoute.gateway.length > 0
        ? normalizedRoute.gateway
        : topLevelGateway;

    if (!routeGatewayName && !routeGateway) {
      throw new Error('helm.gatewayApi requires gateway or gatewayName at the top level or on every route');
    }

    if (routeGatewayName) {
      normalizedRoute.gatewayName = routeGatewayName;
      delete normalizedRoute.gateway;
    } else if (routeGateway) {
      normalizedRoute.gateway = routeGateway;
      delete normalizedRoute.gatewayName;
    }

    const routeHostnames = Array.isArray(normalizedRoute.hostnames) ? normalizedRoute.hostnames : [];
    if (routeHostnames.length === 0) {
      normalizedRoute.hostnames = defaultHostnames;
    }

    return normalizedRoute;
  });
}

export function buildLifecycleGatewayApiConfig({
  deploy,
  domainDefaults,
  serviceDefaults,
  helmConfig,
}: BuildGatewayApiConfigParams): Record<string, unknown> {
  const effectiveHelm = helmConfig || deploy.deployable?.helm;
  const gatewayApi = effectiveHelm?.gatewayApi;
  if (!gatewayApi?.enabled) {
    throw new Error('helm.gatewayApi.enabled must be true to build Gateway API values');
  }

  const protocol = resolveGatewayApiProtocol(effectiveHelm?.grpc, gatewayApi.protocol);
  const defaultHostnames =
    gatewayApi.hostnames && gatewayApi.hostnames.length > 0
      ? [...gatewayApi.hostnames]
      : generatedHostnames(protocol, deploy.uuid, domainDefaults);

  const topLevelGateway = gatewayApi.gateway && gatewayApi.gateway.length > 0 ? gatewayApi.gateway : undefined;
  const topLevelGatewayName =
    gatewayApi.gatewayName && gatewayApi.gatewayName.length > 0 ? gatewayApi.gatewayName : undefined;

  if (!topLevelGateway && !topLevelGatewayName && !gatewayApi.routes?.length) {
    throw new Error('helm.gatewayApi requires gateway or gatewayName when routes are not provided');
  }

  const routes = normalizeRoutes(gatewayApi.routes, topLevelGateway, topLevelGatewayName, defaultHostnames);

  const config: Record<string, unknown> = {
    enabled: true,
    protocol,
    port: gatewayApi.port ?? deploy.deployable?.port,
    hostnames: defaultHostnames,
  };

  if (topLevelGateway) {
    config.gateway = topLevelGateway;
  }

  if (topLevelGatewayName) {
    config.gatewayName = topLevelGatewayName;
  }

  if (gatewayApi.gatewayNamespace) {
    config.gatewayNamespace = gatewayApi.gatewayNamespace;
  }

  if (gatewayApi.gateways) {
    config.gateways = clonePlain(gatewayApi.gateways);
  }

  if (gatewayApi.annotations) {
    config.annotations = clonePlain(gatewayApi.annotations);
  }

  if (gatewayApi.rules) {
    config.rules = clonePlain(gatewayApi.rules);
  }

  if (routes?.length) {
    config.routes = routes;
  }

  const securityPolicy = normalizeSecurityPolicy(
    gatewayApi,
    serviceDefaults,
    effectiveHelm?.overrideDefaultIpWhitelist
  );
  if (securityPolicy) {
    config.securityPolicy = securityPolicy;
  }

  return config;
}
