import { createClient } from "npm:@supabase/supabase-js@2.86.0";

const PROJECT_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SECRET_KEYS_RAW = Deno.env.get("SUPABASE_SECRET_KEYS");
const ADMIN_KEY = SECRET_KEYS_RAW
  ? (JSON.parse(SECRET_KEYS_RAW).default as string | undefined)
  : (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
const PAIRING_SECRET = Deno.env.get("GLASS_PAIRING_SECRET") ?? "";
const COMPANY_RECORD_ID = "glass_main_company_state";
const ALLOWED_ORIGIN = "https://mehranbakhtarani-gif.github.io";

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });

const admin = PROJECT_URL && ADMIN_KEY
  ? createClient(PROJECT_URL, ADMIN_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  : null;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function authenticateDevice(req: Request) {
  const header = req.headers.get("Authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{40,})$/.exec(header);
  if (!match || !admin) return null;
  const tokenHash = await sha256(match[1]);
  const { data, error } = await admin.rpc("glass_gateway_lookup_device", {
    p_token_hash: `\\x${toHex(tokenHash)}`,
  });
  if (error || !Array.isArray(data) || !data[0]?.id) return null;
  await admin.rpc("glass_gateway_touch_device", { p_device_id: data[0].id });
  return data[0] as { id: string; actor: "mehran" | "ehsan"; label: string };
}

async function pairDevice(body: Record<string, unknown>) {
  if (!PAIRING_SECRET || new TextEncoder().encode(PAIRING_SECRET).length < 32) {
    return json({ error: "device_pairing_not_configured" }, 503);
  }
  if (typeof body.pairingCode !== "string" || typeof body.actor !== "string" ||
      !["mehran", "ehsan"].includes(body.actor) || typeof body.label !== "string") {
    return json({ error: "invalid_pairing_request" }, 400);
  }
  const [providedHash, expectedHash] = await Promise.all([
    sha256(body.pairingCode),
    sha256(PAIRING_SECRET),
  ]);
  if (!constantTimeEqual(providedHash, expectedHash)) return json({ error: "pairing_denied" }, 401);

  const random = new Uint8Array(32);
  crypto.getRandomValues(random);
  const token = base64Url(random);
  const deviceId = crypto.randomUUID();
  const { data, error } = await admin!.rpc("glass_gateway_register_device", {
    p_id: deviceId,
    p_actor: body.actor,
    p_label: body.label.trim().slice(0, 80),
    p_token_hash: `\\x${toHex(await sha256(token))}`,
  });
  if (error) {
    if (error.code === "23514") return json({ error: "device_limit_reached" }, 409);
    return json({ error: "device_pairing_failed" }, 500);
  }
  // The plaintext token is returned exactly once; only its SHA-256 hash is stored.
  return json({ device: data, deviceToken: token }, 201);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!admin) return json({ error: "gateway_not_configured" }, 503);

  const origin = req.headers.get("Origin");
  if (origin && origin !== ALLOWED_ORIGIN) return json({ error: "origin_not_allowed" }, 403);

  let body: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (raw.length > 5_500_000) return json({ error: "request_too_large" }, 413);
    const parsed = JSON.parse(raw);
    if (!isObject(parsed)) return json({ error: "invalid_request" }, 400);
    body = parsed;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  if (body.action === "pair") return await pairDevice(body);

  const device = await authenticateDevice(req);
  if (!device) return json({ error: "device_unauthorized" }, 401);

  if (body.action === "read") {
    const { data, error } = await admin.from("glass_sync")
      .select("data,updated_at,revision")
      .eq("id", COMPANY_RECORD_ID)
      .maybeSingle();
    if (error) return json({ error: "snapshot_read_failed" }, 500);
    return json({ snapshot: data ?? null });
  }

  if (body.action === "apply") {
    const operation = body.operation;
    if (!isObject(operation) || !isObject(operation.payload) ||
        typeof operation.operationId !== "string" || operation.operationId.length > 160 ||
        !Number.isSafeInteger(operation.sequence) || Number(operation.sequence) < 1 ||
        (operation.expectedUpdatedAt !== null && typeof operation.expectedUpdatedAt !== "string") ||
        !Array.isArray(operation.entityChanges ?? []) ||
        !isObject(operation.rootChanges ?? {}) ||
        typeof operation.operationType !== "string" || operation.operationType.length > 60 ||
        typeof operation.summary !== "string" || operation.summary.length > 240) {
      return json({ error: "invalid_operation" }, 400);
    }
    const serialized = JSON.stringify(operation.payload);
    if (serialized.length > 5_000_000 || !Array.isArray(operation.payload.vouchers)) {
      return json({ error: "invalid_snapshot" }, 413);
    }

    const { data, error } = await admin.rpc("glass_apply_state_operation", {
      p_record_id: COMPANY_RECORD_ID,
      p_expected_updated_at: operation.expectedUpdatedAt,
      p_data: operation.payload,
      p_entity_changes: operation.entityChanges ?? [],
      p_root_changes: operation.rootChanges ?? {},
      p_operation_id: operation.operationId,
      p_actor: device.actor,
      p_device_id: device.id,
      p_device_sequence: operation.sequence,
      p_operation_type: operation.operationType,
      p_summary: operation.summary,
      p_client_created_at: typeof operation.createdAt === "string" ? operation.createdAt : null,
    });
    if (error) {
      if (error.code === "23505") return json({ error: "device_sequence_reused" }, 409);
      return json({ error: "operation_apply_failed" }, 500);
    }
    return json({ result: Array.isArray(data) ? data[0] : data });
  }

  return json({ error: "unknown_action" }, 400);
});
