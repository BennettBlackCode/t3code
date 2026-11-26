// @effect-diagnostics *:off
// Fortress fork: read-only view of open Chatwoot support tickets.
// Config lives in <baseDir>/fortress-tickets.json: { url, accountId, token, inboxes? }.
// The Chatwoot token never leaves this server process; the renderer only sees ticket data.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { AuthOrchestrationReadScope } from "@t3tools/contracts";

import * as ServerConfig from "./config.ts";
import { authenticateRawRouteWithScope } from "./http.ts";
import { requestUrl } from "./requestUrl.ts";

const TICKETS_PATH = "/api/fortress/tickets";
const MESSAGES_PATH = "/api/fortress/ticket-messages";

interface TicketsConfig {
  readonly url: string;
  readonly accountId: string;
  readonly token: string;
  readonly inboxes?: Record<string, string>;
}

interface ChatwootMessage {
  readonly id: number;
  readonly content?: string | null;
  readonly message_type: number;
  readonly private?: boolean;
  readonly created_at: number;
  readonly sender?: { readonly name?: string; readonly type?: string } | null;
  readonly attachments?: ReadonlyArray<{ readonly data_url?: string; readonly file_type?: string }>;
}

interface ChatwootConversation {
  readonly id: number;
  readonly inbox_id: number;
  readonly unread_count?: number;
  readonly last_activity_at: number;
  readonly meta?: { readonly sender?: { readonly name?: string; readonly email?: string } };
  readonly last_non_activity_message?: ChatwootMessage | null;
  readonly messages?: ReadonlyArray<ChatwootMessage>;
}

const loadConfig = (baseDir: string) =>
  Effect.tryPromise(async (): Promise<TicketsConfig | null> => {
    try {
      const raw = JSON.parse(
        await NodeFSP.readFile(NodePath.join(baseDir, "fortress-tickets.json"), "utf8"),
      );
      if (!raw?.url || !raw?.token) return null;
      return { ...raw, accountId: String(raw.accountId ?? "1") };
    } catch {
      return null;
    }
  });

async function chatwoot(config: TicketsConfig, method: string, path: string): Promise<any> {
  const res = await fetch(`${config.url}/api/v1/accounts/${config.accountId}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "api-access-token": config.token },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Chatwoot ${res.status}`);
  return text ? JSON.parse(text) : {};
}

const author = (m: ChatwootMessage) =>
  m.private
    ? "note"
    : m.message_type === 0
      ? "customer"
      : m.message_type === 1
        ? m.sender?.type === "agent_bot"
          ? "bot"
          : "team"
        : "event";

async function listTickets(config: TicketsConfig) {
  const conversations: ChatwootConversation[] = [];
  for (let page = 1; page < 20; page++) {
    const r = await chatwoot(
      config,
      "GET",
      `/conversations?status=open&assignee_type=all&page=${page}`,
    );
    const items: ChatwootConversation[] = r.data?.payload ?? [];
    conversations.push(...items);
    if (items.length < 25) break;
  }
  conversations.sort((a, b) => b.last_activity_at - a.last_activity_at);
  const tickets = conversations.map((c) => {
    const last = c.last_non_activity_message ?? c.messages?.[c.messages.length - 1] ?? null;
    return {
      id: c.id,
      inbox: config.inboxes?.[String(c.inbox_id)] ?? `Inbox ${c.inbox_id}`,
      name: c.meta?.sender?.name || c.meta?.sender?.email || "Unknown",
      email: c.meta?.sender?.email ?? null,
      unread: (c.unread_count ?? 0) > 0,
      lastActivityAt: c.last_activity_at,
      preview: (last?.content ?? "").replace(/\s+/g, " ").slice(0, 160),
      lastAuthor: last ? author(last) : null,
      url: `${config.url}/app/accounts/${config.accountId}/conversations/${c.id}`,
    };
  });
  return {
    configured: true,
    openCount: tickets.length,
    unreadCount: tickets.filter((t) => t.unread).length,
    tickets,
  };
}

async function ticketMessages(config: TicketsConfig, id: number) {
  const pages: ChatwootMessage[][] = [];
  let before: number | null = null;
  for (let i = 0; i < 10; i++) {
    const r = await chatwoot(
      config,
      "GET",
      `/conversations/${id}/messages${before ? `?before=${before}` : ""}`,
    );
    const payload: ChatwootMessage[] = r.payload ?? [];
    if (payload.length === 0) break;
    pages.unshift(payload);
    before = payload[0]!.id;
    if (payload.length < 20) break;
  }
  // Opening a ticket here counts as reading it, same as in Chatwoot.
  await chatwoot(config, "POST", `/conversations/${id}/update_last_seen`).catch(() => undefined);
  return {
    messages: pages
      .flat()
      .filter((m) => m.content || m.attachments?.length)
      .map((m) => ({
        id: m.id,
        author: author(m),
        senderName: m.sender?.name ?? null,
        content: m.content ?? "",
        createdAt: m.created_at,
        attachments: (m.attachments ?? []).map((a) => a.data_url).filter(Boolean),
      })),
  };
}

const respond = Effect.fn("FortressTickets.respond")(function* (
  work: (config: TicketsConfig) => Promise<unknown>,
) {
  yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
  const config = yield* ServerConfig.ServerConfig;
  const tickets = yield* loadConfig(config.baseDir);
  if (!tickets) return HttpServerResponse.jsonUnsafe({ configured: false });
  return yield* Effect.tryPromise(() => work(tickets)).pipe(
    Effect.map((body) => HttpServerResponse.jsonUnsafe(body)),
    Effect.catch((error) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { configured: true, error: String((error as Error)?.message ?? error) },
          { status: 502 },
        ),
      ),
    ),
  );
});

const ticketsRoute = HttpRouter.add(
  "GET",
  TICKETS_PATH,
  respond((config) => listTickets(config)),
);

const messagesRoute = HttpRouter.add(
  "GET",
  MESSAGES_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const id = Number(Option.getOrUndefined(requestUrl(request))?.searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    return yield* respond((config) => ticketMessages(config, id));
  }),
);

export const layer = Layer.mergeAll(ticketsRoute, messagesRoute);
