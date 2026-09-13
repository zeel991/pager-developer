import type { TwinState } from './store.js';

export interface RouteContext {
  state: TwinState;
  params: string[];
  query: Record<string, string>;
  headers: Record<string, string>;
  json: unknown;
  form: URLSearchParams;
  now: () => number;
}

export interface RouteResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface Route {
  method: string;
  pattern: RegExp;
  handler: (ctx: RouteContext) => RouteResult | Promise<RouteResult>;
}

export function matchRoute(routes: Route[], method: string, path: string): { route: Route; params: string[] } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.pattern.exec(path);
    if (m) return { route, params: m.slice(1) };
  }
  return null;
}
