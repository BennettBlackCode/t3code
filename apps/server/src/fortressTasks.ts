// @effect-diagnostics *:off
// Fortress fork: pass-through to the Fortress Tasks API on hermes-us-1 (Tailscale only).
// Config lives in <baseDir>/fortress-tasks.json: { url, token }. The token stays in this process.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";

import * as ServerConfig from "./config.ts";
import { authenticateRawRouteWithScope } from "./http.ts";
import { requestUrl } from "./requestUrl.ts";

const PREFIX = "/api/fortress/tasks-api";

interface TasksConfig {
  readonly url: string;
  readonly token: string;
}

const loadConfig = (baseDir: string) =>
  Effect.promise(async (): Promise<TasksConfig | null> => {
    try {
      const raw = JSON.parse(
        await NodeFSP.readFile(NodePath.join(baseDir, "fortress-tasks.json"), "utf8"),
      );
      return raw?.url && raw?.token ? { url: String(raw.url), token: String(raw.token) } : null;
    } catch {
      return null;
    }
  });

// The renderer may only send GET/POST (CORS), so edits and deletes arrive as POST ?_method=PATCH|DELETE.
const proxy = Effect.fn("FortressTasks.proxy")(function* (requestMethod: "GET" | "POST") {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = Option.getOrUndefined(requestUrl(request));
  const override = url?.searchParams.get("_method");
  const method =
    requestMethod === "POST" && (override === "PATCH" || override === "DELETE")
      ? override
      : requestMethod;
  url?.searchParams.delete("_method");
  yield* authenticateRawRouteWithScope(
    method === "GET" ? AuthOrchestrationReadScope : AuthOrchestrationOperateScope,
  );
  const path = url ? url.pathname.slice(PREFIX.length) : "";
  if (!/^\/(meta|tasks(\/\d+(\/done)?)?)$/.test(path)) {
    return HttpServerResponse.jsonUnsafe({ error: "not found" }, { status: 404 });
  }
  const config = yield* ServerConfig.ServerConfig;
  const tasks = yield* loadConfig(config.baseDir);
  if (!tasks) return HttpServerResponse.jsonUnsafe({ configured: false });
  const body = method === "GET" || method === "DELETE" ? undefined : yield* request.text;
  return yield* Effect.promise(async () => {
    try {
      const res = await fetch(`${tasks.url}${path}${url?.search ?? ""}`, {
        method,
        headers: { authorization: `Bearer ${tasks.token}`, "content-type": "application/json" },
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      return HttpServerResponse.text(text, {
        status: res.status,
        contentType: "application/json",
      });
    } catch {
      return HttpServerResponse.jsonUnsafe(
        { error: "Tasks server unreachable. Is Tailscale on?" },
        { status: 502 },
      );
    }
  });
});

const route = (method: "GET" | "POST") => HttpRouter.add(method, `${PREFIX}/*`, proxy(method));

export const layer = Layer.mergeAll(route("GET"), route("POST"));
