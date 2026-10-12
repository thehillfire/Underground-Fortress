// Repositories are cloned into workspaces/repos and can be assigned to rooms.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { store, id, WORKSPACES } from './store.js';

const REPOS_DIR = path.join(WORKSPACES, 'repos');

function nameFrom(url) {
  return url.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).slice(-2).join('-').replace(/[^a-z0-9_.-]/gi, '-');
}

export function connect(url) {
  url = String(url || '').trim();
  if (!/^(https:\/\/|git@|ssh:\/\/)/.test(url) && !/^[\w.-]+\/[\w.-]+$/.test(url)) throw new Error('Use a git URL or owner/repo');
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}.git`;
  const name = nameFrom(url);
  const repo = { id: id('r'), url, name, path: path.join(REPOS_DIR, name), status: 'cloning', error: null };
  store.state.repos.push(repo);
  store.changed();
  fs.mkdirSync(REPOS_DIR, { recursive: true });

  const finish = (code, err) => {
    repo.status = code === 0 ? 'ready' : 'error';
    repo.error = code === 0 ? null : err.slice(-400);
    store.feed(code === 0 ? `Repository ${name} hauled in.` : `Could not clone ${name}.`, code === 0 ? 'info' : 'alert');
  };
  if (fs.existsSync(path.join(repo.path, '.git'))) {
    const p = spawn('git', ['-C', repo.path, 'pull', '--ff-only']);
    let err = ''; p.stderr.on('data', d => { err += d; });
    p.on('close', (code) => finish(0, err)); // already present: usable even if pull fails
  } else {
    const p = spawn('git', ['clone', url, repo.path]);
    let err = ''; p.stderr.on('data', d => { err += d; });
    p.on('close', (code) => finish(code, err));
  }
  return repo;
}

export function disconnect(rid) {
  const st = store.state;
  st.repos = st.repos.filter(r => r.id !== rid);
  for (const p of st.projects || []) if (p.repoId === rid) p.repoId = null;
  store.changed(); // the clone stays on disk; delete workspaces/repos/<name> to reclaim it
}
