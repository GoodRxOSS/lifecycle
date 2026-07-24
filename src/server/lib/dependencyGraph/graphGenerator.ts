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

import { CSSProperties } from 'react';
import { Deploy, Build } from 'server/models';
import dagre from 'dagre';
import GlobalConfigService from 'server/services/globalConfig';

interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface GraphNode {
  id: string;
  data: { label: string };
  position: { x: number; y: number };
  style?: CSSProperties;
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

type GraphDirection = 'LR' | 'TB';

/**
 * Lays out the graph using Dagre.
 * @param graph The graph with nodes and edges.
 * @param direction The layout direction ("LR" for left-to-right, "TB" for top-to-bottom).
 * @returns The graph with updated node positions.
 */
function layoutGraph(graph: Graph, direction: GraphDirection): Graph {
  // Define node dimensions – these could be made dynamic later.
  const nodeWidth = 250;
  const nodeHeight = 36;

  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({ rankdir: direction, nodesep: 50, ranksep: 50 });

  graph.nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  });

  graph.edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const layoutedNodes = graph.nodes.map((node) => {
    const dagreNode = dagreGraph.node(node.id);
    return {
      ...node,
      position: {
        x: dagreNode.x - nodeWidth / 2,
        y: dagreNode.y - nodeHeight / 2,
      },
    };
  });

  return {
    nodes: layoutedNodes,
    edges: graph.edges,
  };
}

/**
 * Helper: Creates or updates a node for a given service in nodesMap.
 * If the service is active (i.e. exists in deploys and is active), its label
 * is set to `${serviceName}-${build.uuid}`; otherwise, its label is set to
 * `${serviceName}-${defaultUuid}` which is the configured defaultUuid and a light grey style is applied.
 *
 * @param nodesMap The map of nodes keyed by service name.
 * @param serviceName The service name.
 * @param isActiveService True if the service is active in current build, false otherwise.
 * @param build The current build.
 * @param defaultUuid The default UUID from global configuration.
 */
function upsertNode(
  nodesMap: Map<string, GraphNode>,
  serviceName: string,
  isActiveService: boolean,
  build: Build,
  defaultUuid: string
): void {
  const label = isActiveService ? `${serviceName}-${build.uuid}` : `${serviceName}-${defaultUuid}`;

  const style: CSSProperties = isActiveService
    ? {
        minWidth: '200px',
      }
    : {
        background: '#f2f2f2',
        minWidth: '200px',
      };

  if (!nodesMap.has(serviceName)) {
    nodesMap.set(serviceName, {
      id: serviceName,
      data: { label },
      position: { x: 0, y: 0 },
      style,
    });
  } else {
    const node = nodesMap.get(serviceName)!;
    node.data.label = label;
    if (!isActiveService) {
      node.style = style;
    }
  }
}

/**
 * Generates a graph (nodes and edges) from a Build.
 * Each node represents a deployable service.
 * An edge from service A to service B indicates that A depends on B.
 *
 * For node labels:
 * - If a service is active, its label is set to `${serviceName}-${build.uuid}`.
 * - Otherwise, its label is set to `${serviceName}-${defaultUuid}`.
 *
 * @param build A Build object containing deployables and deploys.
 * @param graphDirection The layout direction ("LR" or "TB").
 * @returns The generated graph along with a Graphviz DOT language string.
 */
export async function generateGraph(
  build: Build,
  graphDirection: GraphDirection = 'TB'
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; graphviz: string }> {
  const deployables = build.deployables;
  const deploys = build.deploys;

  const globalConfig = await GlobalConfigService.getInstance().getAllConfigs();
  const defaultUuid = globalConfig.lifecycleDefaults.defaultUUID;

  const deploysByUuid: Map<string, Deploy> = new Map();
  deploys.forEach((deploy) => {
    deploysByUuid.set(deploy.uuid, deploy);
  });

  const nodesMap: Map<string, GraphNode> = new Map();
  const edgeSet: Set<string> = new Set();
  const edges: GraphEdge[] = [];

  // Regex to match placeholders like {{serviceName_publicUrl}} or {{serviceName_internalHostname}}.
  const envPlaceholderRegex = /\{\{([\w-]+)_(publicUrl|internalHostname)\}\}/g;

  deployables.forEach((deployable) => {
    const serviceName = deployable.name;
    const isActiveService =
      deploysByUuid.has(`${serviceName}-${build.uuid}`) && deploysByUuid.get(`${serviceName}-${build.uuid}`)!.active;
    upsertNode(nodesMap, serviceName, isActiveService, build, defaultUuid);
  });

  deployables.forEach((deployable) => {
    const sourceServiceName = deployable.name;
    if (!deployable.env || typeof deployable.env !== 'object') return;

    const initAndAppVars = { ...deployable.env, ...deployable.initEnv };

    Object.values(initAndAppVars).forEach((envValue) => {
      if (typeof envValue !== 'string') return;
      envPlaceholderRegex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = envPlaceholderRegex.exec(envValue)) !== null) {
        const dependencyServiceName = match[1];
        const isConfigured =
          deploysByUuid.has(`${dependencyServiceName}-${build.uuid}`) &&
          deploysByUuid.get(`${dependencyServiceName}-${build.uuid}`)!.active;
        upsertNode(nodesMap, dependencyServiceName, isConfigured, build, defaultUuid);
        const edgeId = `${sourceServiceName}-${dependencyServiceName}`;
        if (!edgeSet.has(edgeId)) {
          edges.push({
            id: edgeId,
            source: sourceServiceName,
            target: dependencyServiceName,
          });
          edgeSet.add(edgeId);
        }
      }
    });
  });

  const nodes = Array.from(nodesMap.values());
  const graphResult: Graph = { nodes, edges };

  const layoutedGraph = layoutGraph(graphResult, graphDirection);

  const graphviz = generateGraphvizDot(layoutedGraph);

  return { ...layoutedGraph, graphviz };
}

/**
 * Generates a Graphviz DOT language string from a Graph.
 * @param graph The graph to convert.
 * @returns A DOT language string representing the graph.
 */
function generateGraphvizDot(graph: Graph): string {
  let dot = 'digraph G {\n';

  graph.nodes.forEach((node) => {
    const safeLabel = node.data.label.replace(/"/g, '\\"');
    dot += `  "${node.id}" [label="${safeLabel}"];\n`;
  });

  graph.edges.forEach((edge) => {
    dot += `  "${edge.source}" -> "${edge.target}";\n`;
  });

  dot += '}';
  return dot;
}
