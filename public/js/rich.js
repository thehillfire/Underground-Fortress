// Message rendering shared by every chat: escaped text, ``` code blocks and `inline code`,
// plus copy buttons (whole message, or one code block).

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Text → safe HTML with code blocks. Everything is escaped before any markup is added. */
export function rich(text) {
  const parts = String(text ?? '').split(/```/);
  return parts.map((part, i) => {
    if (i % 2 === 1) {                                   // inside a fence
      const nl = part.indexOf('\n');
      const lang = nl > -1 ? part.slice(0, nl).trim() : '';
      const code = (nl > -1 && /^[\w+#.-]{0,20}$/.test(lang) ? part.slice(nl + 1) : part).replace(/\n$/, '');
      return `<div class="codeblock"><div class="code-head"><span>${esc(lang || 'code')}</span><button type="button" class="copy-btn" data-copy="code">COPY</button></div><pre><code>${esc(code)}</code></pre></div>`;
    }
    return esc(part).replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>');
  }).join('');
}

/** A copy button for a whole message; the raw text rides along in an attribute. */
export const copyBtn = (text) => `<button type="button" class="copy-btn msg-copy" data-copy="msg" data-raw="${esc(text)}" aria-label="Copy message">COPY</button>`;

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = document.createElement('textarea');           // fallback for older WebViews
  ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  return ok;
}

/** One listener for every copy button in the app. */
export function bindCopy(onCopied) {
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('.copy-btn');
    if (!b) return;
    e.stopPropagation();
    const text = b.dataset.copy === 'code' ? b.closest('.codeblock').querySelector('code').textContent : b.dataset.raw;
    const ok = await copyText(text);
    const was = b.textContent;
    b.textContent = ok ? 'COPIED' : 'FAILED';
    b.classList.toggle('done', ok);
    setTimeout(() => { b.textContent = was; b.classList.remove('done'); }, 1400);
    onCopied?.(ok);
  }, true);
}
