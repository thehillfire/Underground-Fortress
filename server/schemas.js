// Strict input validation for the API. Anything not matching is rejected before it reaches the logic.
import { z } from 'zod';
import { PERMISSION_MODES } from './store.js';
import { TYPES } from './bus.js';
import { STATUSES } from './tasks.js';

const text = (max = 8000) => z.string().max(max);
const name = z.string().trim().min(1).max(80);
const file = z.object({ name: z.string().max(200), type: z.string().max(100).optional(), data: z.string().max(60_000_000) }).passthrough();

export const schemas = {
  session: z.object({ name, goal: text(4000).optional(), projectId: z.string().max(40).optional(), project: z.string().max(80).optional(), roomType: z.string().max(40).optional(),
    repoId: z.string().max(40).optional(), model: z.string().max(80).optional(), effort: z.string().max(20).optional(), permissionMode: z.enum(PERMISSION_MODES).optional() }).passthrough(),
  message: z.object({ text: text(20000).default(''), files: z.array(file).max(10).optional() }),
  lidia: z.object({ text: text(20000).default(''), files: z.array(file).max(10).optional() }),
  directive: z.object({ text: z.string().trim().min(1).max(400) }),
  task: z.object({ title: z.string().trim().min(1).max(160), detail: text(4000).optional(), owner: z.string().max(80).optional(), deps: z.array(z.string().max(40)).max(20).optional(),
    criteria: text(800).optional(), constraints: text(800).optional(), escalateIf: text(500).optional(), priority: z.number().min(0).max(100).optional() }),
  taskPatch: z.object({ status: z.enum(STATUSES), note: text(2000).optional() }),
  bus: z.object({ to: z.string().min(1).max(80), type: z.enum(TYPES).default('NOTIFY'), topic: z.string().max(80).optional(), body: text(6000) }),
  artifact: z.object({ name: z.string().min(1).max(80), content: z.string().max(2_000_000), note: z.string().max(200).optional() }),
  kill: z.object({ reason: z.string().max(200).optional() }),
  login: z.object({ passphrase: z.string().min(1).max(200), code: z.string().max(10).optional() }),
  setup: z.object({ passphrase: z.string().min(10).max(200), mfa: z.boolean().optional() }),
  erase: z.object({ confirm: z.literal('ERASE EVERYTHING') }),
};
