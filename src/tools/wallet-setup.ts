import type { McpTool } from "../mcp/types.js";

const PROCEDURE = `# wallet_setup — Create your agent wallet

You are about to generate a crypto wallet that **you, the agent, control exclusively**.
ToolSnap never sees, stores, or transmits the private key — it is born and lives on your host.

---

## SECURITY CONTRACT — non-negotiable invariants

1. **The private key MUST NEVER appear in stdout, logs, or the conversation.**
   Do not print it, confirm it, or mention it. Only handle the public address (0x…).
2. **Generate → write directly to the secret store → return only the address.**
   The secret must not land in a visible variable, shell history, or process arguments (visible via \`ps\`).
3. **Restrictive permissions** on any secret file (\`0600\`).
4. **Verify you can re-read the key from the store before declaring success.**
   If re-read fails, stop: the human would fund a wallet you cannot use.

---

## Step 1 — Detect your environment

Determine:
- Operating system: \`macOS\` / \`Linux\` / \`Windows\`
- Available runtime: \`python3\`? \`node\`?
- Is an OS keystore accessible?
  - macOS: always (Keychain)
  - Windows: always (Credential Manager / DPAPI)
  - Linux: is Secret Service active (i.e. are you on a desktop with gnome-keyring/KWallet)?
    Or are you headless (server/container)?

---

## Step 2 — Choose where to store the key

\`\`\`
OS?
├─ macOS    → Keychain                           (always available)
├─ Windows  → Credential Manager / DPAPI          (always available)
└─ Linux    → Is Secret Service active?
              ├─ Yes (desktop)  → Secret Service (gnome-keyring / KWallet)
              └─ No (headless)  → FALLBACK: 0600 file in restricted directory
                                  (recommend encrypted disk)
\`\`\`

- **Autonomous mode (no human in the loop):** auto-select the best available mechanism and proceed.
- **Human in the loop:** detect the OS, propose the best available option, explain the trade-off, and let the human decide. You advise; they decide.

Note: the Python \`keyring\` library abstracts all three native keystores with one API.
It will raise an error on headless Linux (no backend) → fall through to the file fallback.

**Multiple agents on the same host share the wallet automatically.**
Any process running as the same OS user (e.g. Claude, Hermes, or any other agent) will find
the same keystore entry (\`service=toolsnap-agent-wallet\`, \`account=default\`).
This is a feature: one wallet, all your agents.

---

## Step 3 — Generate and store (key never enters the conversation)

### Reference A — Python (\`eth-account\` + \`keyring\`), cross-OS

Install once if not already installed:
\`\`\`bash
pip install eth-account keyring
\`\`\`

Generate and store (run this as a Bash command — prints ONLY the address):
\`\`\`bash
python3 - <<'PY'
import json, pathlib, stat, sys
from eth_account import Account

try:
    import keyring
    USE_KEYRING = True
except ImportError:
    USE_KEYRING = False

SERVICE = "toolsnap-agent-wallet"
USER    = "default"

acct = Account.create()
pk   = acct.key.hex()   # SECRET — never printed
addr = acct.address      # public

stored_in = None

if USE_KEYRING:
    try:
        keyring.set_password(SERVICE, USER, pk)
        if keyring.get_password(SERVICE, USER) != pk:
            raise RuntimeError("re-read mismatch")
        stored_in = f"OS keystore ({type(keyring.get_keyring()).__name__})"
    except Exception:
        USE_KEYRING = False  # fall through to file fallback

if not USE_KEYRING:
    d = pathlib.Path.home() / ".toolsnap"
    d.mkdir(mode=0o700, exist_ok=True)
    f = d / "wallet.key"
    f.write_text(pk)
    f.chmod(0o600)
    # verify re-read
    if f.read_text() != pk:
        print(json.dumps({"error": "file re-read mismatch"}))
        sys.exit(1)
    stored_in = f"file {f} (0600)"

del pk  # hygiene: remove from memory

print(json.dumps({"address": addr, "stored_in": stored_in, "network": "Base (chainId 8453)"}))
PY
\`\`\`

### Reference B — Node.js (\`ethers\`), file fallback

Install once if not already installed:
\`\`\`bash
npm install -g ethers
\`\`\`

\`\`\`bash
node - <<'JS'
import { Wallet } from "ethers";
import { writeFileSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const w    = Wallet.createRandom();
const pk   = w.privateKey;   // SECRET — never printed
const addr = w.address;       // public

const dir = join(homedir(), ".toolsnap");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const f = join(dir, "wallet.key");
writeFileSync(f, pk, { mode: 0o600 });
chmodSync(f, 0o600);

// Verify re-read
if (readFileSync(f, "utf8") !== pk) {
  console.error(JSON.stringify({ error: "file re-read mismatch" }));
  process.exit(1);
}

console.log(JSON.stringify({ address: addr, stored_in: \`file \${f} (0600)\`, network: "Base (chainId 8453)" }));
JS
\`\`\`

> **Never pass the key as a CLI argument** (e.g. \`-w <pk>\`) — arguments are visible via \`ps\`.
> Use libraries or stdin/here-doc patterns, as shown above.

---

## Step 4 — Show the address and QR to the human

After running the script, you will have the public address. Show it clearly:

1. Print the address: \`0x…\`
2. If \`qrcode\` is available, print a QR in the terminal using **EIP-681** format
   so the human's wallet app opens it directly on Base:
   \`ethereum:<address>@8453\`

\`\`\`bash
python3 - <<'PY'
import json, pathlib

# Read back the persisted address
wf = pathlib.Path.home() / ".toolsnap" / "wallet.json"
addr = json.loads(wf.read_text())["address"] if wf.exists() else "<address from step 3>"

try:
    import qrcode
    qr = qrcode.QRCode(border=1)
    qr.add_data(f"ethereum:{addr}@8453")
    qr.print_ascii()
except ImportError:
    print(f"QR (install qrcode lib for inline QR): ethereum:{addr}@8453")

print(f"Address: {addr}")
PY
\`\`\`

3. **Persist the public address** (not secret, safe to store plaintext) so you can show it again on request:

\`\`\`bash
python3 - <<'PY'
import json, pathlib
from datetime import datetime, timezone

# Fill in the address obtained in Step 3
addr = "<address from step 3>"

d = pathlib.Path.home() / ".toolsnap"
d.mkdir(mode=0o700, exist_ok=True)
(d / "wallet.json").write_text(json.dumps({
    "address": addr,
    "network": "Base",
    "chainId": 8453,
    "created": datetime.now(timezone.utc).isoformat(),
}))
print("Address persisted to ~/.toolsnap/wallet.json")
PY
\`\`\`

---

## Step 5 — Instruct the human to fund the wallet

Tell the human:

> "Your agent wallet is ready. Send **USDC on the Base network** to this address
> (scan the QR or copy the address below). Start small — top it up as needed;
> never keep a large amount here.
>
> Address: \`<address>\`
>
> Once you've sent funds, let me know and I'll verify the balance on-chain.
>
> **Need to recover your funds?** At any time you can ask me to send
> the wallet's full balance to any address you specify — I control the key
> and can sign the transfer."

---

## Step 6 — Verify the balance (optional, after funding)

Check the on-chain USDC balance on Base:

\`\`\`bash
python3 - <<'PY'
import json, pathlib, urllib.request

addr = json.loads((pathlib.Path.home() / ".toolsnap" / "wallet.json").read_text())["address"]

# Base mainnet public JSON-RPC — USDC contract on Base
RPC     = "https://mainnet.base.org"
USDC    = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
PAD     = addr[2:].zfill(64)
payload = json.dumps({
    "jsonrpc": "2.0", "id": 1, "method": "eth_call",
    "params": [{"to": USDC, "data": f"0x70a08231{PAD}"}, "latest"]
}).encode()

res = urllib.request.urlopen(urllib.request.Request(RPC, data=payload,
      headers={"Content-Type": "application/json"}), timeout=10)
raw = json.loads(res.read())["result"]
balance_usdc = int(raw, 16) / 1e6
print(f"USDC balance on Base: {balance_usdc:.4f}")
PY
\`\`\`

No third-party libraries required — uses only Python stdlib and the public Base RPC.

---

## Step 7 — Wire payments so paid tools actually work (REQUIRED)

> **A funded wallet is necessary but NOT sufficient.** Most MCP clients (Claude
> Desktop, Claude Code, …) cannot, on their own, answer an x402 \`402 Payment
> Required\` — they can't sign the payment and retry. So without this step you
> will still hit "402 / no_payment_method" on every paid tool, even with money
> in the wallet.

The fix is the **ToolSnap pay-proxy**: a small local stdio MCP server that wraps
the remote endpoint, reads the wallet you just created, and signs + retries
automatically when the server asks for payment. The private key stays on your
host; only signatures are sent.

**Wire it once** — point your MCP client at the proxy instead of the URL:

\`\`\`json
{
  "mcpServers": {
    "toolsnap": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/to/toolsnap-mcp/scripts/pay-proxy.mjs"]
    }
  }
}
\`\`\`

The proxy auto-discovers the key (env \`TOOLSNAP_WALLET_KEY\` → \`~/.toolsnap/wallet.key\`
→ macOS Keychain entry \`toolsnap-agent-wallet/default\`, exactly where Step 3 put it).
Useful env: \`TOOLSNAP_MAX_PRICE_USDC\` (per-call spend cap, default 0.10),
\`TOOLSNAP_PREPAID=1\` (+ \`TOOLSNAP_AUTO_DEPOSIT_USDC\`) to use the cheaper prepaid balance.

After reconnecting through the proxy, paid tools "just work" — no per-call action
from you. (Advanced: if your client already signs x402 natively, you can skip the
proxy and pay via \`_meta["x402/payment"]\` / \`_meta["x402/prepaid-spend"]\` directly.)

---

## Summary

| Step | Action | Output |
|------|--------|--------|
| 1 | Detect OS + runtime | Decision: which store to use |
| 2 | Decide storage | Keystore or file fallback |
| 3 | Generate + store | Key in store; address in stdout |
| 4 | Show address + QR | Human can fund |
| 5 | Persist address | ~/.toolsnap/wallet.json |
| 6 | Verify balance | Confirmed on-chain |
| 7 | Wire the pay-proxy | Paid tools work end-to-end |

Key never leaves your host. ToolSnap never sees it. After Step 7 you are ready to
pay for tools.
`;

export const walletSetupTool: McpTool = {
  name: "wallet_setup",
  description:
    "Returns the step-by-step procedure for you (the agent) to generate your own wallet on your host and have your human fund it with USDC on Base. ToolSnap never sees, stores, or transmits the private key — it is born and lives on your machine. Call this after receiving a no_payment_method error from any paid tool. The procedure covers: OS detection, choosing the best secret store (macOS Keychain / Windows Credential Manager / Linux Secret Service / file fallback), generating and storing the key without it ever appearing in context, printing the public address + QR for the human to fund, verifying the on-chain balance, and — critically — wiring the ToolSnap pay-proxy so paid tools actually work (a funded wallet alone is not enough: most MCP clients can't satisfy x402 on their own).",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
  run() {
    return PROCEDURE;
  },
};
