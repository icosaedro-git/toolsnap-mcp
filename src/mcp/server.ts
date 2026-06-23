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
  type PaymentConfig,
} from "../x402/middleware.js";

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

      // x402 payment gate: check paid tools before execution.
      if (requiresPayment(toolName)) {
        const receipt = (params._meta?.x402Receipt as string | null) ?? null;
        const config: PaymentConfig = {
          payToAddress: env.X402_PAY_TO_ADDRESS,
          network: env.X402_NETWORK,
          priceUSDC: "0.001",
          resource: toolName,
        };
        const paid = await verifyPayment(receipt, config);
        if (!paid) {
          return buildPaymentRequiredResponse(config, id) as JsonRpcResponse;
        }
      }

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
