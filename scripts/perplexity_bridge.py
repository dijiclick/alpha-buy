# /// script
# requires-python = ">=3.10"
# dependencies = ["perplexity-webui-scraper"]
# ///
"""
Bridge script: Node.js calls this via child_process.
Input:  JSON on stdin  { "question": str, "description": str, "end_date": str }
Output: JSON on stdout { "resolved": bool, "outcome": str, "confidence": int,
                          "estimated_end": str|null, "reasoning": str }
"""

import json
import sys
import os

from perplexity_webui_scraper import Perplexity


def main():
    raw = sys.stdin.read() if not sys.stdin.isatty() else ""

    # Also accept a file path as first argument
    if not raw and len(sys.argv) > 1:
        with open(sys.argv[1], "r") as f:
            raw = f.read()

    if not raw:
        print(json.dumps({"error": "No input provided (stdin or file arg)"}))
        sys.exit(1)

    try:
        input_data = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid input JSON: {e}"}))
        sys.exit(1)

    question = input_data.get("question", "")
    description = input_data.get("description", "")
    end_date = input_data.get("end_date", "")

    session_token = os.environ.get("PERPLEXITY_SESSION_TOKEN", "")
    if not session_token:
        print(json.dumps({"error": "PERPLEXITY_SESSION_TOKEN not set"}))
        sys.exit(1)

    prompt = (
        f'Has this event already resolved/finished?\n\n'
        f'Question: "{question}"\n'
        f'Context: {description or "none"}\n'
        f'Market end date: {end_date or "none"}\n\n'
        f'Search for the latest news and information about this topic. '
        f'Then determine if the event has already happened.\n\n'
        f'Return ONLY this JSON (no markdown, no explanation outside the JSON):\n'
        f'{{\n'
        f'  "resolved": true or false,\n'
        f'  "outcome": "yes" or "no" or "unknown",\n'
        f'  "confidence": 0 to 100,\n'
        f'  "estimated_end": "ISO date when event will finish, or null if resolved or unknown",\n'
        f'  "reasoning": "one sentence"\n'
        f'}}'
    )

    try:
        client = Perplexity(session_token=session_token)
        conversation = client.create_conversation()
        conversation.ask(prompt)
        answer = conversation.answer

        cleaned = answer
        if "```json" in cleaned:
            cleaned = cleaned.split("```json", 1)[1]
        if "```" in cleaned:
            cleaned = cleaned.split("```", 1)[0]
        cleaned = cleaned.strip()

        result = json.loads(cleaned)
        print(json.dumps(result))

    except json.JSONDecodeError:
        print(json.dumps({
            "error": "Could not parse Perplexity response as JSON",
            "raw_answer": answer[:500] if "answer" in dir() else ""
        }))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
