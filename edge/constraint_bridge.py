# /// script
# requires-python = ">=3.10"
# dependencies = ["perplexity-webui-scraper"]
# ///
"""
Standalone Perplexity bridge for logical-constraint analysis between two markets.

Protocol (JSON line in, JSON line out):
Input:
{
  "event_title": "...",
  "event_description": "...",
  "scheduled_end": "2026-02-22T20:00:00Z",
  "market_a": {"id": "...", "question": "...", "description": "...", "yes_price": 0.62},
  "market_b": {"id": "...", "question": "...", "description": "...", "yes_price": 0.55}
}

Output:
{
  "relation": "equivalent|mutually_exclusive|a_implies_b|b_implies_a|unrelated",
  "exhaustive": false,
  "impossible_yes": ["a"|"b", ...],
  "confidence": 0-100,
  "reason": "...",
  "evidence": [{"title":"...","date":"YYYY-MM-DD or unknown","url":"https://..."}, ...]
}
"""

import json
import os
import sys
import time
from datetime import date

from perplexity_webui_scraper import Perplexity

RATE_LIMIT_PATTERNS = [
    "rate limit",
    "rate_limit",
    "ratelimit",
    "too many requests",
    "429",
    "quota",
    "throttl",
    "try again later",
    "slow down",
    "temporarily unavailable",
    "capacity",
]

SESSION_ERROR_PATTERNS = [
    "401",
    "403",
    "unauthorized",
    "forbidden",
    "session",
    "expired",
    "invalid token",
    "login",
    "captcha",
    "cloudflare",
]

RELATION_ALIASES = {
    "equivalent": "equivalent",
    "same": "equivalent",
    "same_truth_value": "equivalent",
    "mutually_exclusive": "mutually_exclusive",
    "mutex": "mutually_exclusive",
    "cannot_both_be_true": "mutually_exclusive",
    "a_implies_b": "a_implies_b",
    "implies_a_to_b": "a_implies_b",
    "a=>b": "a_implies_b",
    "b_implies_a": "b_implies_a",
    "implies_b_to_a": "b_implies_a",
    "b=>a": "b_implies_a",
    "unrelated": "unrelated",
    "independent": "unrelated",
    "none": "unrelated",
}


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
    return date.today().isoformat()


def _safe_str(value):
    if value is None:
        return ""
    return str(value)


def sanitize_text(text):
    if not text:
        return text
    return text.encode("utf-8", errors="ignore").decode("utf-8")


def _normalize_relation(raw):
    key = _safe_str(raw).strip().lower().replace(" ", "_")
    return RELATION_ALIASES.get(key, "unrelated")


def _normalize_impossible(raw):
    if isinstance(raw, str):
        raw_items = [x.strip().lower() for x in raw.replace(";", ",").split(",")]
    elif isinstance(raw, list):
        raw_items = [_safe_str(x).strip().lower() for x in raw]
    else:
        raw_items = []

    out = []
    for item in raw_items:
        if item in ("a", "market_a", "a_yes", "yes_a"):
            out.append("a")
        elif item in ("b", "market_b", "b_yes", "yes_b"):
            out.append("b")
    # dedupe, stable order
    deduped = []
    for x in out:
        if x not in deduped:
            deduped.append(x)
    return deduped


def _normalize_evidence(raw):
    if not isinstance(raw, list):
        return []

    out = []
    for item in raw[:4]:
        if isinstance(item, dict):
            title = _safe_str(item.get("title", "")).strip()
            dt = _safe_str(item.get("date", "")).strip()
            url = _safe_str(item.get("url", "")).strip()
        else:
            title = _safe_str(item).strip()
            dt = "unknown"
            url = ""
        if not title and not url:
            continue
        out.append(
            {
                "title": title[:180],
                "date": dt if dt else "unknown",
                "url": url[:500],
            }
        )
    return out


def build_prompt(input_data):
    event_title = sanitize_text(_safe_str(input_data.get("event_title", "")))
    event_desc = sanitize_text(_safe_str(input_data.get("event_description", "")))
    scheduled_end = sanitize_text(_safe_str(input_data.get("scheduled_end", "")))

    market_a = input_data.get("market_a", {}) or {}
    market_b = input_data.get("market_b", {}) or {}

    q_a = sanitize_text(_safe_str(market_a.get("question", "")))
    d_a = sanitize_text(_safe_str(market_a.get("description", "")))
    p_a = _safe_str(market_a.get("yes_price", ""))

    q_b = sanitize_text(_safe_str(market_b.get("question", "")))
    d_b = sanitize_text(_safe_str(market_b.get("description", "")))
    p_b = _safe_str(market_b.get("yes_price", ""))

    return (
        f"Today is {_today()}.\n\n"
        f"You are validating prediction-market logic constraints for potential mispricing.\n"
        f"Use official sources and latest confirmed facts.\n\n"
        f"Event: {event_title}\n"
        f"Event context: {event_desc or '(none)'}\n"
        f"Scheduled end: {scheduled_end or '(none)'}\n\n"
        f"Market A (YES outcome):\n"
        f"- Question: {q_a}\n"
        f"- Resolution context: {d_a or '(none)'}\n"
        f"- Current YES price: {p_a}\n\n"
        f"Market B (YES outcome):\n"
        f"- Question: {q_b}\n"
        f"- Resolution context: {d_b or '(none)'}\n"
        f"- Current YES price: {p_b}\n\n"
        f"Tasks:\n"
        f"1) Classify logical relation between YES(A) and YES(B):\n"
        f"   - equivalent\n"
        f"   - mutually_exclusive (cannot both be true)\n"
        f"   - a_implies_b\n"
        f"   - b_implies_a\n"
        f"   - unrelated\n"
        f"2) If relation is mutually_exclusive, set exhaustive=true only if exactly one must be true.\n"
        f"3) Detect if YES(A) or YES(B) is already impossible now from official facts "
        f"(e.g., eliminated team, deadline passed, official disqualification).\n"
        f"4) Give concise evidence with date and URL.\n\n"
        f"Rules:\n"
        f"- Be conservative. If uncertain, choose unrelated and no impossible outcomes.\n"
        f"- impossible_yes can only include \"a\" and/or \"b\".\n"
        f"- confidence is 0-100.\n"
        f"- reason max 25 words.\n\n"
        f"Respond with ONLY raw JSON, no markdown fences:\n"
        f'{{"relation":"equivalent|mutually_exclusive|a_implies_b|b_implies_a|unrelated",'
        f'"exhaustive":true/false,'
        f'"impossible_yes":["a|b",...],'
        f'"confidence":0-100,'
        f'"reason":"max 25 words",'
        f'"evidence":[{{"title":"...","date":"YYYY-MM-DD or unknown","url":"https://..."}},...]}}'
    )


def parse_answer(answer):
    cleaned = answer
    if "```json" in cleaned:
        cleaned = cleaned.split("```json", 1)[1]
    if "```" in cleaned:
        cleaned = cleaned.split("```", 1)[0]
    cleaned = cleaned.strip()
    raw = json.loads(cleaned)

    relation = _normalize_relation(raw.get("relation"))
    exhaustive = bool(raw.get("exhaustive", False))
    impossible_yes = _normalize_impossible(raw.get("impossible_yes", []))
    conf = raw.get("confidence", 0)
    try:
        confidence = int(max(0, min(100, int(conf))))
    except Exception:
        confidence = 0
    reason = _safe_str(raw.get("reason", "")).strip()[:220]
    evidence = _normalize_evidence(raw.get("evidence", []))

    return {
        "relation": relation,
        "exhaustive": exhaustive,
        "impossible_yes": impossible_yes,
        "confidence": confidence,
        "reason": reason,
        "evidence": evidence,
    }


def query(client, input_data):
    prompt = build_prompt(input_data)
    conv = client.create_conversation()
    conv.ask(prompt)
    return parse_answer(conv.answer)


def server_mode(session_token):
    client = Perplexity(session_token=session_token)
    log("INFO", "Constraint bridge ready")

    cooldown_base = max(1, int(os.environ.get("CONSTRAINT_RATE_LIMIT_COOLDOWN_SEC", "30")))
    cooldown_max = max(cooldown_base, int(os.environ.get("CONSTRAINT_RATE_LIMIT_MAX_COOLDOWN_SEC", "300")))
    rate_limited_until = 0.0
    consecutive_rate_limits = 0

    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue

        try:
            input_data = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({"error": f"Invalid input JSON: {e}"}), flush=True)
            continue

        now_ts = time.time()
        if now_ts < rate_limited_until:
            wait = rate_limited_until - now_ts
            log("WARN", f"Cooldown active, sleeping {wait:.1f}s")
            time.sleep(wait)

        t0 = time.time()
        label = sanitize_text(_safe_str(input_data.get("event_title", "?")))[:80]
        try:
            result = query(client, input_data)
            dur = time.time() - t0
            consecutive_rate_limits = 0
            rate_limited_until = 0.0
            log("INFO", f"OK {dur:.1f}s {label}")
            print(json.dumps(result), flush=True)
        except Exception as e:
            err = str(e)
            kind = classify_error(err)
            dur = time.time() - t0
            if kind == "rate_limit":
                consecutive_rate_limits += 1
                cooldown = min(cooldown_base * (2 ** (consecutive_rate_limits - 1)), cooldown_max)
                rate_limited_until = time.time() + cooldown
                log("ERROR", f"RATE_LIMITED {dur:.1f}s cooldown={cooldown:.0f}s {label}: {err[:160]}")
            elif kind == "session":
                consecutive_rate_limits = 0
                rate_limited_until = 0.0
                try:
                    client = Perplexity(session_token=session_token)
                    log("INFO", "Client recreated after session error")
                except Exception as re_err:
                    log("ERROR", f"Client recreation failed: {re_err}")
                log("ERROR", f"SESSION_ERR {dur:.1f}s {label}: {err[:160]}")
            else:
                consecutive_rate_limits = 0
                rate_limited_until = 0.0
                log("WARN", f"ERROR {dur:.1f}s {label}: {err[:160]}")
            print(json.dumps({"error": err}), flush=True)


def single_shot_mode(session_token):
    raw = sys.stdin.read() if not sys.stdin.isatty() else ""
    if not raw:
        for arg in sys.argv[1:]:
            if not arg.startswith("-"):
                with open(arg, "r", encoding="utf-8") as f:
                    raw = f.read()
                break
    if not raw:
        print(json.dumps({"error": "No input provided (stdin or file arg)"}))
        sys.exit(1)

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid input JSON: {e}"}))
        sys.exit(1)

    try:
        client = Perplexity(session_token=session_token)
        result = query(client, data)
        print(json.dumps(result))
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

