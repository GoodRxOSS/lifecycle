/**
 * Copyright 2026 GoodRx, Inc.
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

import fs from 'fs';
import path from 'path';
import ts from 'typescript';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface V2RouteOperation {
  method: HttpMethod;
  route: string;
  file: string;
  guard: 'machine' | 'admin' | 'plain';
  machineScope: 'env:read' | 'env:write' | 'env:admin' | null;
  /** Wrapper actually applied in source, once the sweep has landed. */
  wrapper:
    | 'createApiHandler'
    | 'createPrincipalApiHandler'
    | 'createPublicApiHandler'
    | 'createMachineApiHandler'
    | null;
  /** Scope literal passed to createPrincipalApiHandler: a scope string, or null for an explicit `scope: null`. */
  declaredScope: string | null;
  /** Distinguishes an explicit `scope: null` from a missing scope key. */
  hasScopeDeclaration: boolean;
  declaredRoles: string[] | null;
  declaresSessionAuth: boolean;
}

const HTTP_METHODS = new Set<string>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const DEFAULT_ROUTE_ROOT = path.resolve(__dirname, '../src/app/api/v2');
const ROUTE_FILE = /^route\.(ts|tsx|js|jsx|mjs|cjs)$/;
const ROUTE_LIKE_FILE = /^route\.[^.]+$/;
const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
};

function walk(directory: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(absolute));
    else if (ROUTE_FILE.test(entry.name)) result.push(absolute);
    else if (ROUTE_LIKE_FILE.test(entry.name)) {
      throw new Error(
        `${absolute}: route file extension is outside the v2 auth-policy inventory; use route.{ts,tsx,js,jsx,mjs,cjs}`
      );
    }
  }
  return result.sort();
}

function normalizeRoute(routeRoot: string, file: string): string {
  return (
    '/api/v2/' +
    path
      .relative(routeRoot, file)
      .replace(/\/route\.[a-z]+$/, '')
      .replace(/\[\.\.\.([^\]]+)\]/g, '{$1+}')
      .replace(/\[([^\]]+)\]/g, '{$1}')
  );
}

function hasModifier(statement: ts.VariableStatement | ts.FunctionDeclaration, kind: ts.SyntaxKind): boolean {
  return Boolean(statement.modifiers?.some((modifier) => modifier.kind === kind));
}

function collectMethodBindings(name: ts.BindingName, into: string[]): void {
  if (ts.isIdentifier(name)) {
    if (HTTP_METHODS.has(name.text)) into.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) collectMethodBindings(element.name, into);
  }
}

/** combined = export + resolved-definition source text; '' marks shapes with no analyzable wrapper. */
function extractOperation(method: HttpMethod, route: string, file: string, combined: string): V2RouteOperation {
  const machineMatch = combined.match(/createMachineApiHandler\(\s*['"](env:[a-z]+)['"]/);
  const admin = /roles:\s*\[\s*['"]admin['"]\s*\]/.test(combined);

  const wrapperMatch = combined.match(
    /\b(createPrincipalApiHandler|createPublicApiHandler|createMachineApiHandler|createApiHandler)\s*\(/
  );
  const scopeMatch = combined.match(/createPrincipalApiHandler\(\s*\{[^}]*\bscope:\s*(null|['"]([^'"]+)['"])/s);
  const rolesMatch = combined.match(/\broles:\s*\[([^\]]*)\]/);
  return {
    method,
    route,
    file,
    guard: machineMatch ? 'machine' : admin ? 'admin' : 'plain',
    machineScope: machineMatch ? (machineMatch[1] as V2RouteOperation['machineScope']) : null,
    wrapper: (wrapperMatch?.[1] as V2RouteOperation['wrapper']) ?? null,
    declaredScope: scopeMatch ? (scopeMatch[1] === 'null' ? null : scopeMatch[2]) : null,
    hasScopeDeclaration: Boolean(scopeMatch),
    declaredRoles: rolesMatch
      ? rolesMatch[1]
          .split(',')
          .map((role) => role.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean)
      : null,
    declaresSessionAuth: /\bauth:\s*['"]session['"]/.test(combined),
  };
}

/**
 * Walks src/app/api/v2 and returns every exported HTTP method (const, function declaration,
 * re-export, or destructured export) with its wrapper guard; shapes whose wrapper cannot be
 * analyzed surface as wrapper: null, and star re-exports throw rather than hide methods.
 */
export function collectV2RouteOperations(routeRoot: string = DEFAULT_ROUTE_ROOT): V2RouteOperation[] {
  const operations: V2RouteOperation[] = [];
  for (const file of walk(routeRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    const scriptKind = SCRIPT_KINDS[path.extname(file)] ?? ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
    const route = normalizeRoute(routeRoot, file);
    const relativeFile = path.relative(path.resolve(routeRoot, '../../../..'), file);
    const emit = (method: string, combined: string) => {
      operations.push(extractOperation(method as HttpMethod, route, relativeFile, combined));
    };

    const definitions = new Map<string, ts.Node | undefined>();
    for (const statement of sf.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        definitions.set(statement.name.text, statement);
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            definitions.set(declaration.name.text, declaration.initializer);
          }
        }
      }
    }

    for (const statement of sf.statements) {
      if (ts.isExportDeclaration(statement)) {
        if (!statement.exportClause) {
          throw new Error(
            `${relativeFile}: 'export *' hides route methods from the v2 auth-policy inventory; export each HTTP method directly`
          );
        }
        if (ts.isNamespaceExport(statement.exportClause)) {
          if (HTTP_METHODS.has(statement.exportClause.name.text)) emit(statement.exportClause.name.text, '');
          continue;
        }
        for (const specifier of statement.exportClause.elements) {
          if (!HTTP_METHODS.has(specifier.name.text)) continue;
          let resolved = statement.moduleSpecifier
            ? undefined
            : definitions.get((specifier.propertyName ?? specifier.name).text);
          if (resolved && ts.isIdentifier(resolved)) resolved = definitions.get(resolved.text) ?? resolved;
          emit(specifier.name.text, resolved && !ts.isFunctionDeclaration(resolved) ? resolved.getText(sf) : '');
        }
        continue;
      }

      if (ts.isFunctionDeclaration(statement)) {
        if (
          statement.name &&
          HTTP_METHODS.has(statement.name.text) &&
          hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
          !hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
        ) {
          emit(statement.name.text, '');
        }
        continue;
      }

      if (!ts.isVariableStatement(statement) || !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          const bound: string[] = [];
          collectMethodBindings(declaration.name, bound);
          for (const method of bound) emit(method, '');
          continue;
        }
        if (!HTTP_METHODS.has(declaration.name.text)) continue;

        const exportText = declaration.getText(sf);
        let resolvedText = exportText;
        const initializer = declaration.initializer;
        if (initializer && ts.isIdentifier(initializer)) {
          resolvedText = definitions.get(initializer.text)?.getText(sf) ?? exportText;
        }
        emit(declaration.name.text, `${exportText}\n${resolvedText}`);
      }
    }
  }
  return operations.sort((a, b) => a.route.localeCompare(b.route) || a.method.localeCompare(b.method));
}
