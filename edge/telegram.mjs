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
  return `${(n * 100).toFixed(2)}%`;
}

function num(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '?';
  return n.toFixed(4);
}

function short(text, max = 95) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}

export async function sendEdgeTelegramAlert(opportunity, context = {}) {
  const botToken = context.botToken;
  const chatId = context.chatId;
  if (!botToken || !chatId) {
    return { ok: false, status: 0, error: 'missing_telegram_credentials' };
  }

  const lines = [];
  lines.push('<b>EDGE SIGNAL</b>');
  lines.push(
    `${escHtml(opportunity.type)} | edge <b>${pct(opportunity.net_edge)}</b> | conf <b>${Number(opportunity.confidence || 0)}%</b>`
  );
  lines.push('');
  lines.push(`<b>${escHtml(opportunity.event_title)}</b>`);
  lines.push(`<i>${escHtml(opportunity.strategy)}</i>`);
  lines.push('');
  lines.push(`A: ${escHtml(short(opportunity.market_a_question))} (${pct(opportunity.market_a_yes)})`);
  lines.push(`B: ${escHtml(short(opportunity.market_b_question))} (${pct(opportunity.market_b_yes)})`);
  if (Number.isFinite(Number(opportunity.gross_edge))) {
    lines.push(`gross ${pct(opportunity.gross_edge)} | net ${pct(opportunity.net_edge)}`);
  }

  if (Number.isFinite(Number(opportunity.live_total_cost))) {
    lines.push(`live total cost: ${num(opportunity.live_total_cost)}`);
  }

  if (opportunity.live_quote_source) {
    lines.push(`source: ${escHtml(opportunity.live_quote_source)}`);
  }

  const qa = opportunity.live_quotes?.market_a;
  const qb = opportunity.live_quotes?.market_b;
  if (qa) {
    lines.push(`A YES ask ${num(qa.yesAsk)} | A NO ask ${num(qa.noAsk)}`);
  }
  if (qb) {
    lines.push(`B YES ask ${num(qb.yesAsk)} | B NO ask ${num(qb.noAsk)}`);
  }

  const costDrift = Number(opportunity.live_cost_drift);
  if (Number.isFinite(costDrift)) {
    lines.push(`cost drift: ${pct(costDrift)}`);
  }

  const drift = Number(opportunity.live_price_drift_max);
  if (Number.isFinite(drift)) {
    lines.push(`yes drift(max): ${pct(drift)}`);
  }

  const evUrl = opportunity.market_a_url || opportunity.market_b_url || '';
  const mkA = opportunity.market_a_url || '';
  const mkB = opportunity.market_b_url || '';
  lines.push('');
  if (evUrl) lines.push(`<a href="${escHtml(evUrl)}">Open</a>`);
  if (mkA && mkB && mkA !== mkB) {
    lines.push(`<a href="${escHtml(mkA)}">Market A</a> | <a href="${escHtml(mkB)}">Market B</a>`);
  }

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
