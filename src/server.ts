import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

const META_PIXEL_ID = "1489240479750143";

async function sendMetaEvent(request: Request, url: URL, env: unknown): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if (request.headers.get("origin") !== url.origin) return new Response(null, { status: 403 });
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return new Response(null, { status: 415 });
  }

  const bindings = env as { META_CAPI_ACCESS_TOKEN?: string } | null | undefined;
  const token = bindings?.META_CAPI_ACCESS_TOKEN ??
    (typeof process === "undefined" ? undefined : process.env.META_CAPI_ACCESS_TOKEN);
  if (!token?.trim()) return new Response(null, { status: 503 });

  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400 });
  let size = 0;
  let raw = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) {
        await reader.cancel();
        return new Response(null, { status: 413 });
      }
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } catch {
    return new Response(null, { status: 400 });
  }

  let payload: { name?: unknown; id?: unknown; plan?: unknown; clickId?: unknown } | null;
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    return new Response(null, { status: 400 });
  }
  if (!payload || (payload.name !== "PageView" && payload.name !== "InitiateCheckout") ||
    typeof payload.id !== "string" || !/^[a-f0-9-]{36}$/i.test(payload.id)) {
    return new Response(null, { status: 400 });
  }
  if (payload.name === "InitiateCheckout" && payload.plan !== "complete" && payload.plan !== "basic") {
    return new Response(null, { status: 400 });
  }

  const agent = request.headers.get("user-agent");
  if (!agent) return new Response(null, { status: 400 });
  const userData: Record<string, string> = { client_user_agent: agent };
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) userData.client_ip_address = ip;
  const cookies = request.headers.get("cookie") ?? "";
  for (const key of ["fbp", "fbc"] as const) {
    const cookie = cookies.split(";").map((part) => part.trim()).find((part) => part.startsWith(`_${key}=`));
    const value = cookie?.slice(5);
    if (value && /^fb\.\d+\.\d+\.[\w-]{1,300}$/.test(value)) userData[key] = value;
  }
  if (typeof payload.clickId === "string" && /^[\w-]{1,300}$/.test(payload.clickId)) {
    if (!userData.fbc?.endsWith("." + payload.clickId)) {
      userData.fbc = "fb.1." + Date.now() + "." + payload.clickId;
    }
  }
  const event = {
    event_name: payload.name,
    event_time: Math.floor(Date.now() / 1000),
    event_id: payload.id,
    event_source_url: new URL("/", url).href,
    action_source: "website",
    user_data: userData,
    ...(payload.name === "InitiateCheckout" && {
      custom_data: {
        currency: "USD",
        value: payload.plan === "basic" ? 4.9 : 6.9,
        content_name: payload.plan === "basic" ? "Electrodomésticos" : "Biblioteca completa",
      },
    }),
  };

  try {
    const response = await fetch(`https://graph.facebook.com/v25.0/${META_PIXEL_ID}/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ data: [event] }),
      signal: AbortSignal.timeout(4000),
    });
    await response.body?.cancel();
    return new Response(null, { status: response.ok ? 204 : 502 });
  } catch {
    return new Response(null, { status: 502 });
  }
}

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    const url = new URL(request.url);
    if (url.pathname === "/api/meta-event") return sendMetaEvent(request, url, env);
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
