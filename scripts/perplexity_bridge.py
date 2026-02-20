# /// script
# requires-python = ">=3.10"
# dependencies = ["perplexity-webui-scraper"]
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
                     "market_descriptions": [str, ...] (optional, resolution rules) }
Event mode output: { "resolved": bool, "answer": str, "winning_market_index": int|null,
                     "confidence": int, "estimated_end": str|null,
                     "estimated_end_min": str|null, "estimated_end_max": str|null,
                     "reasoning": str }

Market mode input:  { "question": str, "description": str, "end_date": str }
Market mode output: { "resolved": bool, "outcome": str, "confidence": int,
                      "estimated_end": str|null, "estimated_end_min": str|null,
                      "estimated_end_max": str|null, "reasoning": str }
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

    # Build market list with resolution rules when available
    mq_lines = []
    for i, q in enumerate(questions):
        mq_lines.append(f"  {i+1}. {q}")
        if i < len(descriptions) and descriptions[i]:
            # Truncate very long descriptions to save tokens
            rule = descriptions[i][:500]
            mq_lines.append(f"     Resolution rules: {rule}")
    mq_list = "\n".join(mq_lines)

    return (
        f"Today is {_today()}.\n\n"
        f"I need to determine the status of a prediction-market event and "
        f"each of its individual markets.\n\n"
        f"Event: {title}\n"
        f"Description: {desc or '(none)'}\n"
        f"Scheduled end: {end_date or '(none)'}\n\n"
        f"Markets:\n"
        f"{mq_list}\n\n"
        f"Search for the latest news about this event.\n\n"
        f"Rules:\n"
        f"- READ each market's resolution rules carefully. Pay attention to "
        f"exact dates, years, and what YES vs NO means for each market.\n"
        f"- resolved=true ONLY if the outcome is officially confirmed "
        f"(final score, winner declared, bill signed, official announcement). "
        f"Predictions, polls, and forecasts do NOT count.\n"
        f"- For EACH market, give outcome: \"yes\", \"no\", or \"unknown\".\n"
        f"- If not resolved, find the EXACT time the outcome will be known "
        f"(game end, vote result, announcement, deadline).\n"
        f"  - estimated_end: EXACT datetime if known, else null\n"
        f"  - If exact time is unknown, give a range:\n"
        f"    - estimated_end_min: EARLIEST possible\n"
        f"    - estimated_end_max: LATEST possible\n"
        f"  - ALL datetimes must be UTC with seconds: YYYY-MM-DDTHH:MM:SSZ\n"
        f"  - E.g. NBA game tips off 8pm ET → min=2026-02-21T03:00:00Z, max=2026-02-21T04:30:00Z\n"
        f"  - E.g. bill vote Feb 25 2pm ET → exact=2026-02-25T19:00:00Z\n"
        f"  - E.g. deadline end of March → exact=null, min/max=2026-03-31T23:59:59Z\n\n"
        f"CRITICAL formatting rules:\n"
        f"- answer: MAX 10 words. E.g. \"Team A won 3-1\" or "
        f"\"Match starts Feb 22 at 8pm EST\" or \"No result yet, game tomorrow\"\n"
        f"- reasoning: MAX 15 words. E.g. \"Official score confirmed on ESPN\" "
        f"or \"Match scheduled for tomorrow per Liquipedia\"\n\n"
        f"Respond with ONLY raw JSON, no markdown fences:\n"
        f'{{"resolved":true/false,'
        f'"answer":"max 10 words",'
        f'"markets":['
        f'{{"market":1,"outcome":"yes/no/unknown","confidence":0-100}},'
        f'...],'
        f'"confidence":0-100,'
        f'"estimated_end":"YYYY-MM-DDTHH:MM:SSZ or null",'
        f'"estimated_end_min":"YYYY-MM-DDTHH:MM:SSZ or null",'
        f'"estimated_end_max":"YYYY-MM-DDTHH:MM:SSZ or null",'
        f'"reasoning":"max 15 words"}}'
    )


def build_market_prompt(input_data):
    question = input_data.get("question", "")
    description = input_data.get("description", "")
    end_date = input_data.get("end_date", "")

    return (
        f"Today is {_today()}.\n\n"
        f"I need to determine if this prediction-market question has an "
        f"official result yet.\n\n"
        f"Question: {question}\n"
        f"Context: {description or '(none)'}\n"
        f"Scheduled end: {end_date or '(none)'}\n\n"
        f"Search for the latest news.\n\n"
        f"Rules:\n"
        f"- resolved=true ONLY if the outcome is officially confirmed "
        f"(final score, winner declared, official announcement). "
        f"Predictions and forecasts do NOT count.\n"
        f"- If not resolved, find the EXACT time the outcome will be known.\n"
        f"  - estimated_end: exact datetime if known, else null\n"
        f"  - If exact time unknown, give estimated_end_min and estimated_end_max\n"
        f"  - ALL datetimes must be UTC with seconds: YYYY-MM-DDTHH:MM:SSZ\n\n"
        f"CRITICAL formatting rules:\n"
        f"- answer: MAX 10 words.\n"
        f"- reasoning: MAX 15 words.\n\n"
        f"Respond with ONLY raw JSON, no markdown fences:\n"
        f'{{"resolved":true/false,'
        f'"outcome":"yes/no/unknown",'
        f'"confidence":0-100,'
        f'"estimated_end":"YYYY-MM-DDTHH:MM:SSZ or null",'
        f'"estimated_end_min":"YYYY-MM-DDTHH:MM:SSZ or null",'
        f'"estimated_end_max":"YYYY-MM-DDTHH:MM:SSZ or null",'
        f'"reasoning":"max 15 words"}}'
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
        log("INFO", f"REQ #{req_num} [{mode}] \"{label}\"")
        t0 = time.time()

        try:
            result = query_perplexity(client, input_data)
            dur = time.time() - t0
            stats.record_ok(dur)
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
                log("ERROR", f"RATE_LIMITED #{req_num} {dur:.1f}s — {err_str[:200]} | {stats.summary()}")
            elif err_type == "session":
                log("ERROR", f"SESSION_ERR #{req_num} {dur:.1f}s — {err_str[:200]} | {stats.summary()}")
            else:
                log("WARN", f"ERROR #{req_num} {dur:.1f}s [{err_type}] — {err_str[:200]} | {stats.summary()}")

            # Try to recreate client on session/rate errors
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
