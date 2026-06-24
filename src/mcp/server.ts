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
  type PaymentConfig,
} from "../x402/middleware.js";

/** x402 MCP meta key (per x402 v2 MCP transport spec). */
const MCP_PAYMENT_META_KEY = "x402/payment";

/** x402 MCP meta key for the settlement response. */
const MCP_PAYMENT_RESPONSE_META_KEY = "x402/payment-response";

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
      // x402 payment gate
      // -----------------------------------------------------------------------
      if (requiresPayment(toolName)) {
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
