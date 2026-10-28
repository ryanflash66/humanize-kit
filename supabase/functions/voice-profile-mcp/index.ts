// Voice Profile connector — a tiny remote MCP server for Claude.
//
// Stores the humanize-kit voice profile so Claude.ai / Claude Desktop chats can
// load it in every conversation instead of re-uploading voice-profile.md.
//
// Transport: MCP Streamable HTTP, stateless, JSON responses only (no SSE).
// Auth: capability URL. The connector URL is
//   https://<ref>.supabase.co/functions/v1/voice-profile-mcp/<token>
// and only the SHA-256 of <token> is stored (public.connector_tokens).
// Anything without a valid token gets a bare 404.

import { createClient } from "npm:@supabase/supabase-js@2";

const FUNCTION_NAME = "voice-profile-mcp";
const SERVER_VERSION = "1.0.0";
const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_PROFILE_BYTES = 256 * 1024;
const DEFAULT_PROFILE = "default";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const INSTRUCTIONS =
  "Stores the user's writing voice profile for the humanize-kit skills. " +
  "Call get_voice_profile before running humanize or humanize-ig. " +
  "Call save_voice_profile after voice-profiler generates or updates a profile.";

const TOOLS = [
  {
    name: "get_voice_profile",
    title: "Get voice profile",
    description:
      "Load the user's saved writing voice profile (Markdown). Call this before humanize / humanize-ig rewrites. " +
      "Returns a 'no profile saved' message if none exists yet.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: `Profile name. Defaults to "${DEFAULT_PROFILE}".` },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "save_voice_profile",
    title: "Save voice profile",
    description:
      "Save (create or replace) the user's writing voice profile as Markdown. Every save is also kept in history, " +
      "so replacing a profile never loses the previous version.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The full voice profile Markdown." },
        name: { type: "string", description: `Profile name. Defaults to "${DEFAULT_PROFILE}".` },
      },
      required: ["content"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "list_voice_profiles",
    title: "List voice profiles",
    description: "List saved voice profile names with their last-updated time.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

// ---- auth ----

const validTokenHashes = new Set<string>();

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function isAuthorized(token: string | undefined): Promise<boolean> {
  if (!token || token.length < 32) return false;
  const hash = await sha256Hex(token);
  if (validTokenHashes.has(hash)) return true;
  const { data, error } = await db.from("connector_tokens").select("token_hash").eq("token_hash", hash).maybeSingle();
  if (error || !data) return false;
  validTokenHashes.add(hash);
  return true;
}

// Path is /voice-profile-mcp/<token>[/mcp]
function tokenFromPath(pathname: string): string | undefined {
  const parts = pathname.split("/").filter(Boolean);
  const i = parts.indexOf(FUNCTION_NAME);
  const rest = i >= 0 ? parts.slice(i + 1) : parts;
  if (rest.length === 1 || (rest.length === 2 && rest[1] === "mcp")) return rest[0];
  return undefined;
}

// ---- tools ----

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError && { isError }) });

function profileName(args: Record<string, unknown>): string {
  const n = typeof args.name === "string" ? args.name.trim() : "";
  return n || DEFAULT_PROFILE;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case "get_voice_profile": {
      const pname = profileName(args);
      const { data, error } = await db.from("voice_profiles").select("content, updated_at").eq("name", pname).maybeSingle();
      if (error) return text(`Database error: ${error.message}`, true);
      if (!data) {
        return text(
          `No voice profile saved yet under "${pname}". Run the voice-profiler skill to build one; it will save it here.`,
        );
      }
      return text(`<!-- voice profile "${pname}", updated ${data.updated_at} -->\n${data.content}`);
    }
    case "save_voice_profile": {
      const content = typeof args.content === "string" ? args.content : "";
      if (!content.trim()) return text("content is required and cannot be empty.", true);
      if (new TextEncoder().encode(content).length > MAX_PROFILE_BYTES) {
        return text(`Profile too large (limit ${MAX_PROFILE_BYTES / 1024} KB).`, true);
      }
      const pname = profileName(args);
      const now = new Date().toISOString();
      const { error } = await db.from("voice_profiles").upsert({ name: pname, content, updated_at: now });
      if (error) return text(`Database error: ${error.message}`, true);
      const { error: histError } = await db.from("voice_profile_history").insert({ name: pname, content, saved_at: now });
      if (histError) return text(`Saved, but history insert failed: ${histError.message}`, true);
      return text(`Saved voice profile "${pname}" (${content.length} chars). It will load automatically in future chats.`);
    }
    case "list_voice_profiles": {
      const { data, error } = await db.from("voice_profiles").select("name, updated_at").order("name");
      if (error) return text(`Database error: ${error.message}`, true);
      if (!data?.length) return text("No voice profiles saved yet.");
      return text(data.map((r) => `- ${r.name} (updated ${r.updated_at})`).join("\n"));
    }
    default:
      return text(`Unknown tool: ${name}`, true);
  }
}

// ---- JSON-RPC ----

type RpcMessage = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const rpcResult = (id: RpcMessage["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcMessage["id"], code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg: RpcMessage): Promise<object | null> {
  // Notifications (no id) get no response.
  if (msg.id === undefined || msg.id === null) return null;
  const params = msg.params ?? {};
  switch (msg.method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return rpcResult(msg.id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "voice-profile", title: "Voice Profile", version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: TOOLS });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<
        string,
        unknown
      >;
      try {
        return rpcResult(msg.id, await callTool(name, args));
      } catch (e) {
        return rpcResult(msg.id, text(`Tool failed: ${e instanceof Error ? e.message : String(e)}`, true));
      }
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const notFound = () => new Response("Not found", { status: 404 });

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (!(await isAuthorized(tokenFromPath(url.pathname)))) return notFound();

  // Stateless server: no SSE stream and no sessions to delete.
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400);
  }

  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map((m) => handle(m as RpcMessage)))).filter(Boolean);
    return responses.length ? json(responses) : new Response(null, { status: 202 });
  }
  const response = await handle(body as RpcMessage);
  return response ? json(response) : new Response(null, { status: 202 });
});
