// Projects are the rooms of the fortress. Each one holds any number of agents
// (Claude sessions) who share the project's folder or repository.
import fs from 'node:fs';
import path from 'node:path';
import { store, id, WORKSPACES } from './store.js';

export const ROOM_TYPES = ['workshop', 'library', 'server', 'lab', 'hall', 'garage', 'vault'];

export const project = (pid) => store.state.projects.find(p => p.id === pid);
export const members = (pid) => store.state.sessions.filter(s => s.projectId === pid);

/** Find a project by id or (partial, case-insensitive) name. */
export function findProject(key) {
  const k = String(key || '').trim().toLowerCase();
  if (!k) return null;
  const all = store.state.projects;
  return all.find(p => p.id === key) || all.find(p => p.name.toLowerCase() === k) || all.find(p => p.name.toLowerCase().includes(k)) || null;
}

/** The project's shared folder: its repository when one is connected, else its own workspace. */
export function projectDir(p) {
  if (p.repoId) {
    const repo = store.state.repos.find(r => r.id === p.repoId);
    if (repo?.status === 'ready') return repo.path;
  }
  const dir = p.dir || path.join(WORKSPACES, p.id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function createProject({ name, goal = '', roomType, repoId = null, auto = false, by = 'jav' }) {
  const st = store.state;
  const p = {
    id: id('p'),
    name: String(name || `Project ${st.projects.length + 1}`).slice(0, 40),
    goal: String(goal || ''),
    roomType: ROOM_TYPES.includes(roomType) ? roomType : ROOM_TYPES[st.projects.length % 4],
    repoId: repoId || null,
    auto,                 // made implicitly for a lone agent; removed again once empty
    createdAt: Date.now(),
  };
  st.projects.push(p);
  if (!auto) store.feed(`${by === 'lidia' ? 'Lidia' : 'Jav'} opened a new project room: ${p.name}.`, 'info');
  store.changed();
  return p;
}

export function updateProject(pid, patch) {
  const p = project(pid);
  if (!p) throw new Error('No such project');
  if ('name' in patch && String(patch.name).trim()) p.name = String(patch.name).trim().slice(0, 40);
  if ('goal' in patch) p.goal = String(patch.goal || '');
  if ('roomType' in patch && ROOM_TYPES.includes(patch.roomType)) p.roomType = patch.roomType;
  if ('repoId' in patch) p.repoId = patch.repoId || null;
  p.auto = false;       // Jav touched it: it's a real project now
  store.changed();
  return p;
}

export function removeProject(pid) {
  if (members(pid).length) throw new Error('Move or evict its agents first');
  store.state.projects = store.state.projects.filter(p => p.id !== pid);
  store.changed();
}

/** Drop rooms that were only ever a lone agent's, once nobody is left in them. */
export function pruneEmpty() {
  const before = store.state.projects.length;
  store.state.projects = store.state.projects.filter(p => !p.auto || members(p.id).length);
  if (store.state.projects.length !== before) store.changed();
}

/** Older fortresses had one room per agent: give each agent a project of its own. */
export function migrate() {
  const st = store.state;
  st.projects ||= [];
  for (const s of st.sessions) {
    if (s.projectId && project(s.projectId)) continue;
    const legacyDir = path.join(WORKSPACES, s.id);
    const p = createProject({ name: s.name, goal: s.goal, roomType: s.roomType, repoId: s.repoId, auto: true });
    p.dir = legacyDir;                 // keep the files it already made
    s.projectId = p.id;
    // The conversation lives with the folder it started in; keep resuming there.
    if (s.sdkSessionId && !s.cwd) s.cwd = s.repoId ? projectDir(p) : legacyDir;
  }
}
