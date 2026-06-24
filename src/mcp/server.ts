import type {
  JsonRpcRequest,
  JsonRpcResponse,
  InitializeParams,
  ToolsCallParams,
} from "./types.js";
import type { Env } from "../index.js";
import { listTools, callTool } from "../tools/index.js";
import {
  requiresPayment,
  buildPaymentRequiredResponse,
  verifyPayment,
  settlePayment,
  NETWORK,
  USDC_ADDRESS,
  USDC_EIP712_NAME,
  USDC_EIP712_VERSION,
  type PaymentConfig,
} from "../x402/middleware.js";
import {
  usdcToMicro,
  verifySpendAuthorization,
  debitBalance,
  refundDebit,
  getBalanceMicro,
  creditDeposit,
} from "../x402/prepaid.js";

/** x402 MCP meta key (per x402 v2 MCP transport spec). */
const MCP_PAYMENT_META_KEY = "x402/payment";

/** x402 MCP meta key for the settlement response. */
const MCP_PAYMENT_RESPONSE_META_KEY = "x402/payment-response";

/** MCP meta key carrying a signed prepaid spend authorization. */
const MCP_PREPAID_META_KEY = "x402/prepaid-spend";

/** Format integer micro-USDC as a decimal USDC string. */
function microToUsdc(micro: bigint): string {
  const neg = micro < 0n;
  const a = neg ? -micro : micro;
  const whole = a / 1_000_000n;
  const frac = (a % 1_000_000n).toString().padStart(6, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/**
 * Build a JSON-RPC 402 telling the caller to deposit (open/top up prepaid).
 * Reused for both account_deposit (no payment yet) and an empty balance hit.
 */
function buildDepositRequiredResponse(
  id: string | number | null,
  env: Env,
  reason?: string
): JsonRpcResponse {
  const minMicro = usdcToMicro(env.X402_MIN_DEPOSIT_USDC);
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: 402,
      message: reason ?? "Deposit required",
      data: {
        x402Version: 2,
        error:
          reason ??
          `Deposit at least ${env.X402_MIN_DEPOSIT_USDC} USDC to open a prepaid balance`,
        resource: {
          url: "mcp://tool/account_deposit",
          description: `Deposit >= ${env.X402_MIN_DEPOSIT_USDC} USDC on Base via account_deposit; the full amount is credited and paid tools are then debited at ${env.X402_PREPAID_PRICE_USDC} USDC/call (no per-call 402, no per-call gas).`,
          mimeType: "application/json",
        },
        accepts: [
          {
            scheme: "exact",
            network: NETWORK,
            amount: minMicro.toString(),
            asset: USDC_ADDRESS,
            payTo: env.X402_PAY_TO_ADDRESS,
            maxTimeoutSeconds: 300,
            extra: {
              name: USDC_EIP712_NAME,
              version: USDC_EIP712_VERSION,
              assetTransferMethod: "eip3009",
              note: "amount is the MINIMUM deposit; authorize more to make fewer recharges",
            },
          },
        ],
        extensions: {},
      },
    },
  };
}

/** account_balance handler (free, env-aware). */
async function handleAccountBalance(
  id: string | number | null,
  args: Record<string, unknown>,
  env: Env
): Promise<JsonRpcResponse> {
  const address = typeof args.address === "string" ? args.address.trim() : "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return successResponse(id, {
      content: [{ type: "text", text: "account_balance requires a valid 0x EVM address." }],
      isError: true,
    });
  }
  const balance = await getBalanceMicro(env.PREPAID_DB, address);
  const priceMicro = usdcToMicro(env.X402_PREPAID_PRICE_USDC);
  const callsRemaining = priceMicro > 0n ? Number(balance / priceMicro) : 0;
  return successResponse(id, {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            address: address.toLowerCase(),
            balance_usdc: microToUsdc(balance),
            balance_micro_usdc: balance.toString(),
            prepaid_price_usdc: env.X402_PREPAID_PRICE_USDC,
            calls_remaining: callsRemaining,
            min_deposit_usdc: env.X402_MIN_DEPOSIT_USDC,
          },
          null,
          2
        ),
      },
    ],
  });
}

/** account_deposit handler (settles one x402 payment, credits the balance). */
async function handleAccountDeposit(
  id: string | number | null,
  params: ToolsCallParams,
  env: Env
): Promise<JsonRpcResponse> {
  const minMicro = usdcToMicro(env.X402_MIN_DEPOSIT_USDC);
  const config: PaymentConfig = {
    payToAddress: env.X402_PAY_TO_ADDRESS,
    network: env.X402_NETWORK,
    priceUSDC: env.X402_PRICE_USDC ?? "0.02",
    resource: "account_deposit",
  };

  const payload = (params._meta ?? {})[MCP_PAYMENT_META_KEY] ?? null;
  if (payload === null || payload === undefined) {
    return buildDepositRequiredResponse(id, env);
  }

  // Verify with the deposit minimum (>= $0.50), not the per-call price.
  const v = await verifyPayment(payload, config, env, minMicro);
  if (!v.ok) {
    return buildDepositRequiredResponse(id, env, v.reason);
  }

  // Settle on-chain ONCE for the whole deposit.
  let settlement: { txHash: string };
  try {
    settlement = await settlePayment(v.authorization!, v.signature!, env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return successResponse(id, {
      content: [{ type: "text", text: `Deposit settlement failed (not charged): ${msg}` }],
      isError: true,
    });
  }

  // Credit the FULL deposited amount to the paying address.
  const creditMicro = BigInt(v.authorization!.value);
  let balanceAfter: bigint;
  try {
    balanceAfter = await creditDeposit(
      env.PREPAID_DB,
      v.payer!,
      creditMicro,
      settlement.txHash,
      v.authorization!.nonce
    );
  } catch (err) {
    // Settled on-chain but crediting failed: surface the tx hash for recovery.
    const msg = err instanceof Error ? err.message : String(err);
    return successResponse(id, {
      content: [
        {
          type: "text",
          text: `Deposit settled on-chain (tx ${settlement.txHash}) but crediting the balance failed: ${msg}. Keep this tx hash for recovery.`,
        },
      ],
      isError: true,
      _meta: {
        [MCP_PAYMENT_RESPONSE_META_KEY]: {
          success: false,
          transaction: settlement.txHash,
          network: "eip155:8453",
          payer: v.payer,
          errorReason: "credit_failed",
        },
      },
    });
  }

  return successResponse(id, {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            deposited_usdc: microToUsdc(creditMicro),
            balance_usdc: microToUsdc(balanceAfter),
            balance_micro_usdc: balanceAfter.toString(),
            prepaid_price_usdc: env.X402_PREPAID_PRICE_USDC,
            address: v.payer,
          },
          null,
          2
        ),
      },
    ],
    _meta: {
      [MCP_PAYMENT_RESPONSE_META_KEY]: {
        success: true,
        transaction: settlement.txHash,
        network: "eip155:8453",
        payer: v.payer,
      },
    },
  });
}

function successResponse(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Dispatch a parsed JSON-RPC request.
 * Returns either a JsonRpcResponse object, or null for notifications (→ 202 empty body).
 */
export async function dispatch(
  request: JsonRpcRequest,
  env: Env
): Promise<JsonRpcResponse | null> {
  const id: string | number | null =
    request.id !== undefined ? (request.id ?? null) : null;

  const method = request.method;

  // Notifications: no id field, method starts with "notifications/"
  if (request.id === undefined && method.startsWith("notifications/")) {
    return null;
  }

  switch (method) {
    case "initialize": {
      const params = (request.params ?? {}) as InitializeParams;
      const protocolVersion =
        typeof params.protocolVersion === "string" && params.protocolVersion.length > 0
          ? params.protocolVersion
          : "2025-06-18";
      return successResponse(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "toolsnap-mcp", version: "0.1.0" },
        instructions: buildServerInstructions(env),
      });
    }

    case "ping":
      return successResponse(id, {});

    case "tools/list":
      return successResponse(id, { tools: listTools() });

    case "tools/call": {
      const params = (request.params ?? {}) as ToolsCallParams;
      const toolName = params.name;
      const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;

      if (typeof toolName !== "string" || toolName.trim() === "") {
        return successResponse(id, {
          content: [{ type: "text", text: "tools/call requires a non-empty 'name' parameter." }],
          isError: true,
        });
      }

      // -----------------------------------------------------------------------
      // Account tools (env-aware: payments + D1 ledger) — handled here, not
      // via the generic tool registry.
      // -----------------------------------------------------------------------
      if (toolName === "account_balance") {
        return handleAccountBalance(id, toolArgs, env);
      }
      if (toolName === "account_deposit") {
        return handleAccountDeposit(id, params, env);
      }

      // -----------------------------------------------------------------------
      // x402 payment gate
      // -----------------------------------------------------------------------
      if (requiresPayment(toolName)) {
        // ---------------------------------------------------------------------
        // PATH A — prepaid debit (deposited balance, off-chain, no gas/402)
        // ---------------------------------------------------------------------
        const prepaidProof = (params._meta ?? {})[MCP_PREPAID_META_KEY] ?? null;
        if (prepaidProof !== null && prepaidProof !== undefined) {
          const prepaidPriceMicro = usdcToMicro(env.X402_PREPAID_PRICE_USDC);

          const v = await verifySpendAuthorization(prepaidProof, toolName, prepaidPriceMicro);
          if (!v.ok) {
            return successResponse(id, {
              content: [{ type: "text", text: `Prepaid authorization rejected: ${v.reason}` }],
              isError: true,
            });
          }

          // Atomic debit FIRST (reserves money safely); refund if the tool fails.
          const debit = await debitBalance(
            env.PREPAID_DB,
            v.payer!,
            prepaidPriceMicro,
            v.nonce!,
            toolName
          );
          if (!debit.ok) {
            if (debit.reason === "insufficient") {
              const bal = await getBalanceMicro(env.PREPAID_DB, v.payer!);
              return buildDepositRequiredResponse(
                id,
                env,
                `Insufficient prepaid balance: have ${microToUsdc(bal)} USDC, need ${env.X402_PREPAID_PRICE_USDC}. Top up with account_deposit.`
              );
            }
            return successResponse(id, {
              content: [
                {
                  type: "text",
                  text: "Prepaid spend authorization already used (replay). Sign a fresh one with a new nonce.",
                },
              ],
              isError: true,
            });
          }

          // Execute; on failure, refund the debit (do not charge for failures).
          let prepaidResult: string;
          try {
            prepaidResult = await callTool(toolName, toolArgs);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const bal = await refundDebit(env.PREPAID_DB, v.payer!, prepaidPriceMicro, toolName, v.nonce!);
            return successResponse(id, {
              content: [{ type: "text", text: message }],
              isError: true,
              _meta: {
                [MCP_PAYMENT_RESPONSE_META_KEY]: {
                  success: false,
                  prepaid: true,
                  refunded: true,
                  balance_usdc: microToUsdc(bal),
                  balance_micro_usdc: bal.toString(),
                  payer: v.payer,
                },
              },
            });
          }

          return successResponse(id, {
            content: [{ type: "text", text: prepaidResult }],
            _meta: {
              [MCP_PAYMENT_RESPONSE_META_KEY]: {
                success: true,
                prepaid: true,
                charged_usdc: env.X402_PREPAID_PRICE_USDC,
                balance_usdc: microToUsdc(debit.balanceAfter!),
                balance_micro_usdc: debit.balanceAfter!.toString(),
                payer: v.payer,
              },
            },
          });
        }

        // ---------------------------------------------------------------------
        // PATH B — pay-per-call x402 (per-call settle; first call free)
        // ---------------------------------------------------------------------
        const config: PaymentConfig = {
          payToAddress: env.X402_PAY_TO_ADDRESS,
          network: env.X402_NETWORK,
          priceUSDC: env.X402_PRICE_USDC ?? "0.02",
          resource: toolName,
        };

        // Step 1: read _meta["x402/payment"]
        const paymentPayload = (params._meta ?? {})[MCP_PAYMENT_META_KEY] ?? null;

        if (paymentPayload === null || paymentPayload === undefined) {
          return buildPaymentRequiredResponse(config, id) as JsonRpcResponse;
        }

        // Step 2: off-chain verification
        const verifyResult = await verifyPayment(paymentPayload, config, env);
        if (!verifyResult.ok) {
          return buildPaymentRequiredResponse(
            config,
            id,
            verifyResult.reason
          ) as JsonRpcResponse;
        }

        // Step 3: check first-call-free (per payer address)
        const payer = verifyResult.payer!;
        const freeCallKey = `first_free:${payer.toLowerCase()}`;
        const hasUsedFreeCall = await env.X402_NONCES.get(freeCallKey);
        const isFreeCall = hasUsedFreeCall === null;

        // Step 4: execute the tool FIRST — do not charge on failure
        let toolResult: string;
        try {
          toolResult = await callTool(toolName, toolArgs);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Tool failed → do NOT settle or consume free call, return error
          return successResponse(id, {
            content: [{ type: "text", text: message }],
            isError: true,
          });
        }

        // Step 5: handle free call — mark used, skip settlement
        if (isFreeCall) {
          await env.X402_NONCES.put(freeCallKey, new Date().toISOString());
          return successResponse(id, {
            content: [{ type: "text", text: toolResult }],
            _meta: {
              [MCP_PAYMENT_RESPONSE_META_KEY]: {
                success: true,
                free: true,
                transaction: null,
                network: "eip155:8453",
                payer,
                note: "First call free — no charge this time. Subsequent calls cost $0.02 USDC.",
              },
            },
          });
        }

        // Step 6: settle on-chain (only if tool succeeded and not a free call)
        let settlement: { txHash: string } | null = null;
        try {
          settlement = await settlePayment(
            verifyResult.authorization!,
            verifyResult.signature!,
            env
          );
        } catch (err) {
          // Settlement failure after execution: log but still return the tool result.
          // The nonce has NOT been written to KV, so the client could retry settlement,
          // but we surface the error in _meta so the caller is aware.
          const settleErr = err instanceof Error ? err.message : String(err);
          return successResponse(id, {
            content: [{ type: "text", text: toolResult }],
            _meta: {
              [MCP_PAYMENT_RESPONSE_META_KEY]: {
                success: false,
                network: "eip155:8453",
                transaction: "",
                errorReason: `Settlement failed after tool execution: ${settleErr}`,
                payer,
              },
            },
          });
        }

        // Step 7: return tool result with settlement metadata
        return successResponse(id, {
          content: [{ type: "text", text: toolResult }],
          _meta: {
            [MCP_PAYMENT_RESPONSE_META_KEY]: {
              success: true,
              transaction: settlement.txHash,
              network: "eip155:8453",
              payer,
            },
          },
        });
      }

      // -----------------------------------------------------------------------
      // Free tool path
      // -----------------------------------------------------------------------
      try {
        const result = await callTool(toolName, toolArgs);
        return successResponse(id, {
          content: [{ type: "text", text: result }],
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return successResponse(id, {
          content: [{ type: "text", text: message }],
          isError: true,
        });
      }
    }

    default:
      return errorResponse(id, -32601, "Method not found");
  }
}

/**
 * Handle a raw HTTP request body string.
 * Returns { response, status } where status is 200, 202, or 400.
 */
function buildServerInstructions(env: Env): string {
  return `You are connected to ToolSnap MCP — a single connector that expands your capabilities with 24 tools, no extra accounts needed. For paid tools, you only need USDC on Base in a wallet.

PAYMENT OPTIONS
• Pay-per-call: $${env.X402_PRICE_USDC} USDC per call, first call free (x402 via _meta["x402/payment"])
• Prepaid (recommended for repeated use): deposit once ≥$${env.X402_MIN_DEPOSIT_USDC}, pay $${env.X402_PREPAID_PRICE_USDC}/call off-chain (no per-call gas, no 402 round-trip)
  - Check balance: account_balance(address)
  - Deposit: account_deposit with x402 payment ≥$${env.X402_MIN_DEPOSIT_USDC}
  - Spend: include SpendAuthorization in _meta["x402/prepaid-spend"]

WHEN TO USE THESE TOOLS (save context & gain capabilities)
• Fetching any URL → fetch_extract: median 98.1% fewer tokens than raw HTML ($0.156 saved per call at Sonnet pricing)
• Convert HTML to clean Markdown → html_to_markdown
• Extract structured data (Open Graph, JSON-LD, meta) from URL → extract_structured
• Query CSV or JSON data → csv_query / json_query
• Extract text from PDF URL → pdf_text_extract
• Parse RSS feed or XML sitemap → rss_parse / sitemap_parse
• Get page title, description, canonical, og:* metadata → webpage_metadata
• Diff two strings → diff_text
• Run regex with capture groups → regex_extract
• Count tokens before sending a large payload → count_tokens
• Generate UUIDs, hashes (SHA-256/1/512), Base64, URL encode/decode → free utilities
• Full pricing menu (machine-readable) → pricing

STRATEGY: Before loading any external URL or large document into your context, call the relevant tool first. The cost is $0.01–$0.02; the saving on context is typically 50–200×. Use count_tokens to verify the trade-off on edge cases.`;
}

export async function handleMcpRequest(
  body: string,
  env: Env
): Promise<{ response: string | null; status: number }> {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(body) as JsonRpcRequest;
  } catch {
    const err = errorResponse(null, -32700, "Parse error");
    return { response: JSON.stringify(err), status: 400 };
  }

  const result = await dispatch(request, env);

  if (result === null) {
    // Notification — no response body
    return { response: null, status: 202 };
  }

  return { response: JSON.stringify(result), status: 200 };
}
