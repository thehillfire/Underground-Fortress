// Text-message reactions. Lidia and the agents react to Jav's texts (fast answers with
// character); Jav reacts to theirs, and they hear about it with his next message.
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { store } from './store.js';

export const EMOJI = ['👍', '👎', '❤️', '💀', '😂', '‼️', '❓', '🔥', '👀'];
export const MEANING = '👍 yes / done / agreed, 👎 no / didn\'t happen / won\'t work, ❤️ thanks / love it, 💀 that failed badly or is absurd, 😂 funny, ‼️ urgent / important, ❓ unclear, 🔥 great result, 👀 looking into it';

/** Set (or toggle off) `by`'s reaction on a message. by: 'jav' or 'peer' (Lidia / the agent). */
export function setReaction(msg, by, emoji) {
  msg.reactions ||= {};
  if (!emoji || msg.reactions[by] === emoji) delete msg.reactions[by];
  else msg.reactions[by] = emoji;
  store.changed();
}

const lastFromJav = (list) => [...list].reverse().find(m => m.role === 'jav');

/** The react tool, for Lidia (list = her chat) or an agent (list = its log). */
export function reactTool(getList) {
  return tool('react', `React to Jav's latest text with an emoji, like a reaction in a messaging app. It shows on his message right away, so react FIRST, then reply. Meanings: ${MEANING}. A reaction can be the whole answer to a quick yes/no; otherwise follow it with a short reply.`,
    { emoji: z.enum(EMOJI) },
    async ({ emoji }) => {
      const m = lastFromJav(getList());
      if (!m) return { content: [{ type: 'text', text: 'No message from Jav to react to.' }], isError: true };
      setReaction(m, 'peer', emoji);
      return { content: [{ type: 'text', text: `Reacted ${emoji}.` }] };
    });
}

/** Jav reacts to a message from Lidia ('lidia') or an agent (session id). Returns the note to pass on. */
export function javReacts(owner, ts, emoji) {
  if (emoji && !EMOJI.includes(emoji)) throw new Error('Unknown reaction');
  const st = store.state;
  const holder = owner === 'lidia' ? st : st.sessions.find(s => s.id === owner);
  if (!holder) throw new Error('No such chat');
  const list = owner === 'lidia' ? st.lidiaChat : holder.log;
  const msg = list.find(m => m.ts === Number(ts) && m.role !== 'jav');
  if (!msg) throw new Error('No such message');
  setReaction(msg, 'jav', emoji);
  if (msg.reactions?.jav) {
    holder.reactNotes = [...(holder.reactNotes || []), `Jav reacted ${emoji} to your message: "${String(msg.text).slice(0, 120)}"`].slice(-5);
  }
  return msg;
}

/** Notes about Jav's reactions since the last message, prepended once to the next one. */
export function takeNotes(holder) {
  const n = holder.reactNotes;
  if (!n?.length) return '';
  delete holder.reactNotes;
  return `[${n.join(' · ')}]\n\n`;
}
