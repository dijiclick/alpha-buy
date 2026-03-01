# /// script
# requires-python = ">=3.10"
# dependencies = ["perplexity-webui-scraper>=0.5.0"]
# ///
"""
Bridge script: Node.js calls this via child_process.

Single-shot mode (default):
  Reads JSON from file arg or stdin, returns one JSON result, exits.

Server mode (--server):
  Keeps Perplexity session alive. Reads JSON lines from stdin,
  writes JSON lines to stdout. ~5-10s faster per query after the first.

Event mode input:  { "mode": "event", "event_title": str, "event_description": str,
                     "end_date": str, "market_questions": [str, ...],
                     "market_descriptions": [str, ...] (optional),
                     "market_prices": [float, ...] (optional, current YES prices) }
Event mode output: { "resolved": bool,
                     "markets": [{"market": int, "probability_yes": 0-100, "confidence": 0-100}, ...],
                     "reasoning": str }

Market mode input:  { "question": str, "description": str, "end_date": str,
                      "market_price": float (optional) }
Market mode output: { "resolved": bool, "probability_yes": 0-100, "confidence": 0-100,
                      "reasoning": str }
"""

import json
import sys
import os
import time

from perplexity_webui_scraper import Perplexity

# ─── Logging (all logs go to stderr so stdout stays clean JSON) ───

RATE_LIMIT_PATTERNS = [
    "rate limit", "rate_limit", "ratelimit", "too many requests",
    "429", "quota", "throttl", "try again later", "slow down",
    "temporarily unavailable", "capacity",
]

SESSION_ERROR_PATTERNS = [
    "401", "403", "unauthorized", "forbidden", "session",
    "expired", "invalid token", "login", "captcha", "cloudflare",
]


class BridgeStats:
    def __init__(self):
        self.total_requests = 0
        self.total_ok = 0
        self.total_errors = 0
        self.total_parse_errors = 0
        self.total_rate_limits = 0
        self.total_session_errors = 0
        self.total_other_errors = 0
        self.client_recreations = 0
        self.times = []           # last N request durations
        self.errors = []          # last N error entries
        self.started_at = time.time()
        self._MAX_HISTORY = 100

    def record_ok(self, duration):
        self.total_requests += 1
        self.total_ok += 1
        self.times.append(duration)
        if len(self.times) > self._MAX_HISTORY:
            self.times.pop(0)

    def record_error(self, duration, error_type, message):
        self.total_requests += 1
        self.total_errors += 1
        if error_type == "rate_limit":
            self.total_rate_limits += 1
        elif error_type == "session":
            self.total_session_errors += 1
        elif error_type == "parse":
            self.total_parse_errors += 1
        else:
            self.total_other_errors += 1
        entry = {
            "at": time.strftime("%H:%M:%S"),
            "type": error_type,
            "msg": message[:200],
            "dur": round(duration, 1),
            "req_num": self.total_requests,
        }
        self.errors.append(entry)
        if len(self.errors) > self._MAX_HISTORY:
            self.errors.pop(0)

    def avg_time(self):
        return round(sum(self.times) / len(self.times), 1) if self.times else 0

    def summary(self):
        uptime = round(time.time() - self.started_at)
        m, s = divmod(uptime, 60)
        h, m = divmod(m, 60)
        return (
            f"reqs={self.total_requests} ok={self.total_ok} "
            f"err={self.total_errors}(rate={self.total_rate_limits} "
            f"sess={self.total_session_errors} parse={self.total_parse_errors} "
            f"other={self.total_other_errors}) "
            f"avg={self.avg_time()}s recreates={self.client_recreations} "
            f"uptime={h:.0f}h{m:.0f}m{s:.0f}s"
        )


stats = BridgeStats()


def log(level, msg):
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] [{level}] {msg}", file=sys.stderr, flush=True)


def classify_error(error_str):
    low = error_str.lower()
    for pat in RATE_LIMIT_PATTERNS:
        if pat in low:
            return "rate_limit"
    for pat in SESSION_ERROR_PATTERNS:
        if pat in low:
            return "session"
    return "other"


def _today():
    from datetime import date
    return date.today().isoformat()


def build_event_prompt(input_data):
    title = input_data.get("event_title", "")
    desc = input_data.get("event_description", "")
    end_date = input_data.get("end_date", "")
    questions = input_data.get("market_questions", [])
    descriptions = input_data.get("market_descriptions", [])
    prices = input_data.get("market_prices", [])

    # Build market list with resolution rules and current prices
    mq_lines = []
    for i, q in enumerate(questions):
        price_info = ""
        if i < len(prices) and prices[i] is not None:
            price_info = f" [Current market YES price: {prices[i]}]"
        mq_lines.append(f"  {i+1}. {q}{price_info}")
        if i < len(descriptions) and descriptions[i]:
            rule = descriptions[i][:500]
            mq_lines.append(f"     Resolution rules: {rule}")
    mq_list = "\n".join(mq_lines)

    return (
        f"Today is {_today()}.\n\n"
        f"I need you to estimate the PROBABILITY of each market outcome "
        f"based on current real-world evidence. This is for a prediction market "
        f"event ending soon.\n\n"
        f"Event: {title}\n"
        f"Description: {desc or '(none)'}\n"
        f"Scheduled end: {end_date or '(none)'}\n\n"
        f"Markets:\n"
        f"{mq_list}\n\n"
        f"Search for the LATEST news, official statements, data, polls, "
        f"expert analysis, and any relevant information about this event.\n\n"
        f"Rules:\n"
        f"- For EACH market, estimate probability_yes (0-100): the percentage "
        f"chance that YES wins.\n"
        f"- Base your estimate on CONCRETE evidence: official statements, "
        f"polls, expert analysis, historical patterns, recent developments.\n"
        f"- Be well-calibrated: 50 = true toss-up, 80+ = strong evidence, "
        f"95+ = near-certain.\n"
        f"- If the event is ALREADY officially resolved, set resolved=true "
        f"and probability_yes to 100 (YES won) or 0 (NO won).\n"
        f"- confidence (0-100) = how confident you are in your probability "
        f"estimate. High confidence means strong evidence exists.\n"
        f"- DO NOT simply echo the market price. Form your OWN independent "
        f"estimate from the evidence you find.\n\n"
        f"CRITICAL formatting rules:\n"
        f"- reasoning: cite SPECIFIC evidence (max 30 words). "
        f"E.g. \"Reuters reports bill passed Senate 52-48\" or "
        f"\"Latest polls show 65% support, committee approved unanimously\"\n\n"
        f"Respond with ONLY raw JSON, no markdown fences:\n"
        f'{{"resolved":false,'
        f'"markets":['
        f'{{"market":1,"probability_yes":0-100,"confidence":0-100}},'
        f'...],'
        f'"reasoning":"cite specific evidence, max 30 words"}}'
    )


def build_market_prompt(input_data):
    question = input_data.get("question", "")
    description = input_data.get("description", "")
    end_date = input_data.get("end_date", "")
    price = input_data.get("market_price", None)

    price_info = f"\nCurrent market YES price: {price}" if price is not None else ""

    return (
        f"Today is {_today()}.\n\n"
        f"I need you to estimate the probability that this prediction market "
        f"question resolves YES, based on real-world evidence.\n\n"
        f"Question: {question}\n"
        f"Context: {description or '(none)'}\n"
        f"Scheduled end: {end_date or '(none)'}\n"
        f"{price_info}\n\n"
        f"Search for the latest news, data, and analysis.\n\n"
        f"Rules:\n"
        f"- Estimate probability_yes (0-100): the chance YES wins.\n"
        f"- Base on concrete evidence: official sources, polls, expert analysis.\n"
        f"- Be calibrated: 50 = toss-up, 80+ = strong evidence, 95+ = near-certain.\n"
        f"- If already officially resolved, set resolved=true and "
        f"probability_yes to 100 (YES won) or 0 (NO won).\n"
        f"- DO NOT simply echo the market price. Form your OWN estimate.\n\n"
        f"Respond with ONLY raw JSON, no markdown fences:\n"
        f'{{"resolved":false,'
        f'"probability_yes":0-100,'
        f'"confidence":0-100,'
        f'"reasoning":"cite specific evidence, max 30 words"}}'
    )


def parse_answer(answer):
    """Extract JSON from a Perplexity response that may contain markdown fences."""
    cleaned = answer
    if "```json" in cleaned:
        cleaned = cleaned.split("```json", 1)[1]
    if "```" in cleaned:
        cleaned = cleaned.split("```", 1)[0]
    cleaned = cleaned.strip()
    return json.loads(cleaned)


def sanitize_text(text):
    """Remove lone surrogates and other non-UTF-8 characters from text."""
    if not text:
        return text
    # encode to utf-8 with surrogateescape, then decode back dropping bad chars
    return text.encode('utf-8', errors='ignore').decode('utf-8')


def query_perplexity(client, input_data):
    """Run a single query. Returns parsed dict or raises."""
    # Sanitize all string fields to avoid encoding errors
    for key in list(input_data.keys()):
        val = input_data[key]
        if isinstance(val, str):
            input_data[key] = sanitize_text(val)
        elif isinstance(val, list):
            input_data[key] = [sanitize_text(v) if isinstance(v, str) else v for v in val]

    mode = input_data.get("mode", "market")
    if mode == "event":
        prompt = build_event_prompt(input_data)
    else:
        prompt = build_market_prompt(input_data)

    conversation = client.create_conversation()
    conversation.ask(prompt)
    return parse_answer(conversation.answer)


# ─── Server mode ───

def server_mode(session_token):
    """Persistent: read JSON lines from stdin, write JSON lines to stdout."""
    log("INFO", "Bridge starting in server mode...")
    client = Perplexity(session_token=session_token)
    log("INFO", "Perplexity client initialized, ready for queries")

    cooldown_base = max(1, int(os.environ.get("PERPLEXITY_RATE_LIMIT_COOLDOWN_SEC", "30")))
    cooldown_max = max(cooldown_base, int(os.environ.get("PERPLEXITY_RATE_LIMIT_MAX_COOLDOWN_SEC", "300")))
    rate_limited_until = 0.0
    consecutive_rate_limits = 0

    while True:
        line = sys.stdin.readline()
        if not line:  # EOF — parent closed stdin
            log("INFO", f"EOF received, shutting down. Final stats: {stats.summary()}")
            break
        line = line.strip()
        if not line:
            continue

        label = ""
        try:
            input_data = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({"error": f"Invalid input JSON: {e}"}), flush=True)
            continue

        mode = input_data.get("mode", "market")
        if mode == "event":
            label = input_data.get("event_title", "?")[:60]
        else:
            label = input_data.get("question", "?")[:60]

        req_num = stats.total_requests + 1
        now_ts = time.time()
        if now_ts < rate_limited_until:
            wait = rate_limited_until - now_ts
            log("WARN", f"COOLDOWN before req #{req_num}: sleeping {wait:.1f}s")
            time.sleep(wait)

        log("INFO", f"REQ #{req_num} [{mode}] \"{label}\"")
        t0 = time.time()

        try:
            result = query_perplexity(client, input_data)
            dur = time.time() - t0
            stats.record_ok(dur)
            consecutive_rate_limits = 0
            rate_limited_until = 0.0
            log("INFO", f"OK  #{req_num} {dur:.1f}s conf={result.get('confidence', '?')} | {stats.summary()}")
            print(json.dumps(result), flush=True)

        except json.JSONDecodeError:
            dur = time.time() - t0
            stats.record_error(dur, "parse", "Could not parse Perplexity response as JSON")
            log("WARN", f"PARSE_ERROR #{req_num} {dur:.1f}s — response was not valid JSON | {stats.summary()}")
            print(json.dumps({"error": "Could not parse Perplexity response as JSON"}), flush=True)

        except Exception as e:
            dur = time.time() - t0
            err_str = str(e)
            err_type = classify_error(err_str)
            stats.record_error(dur, err_type, err_str)

            if err_type == "rate_limit":
                consecutive_rate_limits += 1
                cooldown = min(cooldown_base * (2 ** (consecutive_rate_limits - 1)), cooldown_max)
                rate_limited_until = time.time() + cooldown
                log("ERROR", f"RATE_LIMITED #{req_num} {dur:.1f}s — cooldown={cooldown:.0f}s — {err_str[:200]} | {stats.summary()}")
            elif err_type == "session":
                consecutive_rate_limits = 0
                rate_limited_until = 0.0
                log("ERROR", f"SESSION_ERR #{req_num} {dur:.1f}s — {err_str[:200]} | {stats.summary()}")
            else:
                consecutive_rate_limits = 0
                rate_limited_until = 0.0
                log("WARN", f"ERROR #{req_num} {dur:.1f}s [{err_type}] — {err_str[:200]} | {stats.summary()}")

            # Recreate client only for session failures.
            if err_type == "session":
                try:
                    client = Perplexity(session_token=session_token)
                    stats.client_recreations += 1
                    log("INFO", f"Client recreated (#{stats.client_recreations})")
                except Exception as re_err:
                    log("ERROR", f"Client recreation FAILED: {re_err}")

            print(json.dumps({"error": err_str}), flush=True)

        # Periodic summary every 10 requests
        if stats.total_requests % 10 == 0:
            log("INFO", f"STATS {stats.summary()}")
            if stats.errors:
                recent = stats.errors[-3:]
                for e in recent:
                    log("INFO", f"  recent_err: req#{e['req_num']} {e['type']} {e['dur']}s {e['msg'][:80]}")


# ─── Single-shot mode (backward compat) ───

def single_shot_mode(session_token):
    raw = sys.stdin.read() if not sys.stdin.isatty() else ""

    if not raw:
        # Check for file argument, skipping flags
        for arg in sys.argv[1:]:
            if not arg.startswith("-"):
                with open(arg, "r") as f:
                    raw = f.read()
                break

    if not raw:
        print(json.dumps({"error": "No input provided (stdin or file arg)"}))
        sys.exit(1)

    try:
        input_data = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid input JSON: {e}"}))
        sys.exit(1)

    try:
        client = Perplexity(session_token=session_token)
        result = query_perplexity(client, input_data)
        print(json.dumps(result))
    except json.JSONDecodeError:
        print(json.dumps({"error": "Could not parse Perplexity response as JSON"}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


def main():
    session_token = os.environ.get("PERPLEXITY_SESSION_TOKEN", "")
    if not session_token:
        print(json.dumps({"error": "PERPLEXITY_SESSION_TOKEN not set"}))
        sys.exit(1)

    if "--server" in sys.argv:
        server_mode(session_token)
    else:
        single_shot_mode(session_token)


if __name__ == "__main__":
    main()
