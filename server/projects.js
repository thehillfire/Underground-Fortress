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

export const LIFECYCLES = ['persistent', 'ephemeral'];
export function createProject({ name, goal = '', roomType, repoId = null, auto = false, by = 'jav', lifecycle = 'persistent', parent = null }) {
  const st = store.state;
  const p = {
    id: id('p'),
    name: String(name || `Project ${st.projects.length + 1}`).slice(0, 40),
    goal: String(goal || ''),
    roomType: ROOM_TYPES.includes(roomType) ? roomType : ROOM_TYPES[st.projects.length % 4],
    repoId: repoId || null,
    auto,                 // made implicitly for a lone agent; removed again once empty
    lifecycle: LIFECYCLES.includes(lifecycle) ? lifecycle : 'persistent',   // ephemeral rooms archive themselves when all their agents are done
    parent: st.projects.some(x => x.id === parent) ? parent : null,          // nested rooms
    archived: false,
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
  if (LIFECYCLES.includes(patch.lifecycle)) p.lifecycle = patch.lifecycle;
  if ('parent' in patch) p.parent = patch.parent && patch.parent !== pid && project(patch.parent) && !isAncestor(pid, patch.parent) ? patch.parent : null;
  p.auto = false;       // Jav touched it: it's a real project now
  store.changed();
  return p;
}

const isAncestor = (anc, pid) => { for (let p = project(pid), n = 0; p && n < 20; p = project(p.parent), n++) if (p.parent === anc) return true; return false; };

/** Archive: hide the room (and its idle agents) without deleting anything. Refuses while an agent is working. */
export function archiveProject(pid) {
  const p = project(pid);
  if (!p) throw new Error('No such project');
  if (members(pid).some(s => ['working', 'reporting', 'needs_jav'].includes(s.status))) throw new Error('An agent in this room is still busy or waiting on Jav.');
  p.archived = true; p.archivedAt = Date.now();
  store.feed(`Room ${p.name} archived.`, 'info');
  store.changed();
  return p;
}
export function restoreProject(pid) {
  const p = project(pid);
  if (!p) throw new Error('No such project');
  p.archived = false; delete p.archivedAt;
  store.changed();
  return p;
}
/** Ephemeral rooms close themselves once everyone in them has finished. */
export function sweepEphemeral() {
  for (const p of store.state.projects) {
    const m = members(p.id);
    if (p.lifecycle === 'ephemeral' && !p.archived && m.length && m.every(s => s.status === 'done')) { p.archived = true; p.archivedAt = Date.now(); store.feed(`Ephemeral room ${p.name} finished and was archived.`, 'info'); store.changed(); }
  }
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
