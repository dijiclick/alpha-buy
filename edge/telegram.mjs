function escHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pct(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '?';
  return `${n.toFixed(1)}%`;
}

function price(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '?';
  return n.toFixed(2);
}

function short(text, max = 120) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}

export async function sendEdgeTelegramAlert(prediction, context = {}) {
  const botToken = context.botToken;
  const chatId = context.chatId;
  if (!botToken || !chatId) {
    return { ok: false, status: 0, error: 'missing_telegram_credentials' };
  }

  const lines = [];

  // Header
  const emoji = prediction.predicted_outcome === 'yes' ? '\u{1F7E2}' : '\u{1F534}';
  lines.push(`${emoji} <b>PREDICTION SIGNAL</b> | ${pct(prediction.probability)} confident`);
  lines.push('');

  // Event
  lines.push(`<b>${escHtml(prediction.event_title)}</b>`);
  lines.push('');

  // Market question
  lines.push(`<b>Market:</b> ${escHtml(short(prediction.market_question))}`);
  lines.push('');

  // AI prediction
  const outcomeLabel = prediction.predicted_outcome.toUpperCase();
  lines.push(`<b>AI Prediction:</b> ${outcomeLabel} (${pct(prediction.probability)})`);

  // Current prices
  if (prediction.yes_price != null) {
    lines.push(`<b>Current Price:</b> YES ${price(prediction.yes_price)} / NO ${price(prediction.no_price)}`);
  }

  // Profit
  if (prediction.profit_pct != null) {
    lines.push(`<b>Profit:</b> ~${pct(prediction.profit_pct)}`);
  }

  // Divergence
  if (prediction.divergence != null) {
    lines.push(`<b>Divergence:</b> ${pct(prediction.divergence * 100)}`);
  }

  lines.push('');

  // Reasoning
  if (prediction.reasoning) {
    lines.push(`<i>${escHtml(short(prediction.reasoning, 200))}</i>`);
    lines.push('');
  }

  // Action
  const buyOutcome = prediction.predicted_outcome.toUpperCase();
  const buyPrice = prediction.predicted_outcome === 'yes' ? prediction.yes_price : prediction.no_price;
  if (buyPrice != null) {
    lines.push(`<b>Action:</b> Buy ${buyOutcome} @ ${price(buyPrice)}`);
    lines.push('');
  }

  // End date
  if (prediction.event_end_date) {
    const d = new Date(prediction.event_end_date);
    if (!isNaN(d.getTime())) {
      const fmt = d.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
      lines.push(`\u{1F4C5} ${fmt} ET`);
    }
  }

  // Links
  const eventUrl = prediction.event_url || '';
  const marketUrl = prediction.market_url || '';
  if (eventUrl) lines.push(`<a href="${escHtml(eventUrl)}">Event</a>`);
  if (marketUrl && marketUrl !== eventUrl) lines.push(`<a href="${escHtml(marketUrl)}">Market</a>`);

  const payload = {
    chat_id: chatId,
    text: lines.join('\n'),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        status: res.status,
        error: `telegram_status_${res.status}:${body.slice(0, 160)}`,
      };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: `telegram_fetch_${String(e?.message || e).slice(0, 160)}` };
  }
}
