# /// script
# requires-python = ">=3.10"
# dependencies = ["perplexity-webui-scraper", "python-dotenv"]
# ///
"""
Compare Perplexity model answers for the same event.
Usage: uv run --script scripts/compare_models.py
"""

import json
import os
import sys
import time
from datetime import date

from dotenv import load_dotenv
load_dotenv()

from perplexity_webui_scraper import Perplexity, ConversationConfig
from perplexity_webui_scraper.models import Models

SESSION_TOKEN = os.environ.get("PERPLEXITY_SESSION_TOKEN", "")
if not SESSION_TOKEN:
    print("ERROR: PERPLEXITY_SESSION_TOKEN not set")
    sys.exit(1)

# Event to test (passed as JSON string, or @filename for file)
_arg = sys.argv[1] if len(sys.argv) > 1 else None
if not _arg:
    print("Usage: uv run --script scripts/compare_models.py '<json>' or @file.json")
    sys.exit(1)
if _arg.startswith("@"):
    with open(_arg[1:]) as f:
        EVENT = json.load(f)
else:
    EVENT = json.loads(_arg)

MODELS = [
    ("Sonar", Models.SONAR),
    ("GPT-5.2", Models.GPT_52),
    ("Grok 4.1", Models.GROK_41),
]

def build_prompt(event):
    title = event["title"]
    desc = event.get("description", "")
    end_date = event.get("end_date", "")
    questions = event.get("markets", [])
    descriptions = event.get("market_descriptions", [])

    # Build market list with resolution rules when available
    mq_lines = []
    for i, q in enumerate(questions):
        mq_lines.append(f"  {i+1}. {q}")
        if i < len(descriptions) and descriptions[i]:
            rule = descriptions[i][:500]
            mq_lines.append(f"     Resolution rules: {rule}")
    mq_list = "\n".join(mq_lines)

    return (
        f"Today is {date.today().isoformat()}.\n\n"
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
        f"  - ALL datetimes must be UTC with seconds: YYYY-MM-DDTHH:MM:SSZ\n\n"
        f"CRITICAL formatting rules:\n"
        f"- answer: MAX 10 words.\n"
        f"- reasoning: MAX 15 words.\n\n"
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


def parse_answer(answer):
    cleaned = answer
    if "```json" in cleaned:
        cleaned = cleaned.split("```json", 1)[1]
    if "```" in cleaned:
        cleaned = cleaned.split("```", 1)[0]
    cleaned = cleaned.strip()
    return json.loads(cleaned)


prompt = build_prompt(EVENT)
results = {}

client = Perplexity(session_token=SESSION_TOKEN)

for model_name, model_enum in MODELS:
    print(f"\n{'='*60}")
    print(f"  Querying: {model_name}")
    print(f"{'='*60}")
    t0 = time.time()
    try:
        conv = client.create_conversation(ConversationConfig(model=model_enum))
        conv.ask(prompt)
        raw = conv.answer
        dur = time.time() - t0
        try:
            parsed = parse_answer(raw)
            results[model_name] = {"parsed": parsed, "duration": round(dur, 1)}
            print(f"  Time: {dur:.1f}s")
            print(f"  Result: {json.dumps(parsed, indent=2)}")
        except json.JSONDecodeError:
            results[model_name] = {"error": "JSON parse failed", "raw": raw[:500], "duration": round(dur, 1)}
            print(f"  Time: {dur:.1f}s")
            print(f"  ERROR: Could not parse JSON")
            print(f"  Raw: {raw[:500]}")
    except Exception as e:
        dur = time.time() - t0
        results[model_name] = {"error": str(e), "duration": round(dur, 1)}
        print(f"  Time: {dur:.1f}s")
        print(f"  ERROR: {e}")

# ─── Comparison table ───
print(f"\n\n{'='*60}")
print(f"  COMPARISON")
print(f"{'='*60}\n")

headers = list(results.keys())
print(f"{'':>20} | " + " | ".join(f"{h:>15}" for h in headers))
print("-" * (22 + 18 * len(headers)))

fields = ["resolved", "answer", "confidence", "estimated_end", "estimated_end_min", "estimated_end_max", "reasoning"]
for field in fields:
    vals = []
    for h in headers:
        r = results[h]
        if "parsed" in r:
            v = str(r["parsed"].get(field, "—"))
            # Shorten ISO dates for table display
            if "T" in v and len(v) > 15:
                v = v.replace("2026-", "").replace(":00+00:00", "").replace(":00-05:00", "ET")
            vals.append(v[:15])
        else:
            vals.append("ERROR")
    print(f"{field:>20} | " + " | ".join(f"{v:>15}" for v in vals))

# Per-market comparison
print(f"\n{'':>20} | " + " | ".join(f"{h:>15}" for h in headers))
print("-" * (22 + 18 * len(headers)))

max_markets = 0
for h in headers:
    r = results[h]
    if "parsed" in r and "markets" in r["parsed"]:
        max_markets = max(max_markets, len(r["parsed"]["markets"]))

for i in range(max_markets):
    vals = []
    for h in headers:
        r = results[h]
        if "parsed" in r and "markets" in r["parsed"] and i < len(r["parsed"]["markets"]):
            m = r["parsed"]["markets"][i]
            vals.append(f"{m.get('outcome','?')} ({m.get('confidence','?')}%)")
        else:
            vals.append("—")
    print(f"{'Market ' + str(i+1):>20} | " + " | ".join(f"{v:>15}" for v in vals))

print(f"\n{'Duration':>20} | " + " | ".join(f"{results[h]['duration']:>14}s" for h in headers))
print()
