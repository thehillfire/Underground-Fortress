// The money gate. Runs as a PreToolUse hook on EVERY tool call of every agent
// (and Lidia), regardless of permission mode. Anything that could move money is
// frozen until Jav approves it in the app. Nothing else can approve it: not
// Lidia, not another agent, not a setting.

const READ_ONLY = /^(list|get|search|retrieve|read|fetch|describe|find|query|lookup|view|show|count|check|preview|estimate|quote|validate|verify)(_|$)/i;

// Services whose write actions move money.
const FINANCE = /(stripe|paypal|square|squareup|shopify|ramp|brex|mercury|wise|transferwise|venmo|cash_?app|coinbase|kraken|binance|robinhood|plaid|airwallex|quickbooks|xero|zoho_?books|gusto|expensify|payoneer|adyen|braintree|klarna|afterpay|revolut|bill_?com|chargebee|recurly|paddle|lemon_?squeezy|gumroad|patreon|ko_?fi|amazon|ebay|instacart|doordash|ubereats|uber|lyft|booking|expedia|airbnb|ticketmaster|godaddy|namecheap|google_?ads|meta_?ads|facebook_?ads|tiktok_?ads|linkedin_?ads)/i;

// Verbs that spend, charge, or commit to paying.
const MONEY_VERB = /(^|[_\W])(pay|pays|payment|payout|purchase|buy|checkout|charge|transfer|send_?money|wire|withdraw|deposit|refund|capture|place_?order|create_?order|submit_?order|subscribe|subscription|top_?up|donate|tip|bid|invoice_?pay|pay_?invoice|reimburse|payroll|run_?payroll|book_?(flight|hotel|ride|trip|ticket)|reserve|renew|upgrade_?plan|add_?funds|create_?campaign|launch_?ad|boost)([_\W]|$)/i;

// Pages/buttons a browser agent should never press on its own.
const CHECKOUT_TEXT = /(checkout|place (your )?order|buy now|purchase|pay now|complete (purchase|payment|order)|confirm (payment|purchase|order)|add (a )?payment|card number|cvv|cvc|billing address|subscribe now|start (paid|subscription)|upgrade (now|plan)|send money|transfer funds|donate)/i;

// Shell commands that hit payment APIs or payment CLIs.
const SHELL_MONEY = /(api\.stripe\.com|\bstripe\s+(charges|payment_intents|payouts|transfers|refunds|checkout|subscriptions|invoices)\b|api(-m)?\.paypal\.com\/v\d\/(payments|checkout)|connect\.squareup\.com\/v2\/payments|api\.coinbase\.com|api\.wise\.com|\bgh\s+sponsor|\bnpm\s+fund\b.*--pay)/i;

/** Luhn check for anything that looks like a card number in tool input. */
function hasCardNumber(text) {
  for (const m of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const d = m[0].replace(/\D/g, '');
    let sum = 0;
    for (let i = 0; i < d.length; i++) {
      let n = +d[d.length - 1 - i];
      if (i % 2) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

/**
 * Is this tool call a money action? Returns a short reason, or null.
 * Errs on the side of asking Jav: a false alarm costs one tap.
 */
export function moneyCheck(toolName, input) {
  const name = String(toolName || '');
  const text = JSON.stringify(input ?? {}).slice(0, 20000);
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  const server = m ? m[1] : '';
  const tool = m ? m[2] : name;

  if (hasCardNumber(text)) return 'a request containing a card number';
  if (m) {
    if (MONEY_VERB.test(tool) && !READ_ONLY.test(tool)) return `${tool.replace(/_/g, ' ')} (moves money)`;
    if (FINANCE.test(server) && !READ_ONLY.test(tool)) return `a ${server.replace(/[_-]+/g, ' ')} change (finance app)`;
    // Generic "run any action" tools (Zapier, Make, n8n, ClickUp operators…): judge what they would run.
    if (/(execute|run|invoke|perform|trigger|call)_?(\w*_)?(action|operator|tool|zap|workflow|automation|scenario)/i.test(tool)
        && (MONEY_VERB.test(text) || (FINANCE.test(text) && /write|create|send|update|post/i.test(tool + text)))) return 'an automation that can move money';
    if (/(browser|playwright|puppeteer|chrome|computer|desktop)/i.test(server + tool) && CHECKOUT_TEXT.test(text)) return 'a click on a checkout or payment page';
  }
  if (name === 'Bash' && SHELL_MONEY.test(text)) return 'a command that calls a payment API';
  if (/^(computer|browser)/i.test(name) && CHECKOUT_TEXT.test(text)) return 'a click on a checkout or payment page';
  return null;
}

/**
 * Build the hooks option for a query. `onMoney(tool, input, reason)` must resolve to
 * true (Jav approved) or false. When it is absent the action is simply denied.
 */
export function moneyHooks(onMoney) {
  return {
    PreToolUse: [{
      timeout: 7 * 24 * 3600,   // Jav may take a while to answer; the agent waits
      hooks: [async (input) => {
        if (input.hook_event_name !== 'PreToolUse') return {};
        const reason = moneyCheck(input.tool_name, input.tool_input);
        if (!reason) return {};
        const ok = onMoney ? await onMoney(input.tool_name, input.tool_input, reason) : false;
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: ok ? 'allow' : 'deny',
            permissionDecisionReason: ok
              ? 'Jav approved this money action.'
              : `Blocked by the money gate (${reason}). Only Jav can approve money. Prepare everything and ask Jav to approve it.`,
          },
        };
      }],
    }],
  };
}
