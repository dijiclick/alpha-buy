# /// script
# requires-python = ">=3.10"
# dependencies = ["perplexity-webui-scraper"]
# ///
"""
Perplexity bridge for outcome prediction on near-term prediction markets.

Protocol (JSON line in, JSON line out):
Input:
{
  "event_title": "...",
  "event_description": "...",
  "end_date": "2026-02-22T20:00:00Z",
  "market_questions": ["Q1", "Q2", ...],
  "market_descriptions": ["D1", "D2", ...]
}

Output:
{
  "markets": [
    {"market": 1, "outcome": "yes/no/unknown", "probability": 0-100, "reasoning": "..."},
    ...
  ],
  "confidence": 0-100,
  "summary": "max 15 words"
}
"""

import json
import os
import re
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


def build_calibration_section(calibration):
    """Build a concise calibration section from past accuracy stats."""
    if not calibration:
        return ""
    overall = calibration.get("overall", {})
    if overall.get("total", 0) < 20:
        return ""

    lines = []
    lines.append("CALIBRATION (from your past predictions on this platform):")
    lines.append(
        f"- Overall accuracy: {overall['correct']}/{overall['total']} "
        f"({overall['accuracy']:.0%})"
    )

    # Confidence calibration issues
    buckets = calibration.get("by_confidence", [])
    for b in buckets:
        if b.get("total", 0) < 5:
            continue
        parts = b["bucket"].split("-")
        expected_mid = (int(parts[0]) + int(parts[1])) / 200
        if b["accuracy"] < expected_mid - 0.15:
            lines.append(
                f"- WARNING: At {b['bucket']}% confidence your actual accuracy "
                f"is {b['accuracy']:.0%} — you are OVERCONFIDENT in this range"
            )

    # Weak categories
    categories = calibration.get("by_category", [])
    weak = [c for c in categories if c.get("total", 0) >= 5 and c["accuracy"] < 0.65]
    if weak:
        lines.append("- Weak categories (accuracy < 65%):")
        for c in weak:
            lines.append(
                f"  * {c['category']}: {c['accuracy']:.0%} "
                f"({c['correct']}/{c['total']})"
            )

    # Outcome bias
    by_outcome = calibration.get("by_outcome", {})
    yes_acc = by_outcome.get("yes", {})
    no_acc = by_outcome.get("no", {})
    if yes_acc.get("total", 0) >= 10 and no_acc.get("total", 0) >= 10:
        diff = abs(yes_acc["accuracy"] - no_acc["accuracy"])
        if diff > 0.15:
            weaker = "YES" if yes_acc["accuracy"] < no_acc["accuracy"] else "NO"
            lines.append(
                f"- Bias: Your {weaker} predictions are less accurate — "
                f"be more cautious when predicting {weaker}"
            )

    # Recent mistakes (max 5)
    mistakes = calibration.get("recent_mistakes", [])[:5]
    if mistakes:
        lines.append("- Recent wrong predictions (learn from these):")
        for m in mistakes:
            lines.append(
                f"  * Predicted {m['predicted'].upper()} ({m['probability']}%) "
                f"but actual was {m['actual'].upper()}: "
                f"\"{m['market_question'][:80]}\""
            )

    lines.append("")
    return "\n".join(lines) + "\n"


def build_prompt(input_data):
    event_title = sanitize_text(_safe_str(input_data.get("event_title", "")))
    event_desc = sanitize_text(_safe_str(input_data.get("event_description", "")))
    end_date = sanitize_text(_safe_str(input_data.get("end_date", "")))
    questions = input_data.get("market_questions", [])
    descriptions = input_data.get("market_descriptions", [])
    calibration = input_data.get("calibration")

    mq_lines = []
    for i, q in enumerate(questions):
        mq_lines.append(f"  {i+1}. {q}")
        if i < len(descriptions) and descriptions[i]:
            rule = descriptions[i][:500]
            mq_lines.append(f"     Resolution rules: {rule}")
    mq_list = "\n".join(mq_lines)

    calibration_block = build_calibration_section(calibration)

    return (
        f"Today is {_today()}.\n\n"
        f"Research the following prediction-market event and predict the most likely "
        f"outcome for each market. This event ends very soon.\n\n"
        f"Event: {event_title}\n"
        f"Description: {event_desc or '(none)'}\n"
        f"Scheduled end: {end_date or '(none)'}\n\n"
        f"Markets:\n"
        f"{mq_list}\n\n"
        f"Search for the latest news, data, standings, polls, expert analysis, "
        f"and official sources about this event.\n\n"
        f"Rules:\n"
        f"- READ each market's resolution rules carefully. Pay attention to "
        f"exact dates, years, thresholds, and what YES vs NO means.\n"
        f"- For EACH market, predict: will the outcome be YES or NO?\n"
        f"- Give a probability (0-100) for your prediction being correct.\n"
        f"- probability > 85 ONLY if you have strong evidence "
        f"(official results, confirmed data, near-certain outcome).\n"
        f"- probability 70-85 if evidence is strong but not conclusive.\n"
        f"- probability < 70 if uncertain. Use outcome \"unknown\" if you truly cannot predict.\n"
        f"- DO NOT just echo market prices as your prediction. Form an independent opinion.\n"
        f"- reasoning: MAX 20 words per market.\n"
        f"- summary: MAX 15 words overall.\n\n"
        f"{calibration_block}"
        f"Respond with ONLY raw JSON, no markdown fences:\n"
        f'{{"markets":['
        f'{{"market":1,"outcome":"yes/no/unknown","probability":0-100,"reasoning":"max 20 words"}},'
        f'...],'
        f'"confidence":0-100,'
        f'"summary":"max 15 words overall summary"}}'
    )


def _try_parse_json(text):
    """Try multiple strategies to extract valid JSON from text."""
    # Strategy 1: direct parse
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Strategy 2: strip markdown fences
    cleaned = text
    if "```json" in cleaned:
        cleaned = cleaned.split("```json", 1)[1]
    if "```" in cleaned:
        cleaned = cleaned.split("```", 1)[0]
    cleaned = cleaned.strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    # Strategy 3: find the outermost { ... } with regex
    match = re.search(r'\{', text)
    if match:
        start = match.start()
        depth = 0
        end = start
        for i in range(start, len(text)):
            if text[i] == '{':
                depth += 1
            elif text[i] == '}':
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
        candidate = text[start:end]
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass

        # Strategy 4: fix common issues — trailing commas before ] or }
        fixed = re.sub(r',\s*([}\]])', r'\1', candidate)
        # Fix single quotes to double quotes (only around keys/values)
        try:
            return json.loads(fixed)
        except json.JSONDecodeError:
            pass

        # Strategy 5: try to fix truncated JSON by closing open brackets
        attempt = fixed
        open_braces = attempt.count('{') - attempt.count('}')
        open_brackets = attempt.count('[') - attempt.count(']')
        if open_braces > 0 or open_brackets > 0:
            # Remove trailing comma if present
            attempt = attempt.rstrip().rstrip(',')
            attempt += ']' * open_brackets + '}' * open_braces
            try:
                return json.loads(attempt)
            except json.JSONDecodeError:
                pass

    # All strategies failed
    raise json.JSONDecodeError(f"Could not extract JSON from response", text[:200], 0)


def _parse_raw(raw):
    """Convert raw parsed JSON into structured result."""
    markets = []
    for m in raw.get("markets", []):
        market_num = m.get("market", 0)
        outcome = _safe_str(m.get("outcome", "unknown")).strip().lower()
        if outcome not in ("yes", "no", "unknown"):
            outcome = "unknown"
        prob = m.get("probability", 0)
        try:
            prob = int(max(0, min(100, int(prob))))
        except Exception:
            prob = 0
        reasoning = _safe_str(m.get("reasoning", "")).strip()[:200]
        markets.append({
            "market": market_num,
            "outcome": outcome,
            "probability": prob,
            "reasoning": reasoning,
        })

    conf = raw.get("confidence", 0)
    try:
        confidence = int(max(0, min(100, int(conf))))
    except Exception:
        confidence = 0

    summary = _safe_str(raw.get("summary", "")).strip()[:200]

    return {
        "markets": markets,
        "confidence": confidence,
        "summary": summary,
    }


def parse_answer(answer):
    sanitized = sanitize_text(answer)
    raw = _try_parse_json(sanitized)
    return _parse_raw(raw)


def sanitize_input(input_data):
    """Deep-sanitize all string values in input to prevent UTF-8 encoding errors."""
    if isinstance(input_data, dict):
        return {k: sanitize_input(v) for k, v in input_data.items()}
    elif isinstance(input_data, list):
        return [sanitize_input(v) for v in input_data]
    elif isinstance(input_data, str):
        return sanitize_text(input_data)
    return input_data


def query(client, input_data):
    input_data = sanitize_input(input_data)
    prompt = build_prompt(input_data)
    conv = client.create_conversation()
    conv.ask(prompt)
    return parse_answer(conv.answer)


def server_mode(session_token):
    client = Perplexity(session_token=session_token)
    log("INFO", "Prediction bridge ready")

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
