"""
Find all PositionSplit transactions on Polymarket's Conditional Tokens contract
in the last 24 hours. Count per account and sum USDC amounts.

Handles Etherscan's 10K result limit by chunking the block range.
Separates CTF Exchange (orderbook fills) from direct user splits.
"""
import json
import time
import urllib.request
from collections import defaultdict

API_KEY = "C5MMHWYARZTRK8YVVCM9DAUU5ZIASC2CKN"
CT_CONTRACT = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
TOPIC0 = "0x2e6bb91f8cbcda0c93623c54d0403a43514fabc40084ec96b6d5379a74786298"
USDC_E = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174"

# Known Polymarket contracts (not real user wallets)
POLYMARKET_CONTRACTS = {
    "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e",  # CTF Exchange
    "0xc5d563a36ae78145c45a50134d48a1215220f80a",  # NegRisk CTF Exchange
    "0x78769d50be1763ed1ca0d5e878d93f05aabff29e",  # NegRisk Fee Module
    "0x6a9d222616c90fca5754cd1333cfd9b7fb6a4f74",  # UmaCtf Adapter
}

BASE_URL = "https://api.etherscan.io/v2/api"


def api_call(url, retries=3):
    for attempt in range(retries):
        try:
            resp = json.loads(urllib.request.urlopen(url, timeout=30).read())
            return resp
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(1)
            else:
                raise


def get_current_block():
    url = f"{BASE_URL}?chainid=137&module=proxy&action=eth_blockNumber&apikey={API_KEY}"
    resp = api_call(url)
    return int(resp["result"], 16)


def get_logs(from_block, to_block, page=1, offset=1000):
    url = (
        f"{BASE_URL}?chainid=137&module=logs&action=getLogs"
        f"&address={CT_CONTRACT}&topic0={TOPIC0}"
        f"&fromBlock={from_block}&toBlock={to_block}"
        f"&page={page}&offset={offset}"
        f"&apikey={API_KEY}"
    )
    resp = api_call(url)
    if resp["status"] == "1":
        return resp["result"]
    return []


def get_tx_sender(tx_hash):
    """Get the actual sender (from) of a transaction."""
    url = (
        f"{BASE_URL}?chainid=137&module=proxy&action=eth_getTransactionByHash"
        f"&txhash={tx_hash}&apikey={API_KEY}"
    )
    resp = api_call(url)
    result = resp.get("result")
    if result:
        return result.get("from", "").lower()
    return None


def get_all_logs(from_block, to_block):
    """Fetch all logs, chunking the block range to avoid 10K limit."""
    all_logs = []
    chunk_size = (to_block - from_block) // 4  # Start with 4 chunks

    ranges = []
    start = from_block
    while start < to_block:
        end = min(start + chunk_size, to_block)
        ranges.append((start, end))
        start = end + 1

    for i, (r_from, r_to) in enumerate(ranges):
        page = 1
        chunk_total = 0
        while True:
            logs = get_logs(r_from, r_to, page=page, offset=1000)
            if not logs:
                break
            all_logs.extend(logs)
            chunk_total += len(logs)
            if len(logs) < 1000:
                break
            page += 1
            time.sleep(0.22)

        print(f"  Chunk {i+1}/{len(ranges)} (blocks {r_from}-{r_to}): {chunk_total} events")
        time.sleep(0.22)

    return all_logs


def parse_log(log):
    stakeholder = "0x" + log["topics"][1][-40:]
    data = log["data"]
    d = data[2:]

    collateral_token = "0x" + d[24:64]

    amount_hex = d[128:192]
    amount = int(amount_hex, 16)

    is_usdc = collateral_token.lower() == USDC_E.lower()
    usdc_amount = amount / 1e6 if is_usdc else 0

    tx_hash = log["transactionHash"]
    timestamp = int(log["timeStamp"], 16)
    block = int(log["blockNumber"], 16)

    return {
        "stakeholder": stakeholder.lower(),
        "collateral_token": collateral_token.lower(),
        "amount_raw": amount,
        "usdc_amount": usdc_amount,
        "is_usdc": is_usdc,
        "tx_hash": tx_hash,
        "timestamp": timestamp,
        "block": block,
    }


def main():
    current_block = get_current_block()
    blocks_24h = int(86400 / 2.1)
    from_block = current_block - blocks_24h

    print(f"Current block: {current_block}")
    print(f"24h ago block: {from_block}")
    print(f"Scanning PositionSplit events (chunked)...\n")

    all_logs = get_all_logs(from_block, current_block)
    print(f"\nTotal PositionSplit events: {len(all_logs)}")

    # Parse all events
    parsed = []
    non_usdc = 0
    for log in all_logs:
        try:
            p = parse_log(log)
            if p["is_usdc"]:
                parsed.append(p)
            else:
                non_usdc += 1
        except Exception as e:
            print(f"  Parse error: {e}")

    if non_usdc > 0:
        print(f"  ({non_usdc} non-USDC splits skipped)")
    print(f"USDC split events: {len(parsed)}")

    # Separate exchange splits from direct user splits
    exchange_splits = [p for p in parsed if p["stakeholder"] in POLYMARKET_CONTRACTS]
    direct_splits = [p for p in parsed if p["stakeholder"] not in POLYMARKET_CONTRACTS]

    # --- DIRECT USER SPLITS ---
    direct_accounts = defaultdict(lambda: {"count": 0, "total_usdc": 0.0, "tx_hashes": set()})
    for p in direct_splits:
        acc = direct_accounts[p["stakeholder"]]
        acc["count"] += 1
        acc["total_usdc"] += p["usdc_amount"]
        acc["tx_hashes"].add(p["tx_hash"])

    # --- EXCHANGE SPLITS: look up tx senders for unique tx hashes ---
    exchange_tx_hashes = set(p["tx_hash"] for p in exchange_splits)
    print(f"\nExchange-mediated splits: {len(exchange_splits)} events in {len(exchange_tx_hashes)} txns")
    print(f"Direct user splits: {len(direct_splits)} events")

    # For exchange splits, look up actual tx senders (sample up to 200 txns to save API calls)
    exchange_accounts = defaultdict(lambda: {"count": 0, "total_usdc": 0.0, "tx_hashes": set()})
    tx_to_sender = {}

    sorted_exchange_txs = list(exchange_tx_hashes)
    # Group exchange splits by tx_hash for amount lookup
    tx_to_amount = defaultdict(float)
    tx_to_count = defaultdict(int)
    for p in exchange_splits:
        tx_to_amount[p["tx_hash"]] += p["usdc_amount"]
        tx_to_count[p["tx_hash"]] += 1

    print(f"\nLooking up senders for {min(len(sorted_exchange_txs), 500)} exchange txns...")
    looked_up = 0
    for tx_hash in sorted_exchange_txs[:500]:
        sender = get_tx_sender(tx_hash)
        if sender:
            tx_to_sender[tx_hash] = sender
            acc = exchange_accounts[sender]
            acc["count"] += tx_to_count[tx_hash]
            acc["total_usdc"] += tx_to_amount[tx_hash]
            acc["tx_hashes"].add(tx_hash)
        looked_up += 1
        if looked_up % 50 == 0:
            print(f"  ...looked up {looked_up}/{min(len(sorted_exchange_txs), 500)} txns")
        time.sleep(0.22)

    # Remaining txns we couldn't look up
    remaining_txs = sorted_exchange_txs[500:]
    remaining_usdc = sum(tx_to_amount[tx] for tx in remaining_txs)
    remaining_count = sum(tx_to_count[tx] for tx in remaining_txs)

    # --- PRINT RESULTS ---
    print(f"\n{'='*90}")
    print(f"POLYMARKET SPLIT SUMMARY (last 24h)")
    print(f"{'='*90}")

    total_usdc_all = sum(p["usdc_amount"] for p in parsed)
    total_txs_all = len(set(p["tx_hash"] for p in parsed))
    print(f"Total split events:     {len(parsed)}")
    print(f"Total unique txns:      {total_txs_all}")
    print(f"Total USDC split:       ${total_usdc_all:,.2f}")
    print(f"  via Exchange:         ${sum(p['usdc_amount'] for p in exchange_splits):,.2f} ({len(exchange_splits)} events)")
    print(f"  direct:               ${sum(p['usdc_amount'] for p in direct_splits):,.2f} ({len(direct_splits)} events)")

    # Print exchange users (actual tx senders)
    sorted_ex = sorted(exchange_accounts.items(), key=lambda x: x[1]["total_usdc"], reverse=True)
    print(f"\n--- EXCHANGE USERS (tx senders, top 50) ---")
    print(f"{'Address':<44} {'Splits':>7} {'Txns':>6} {'USDC Amount':>15}")
    print("-" * 80)
    for addr, data in sorted_ex[:50]:
        label = ""
        if addr in POLYMARKET_CONTRACTS:
            label = " [CONTRACT]"
        print(f"{addr}{label}  {data['count']:>7}  {len(data['tx_hashes']):>5}  ${data['total_usdc']:>14,.2f}")
    if len(sorted_ex) > 50:
        print(f"  ... and {len(sorted_ex) - 50} more accounts")
    if remaining_txs:
        print(f"  (+ {len(remaining_txs)} txns not looked up: ~${remaining_usdc:,.2f})")

    # Print direct splitters
    sorted_direct = sorted(direct_accounts.items(), key=lambda x: x[1]["total_usdc"], reverse=True)
    if sorted_direct:
        print(f"\n--- DIRECT SPLITTERS (called splitPosition directly) ---")
        print(f"{'Address':<44} {'Splits':>7} {'Txns':>6} {'USDC Amount':>15}")
        print("-" * 80)
        for addr, data in sorted_direct[:30]:
            print(f"{addr}  {data['count']:>7}  {len(data['tx_hashes']):>5}  ${data['total_usdc']:>14,.2f}")

    # Combined unique user count
    all_users = set(exchange_accounts.keys()) | set(direct_accounts.keys())
    all_users -= POLYMARKET_CONTRACTS
    print(f"\n{'='*90}")
    print(f"UNIQUE USER ACCOUNTS: {len(all_users)}")
    print(f"{'='*90}")


if __name__ == "__main__":
    main()
