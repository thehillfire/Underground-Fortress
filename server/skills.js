// Skills: list what's installed, find more on GitHub, install into ~/.claude/skills.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { store, DATA_DIR } from './store.js';

export const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

function frontmatter(md) {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  const meta = {};
  if (m) for (const line of m[1].split('\n')) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return meta;
}

export function installed() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(SKILLS_DIR, d.name, 'SKILL.md')))
    .map(d => {
      const meta = frontmatter(fs.readFileSync(path.join(SKILLS_DIR, d.name, 'SKILL.md'), 'utf8'));
      return { dir: d.name, name: meta.name || d.name, description: meta.description || '' };
    });
}

const SOURCES_DIR = path.join(DATA_DIR, 'skill-sources');
const cache = new Map(); // repo -> { at, skills }

function git(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { timeout: 120_000 }, (err, _out, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve()));
  });
}

/** Shallow-clone (or refresh) a skill source repo, then scan it for SKILL.md files. */
async function catalog(repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`"${repo}" is not owner/name`);
  const hit = cache.get(repo);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.skills;
  const dir = path.join(SOURCES_DIR, repo.replace('/', '__'));
  if (fs.existsSync(path.join(dir, '.git'))) await git(['-C', dir, 'pull', '--ff-only', '--depth', '1']).catch(() => {});
  else { fs.mkdirSync(SOURCES_DIR, { recursive: true }); await git(['clone', '--depth', '1', `https://github.com/${repo}.git`, dir]); }

  const skills = [];
  const walk = (d, depth) => {
    if (depth > 5) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name === 'SKILL.md') {
        const meta = frontmatter(fs.readFileSync(full, 'utf8'));
        const rel = path.relative(dir, d) || '.';
        skills.push({ repo, dir: rel, name: meta.name || path.basename(d), description: meta.description || '', src: d });
      }
    }
  };
  walk(dir, 0);
  cache.set(repo, { at: Date.now(), skills });
  return skills;
}

/** Search across the configured skill sources (plus an optional extra repo). */
export async function find(q = '', extraRepo = '') {
  const repos = [...new Set([...store.state.settings.skillSources, extraRepo].filter(Boolean))];
  const have = new Set(installed().map(s => s.name));
  const results = [];
  const errors = [];
  for (const repo of repos) {
    try { results.push(...await catalog(repo)); } catch (e) { errors.push(e.message); }
  }
  const needle = q.toLowerCase();
  return {
    errors,
    skills: results
      .filter(s => !needle || `${s.name} ${s.description}`.toLowerCase().includes(needle))
      .map(({ src, ...s }) => ({ ...s, installed: have.has(s.name) })),
  };
}

export async function install(repo, dir) {
  const skill = (await catalog(repo)).find(s => s.dir === dir);
  if (!skill) throw new Error('skill not found');
  const dest = path.join(SKILLS_DIR, skill.name.replace(/[^a-z0-9_-]/gi, '-'));
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  fs.cpSync(skill.src, dest, { recursive: true, filter: (f) => !path.basename(f).startsWith('.git') });
  store.feed(`Skill "${skill.name}" added to the armory.`, 'info');
  return { name: skill.name, path: dest };
}

export function uninstall(dirName) {
  const target = path.join(SKILLS_DIR, path.basename(dirName));
  if (!target.startsWith(SKILLS_DIR + path.sep)) throw new Error('bad path');
  fs.rmSync(target, { recursive: true, force: true });
  store.changed();
}

// The starter armory: design, frontend, testing, planning, debugging and review.
export const STARTER = {
  'anthropics/skills': ['frontend-design', 'web-artifacts-builder', 'webapp-testing', 'theme-factory', 'canvas-design',
    'brand-guidelines', 'mcp-builder', 'skill-creator', 'doc-coauthoring', 'docx', 'pdf', 'pptx', 'xlsx'],
  'obra/superpowers': ['brainstorming', 'writing-plans', 'executing-plans', 'test-driven-development', 'systematic-debugging',
    'verification-before-completion', 'requesting-code-review', 'receiving-code-review', 'dispatching-parallel-agents',
    'subagent-driven-development', 'finishing-a-development-branch'],
};

/** Install skills by name from the configured sources. Returns what happened. */
export async function installByName(names) {
  const want = new Set(names.map(n => n.toLowerCase()));
  const done = [], missing = [];
  const have = new Set(installed().map(s => s.name.toLowerCase()));
  const repos = [...new Set([...store.state.settings.skillSources, ...Object.keys(STARTER)])];
  for (const repo of repos) {
    let list = [];
    try { list = await catalog(repo); } catch { continue; }
    for (const sk of list) {
      const n = sk.name.toLowerCase();
      if (!want.has(n)) continue;
      want.delete(n);
      if (have.has(n)) { done.push(`${sk.name} (already)`); continue; }
      await install(repo, sk.dir);
      done.push(sk.name);
    }
  }
  missing.push(...want);
  return { installed: done, missing };
}

export function installStarter() {
  return installByName(Object.values(STARTER).flat());
}
