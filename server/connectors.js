// Connectors = MCP servers. Every enabled connector is handed to every session.
import os from 'node:os';
import { store } from './store.js';

// A starter shelf. Anything else can be found through the MCP registry search.
export const CATALOG = [
  { name: 'github', label: 'GitHub', type: 'http', url: 'https://api.githubcopilot.com/mcp/', auth: 'Bearer token (GitHub PAT)' },
  { name: 'linear', label: 'Linear', type: 'http', url: 'https://mcp.linear.app/mcp', auth: 'OAuth / Bearer token' },
  { name: 'notion', label: 'Notion', type: 'http', url: 'https://mcp.notion.com/mcp', auth: 'OAuth / Bearer token' },
  { name: 'sentry', label: 'Sentry', type: 'http', url: 'https://mcp.sentry.dev/mcp', auth: 'OAuth / Bearer token' },
  { name: 'atlassian', label: 'Jira & Confluence', type: 'sse', url: 'https://mcp.atlassian.com/v1/sse', auth: 'OAuth' },
  { name: 'asana', label: 'Asana', type: 'sse', url: 'https://mcp.asana.com/sse', auth: 'OAuth' },
  { name: 'stripe', label: 'Stripe', type: 'http', url: 'https://mcp.stripe.com', auth: 'Bearer token (restricted key)' },
  { name: 'vercel', label: 'Vercel', type: 'http', url: 'https://mcp.vercel.com', auth: 'OAuth / Bearer token' },
  { name: 'supabase', label: 'Supabase', type: 'http', url: 'https://mcp.supabase.com/mcp', auth: 'Bearer token (access token)' },
  { name: 'playwright', label: 'Browser (Playwright)', type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], auth: 'none' },
  { name: 'filesystem', label: 'Filesystem', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', os.homedir()], auth: 'none' },
  { name: 'memory', label: 'Memory graph', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], auth: 'none' },
];

/** Search the official MCP registry for any app. */
export async function searchRegistry(q) {
  const url = `https://registry.modelcontextprotocol.io/v0/servers?limit=30&search=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`registry ${res.status}`);
  const body = await res.json();
  const seen = new Set();
  const out = [];
  for (const item of body.servers || []) {
    const sv = item.server || item;
    if (seen.has(sv.name)) continue;
    seen.add(sv.name);
    const remote = (sv.remotes || [])[0];
    const pkg = (sv.packages || []).find(p => p.registryType === 'npm' || p.registry_type === 'npm');
    const short = sv.name.split('/').pop().replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
    if (remote) {
      out.push({ name: short, label: sv.title || sv.name, description: sv.description || '', type: remote.type === 'sse' ? 'sse' : 'http', url: remote.url });
    } else if (pkg) {
      out.push({ name: short, label: sv.title || sv.name, description: sv.description || '', type: 'stdio', command: 'npx', args: ['-y', pkg.identifier] });
    }
  }
  return out;
}

/** The mcpServers option for the Agent SDK. */
export function mcpServersFor() {
  const out = {};
  for (const c of store.state.connectors) {
    if (!c.enabled) continue;
    if (c.type === 'stdio') out[c.name] = { type: 'stdio', command: c.command, args: c.args || [], env: c.env || {} };
    else out[c.name] = { type: c.type, url: c.url, headers: c.token ? { Authorization: `Bearer ${c.token}` } : (c.headers || {}) };
  }
  return out;
}

// The browser never gets tokens back.
export function redact(c) {
  const { token, ...rest } = c;
  return { ...rest, hasToken: !!token };
}
