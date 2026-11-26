// Fortress fork: open Chatwoot tickets under the sidebar search, with a read-only history view.
import { T, useGT } from "gt-react";
import { ExternalLinkIcon, InboxIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { readDesktopPrimaryBearerToken } from "~/environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "~/environments/primary/target";
import { cn } from "~/lib/utils";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";

const POLL_MS = 30_000;

interface Ticket {
  readonly id: number;
  readonly inbox: string;
  readonly name: string;
  readonly email: string | null;
  readonly unread: boolean;
  readonly lastActivityAt: number;
  readonly preview: string;
  readonly lastAuthor: string | null;
  readonly url: string;
}

interface TicketList {
  readonly configured: boolean;
  readonly error?: string;
  readonly openCount?: number;
  readonly unreadCount?: number;
  readonly tickets?: ReadonlyArray<Ticket>;
}

interface TicketMessage {
  readonly id: number;
  readonly author: "customer" | "team" | "bot" | "note" | "event";
  readonly senderName: string | null;
  readonly content: string;
  readonly createdAt: number;
  readonly attachments: ReadonlyArray<string>;
}

async function fetchFortress<A>(path: string, params?: Record<string, string>): Promise<A> {
  const token = await readDesktopPrimaryBearerToken();
  const res = await fetch(resolvePrimaryEnvironmentHttpUrl(path, params), {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    credentials: token ? "omit" : "include",
  });
  return (await res.json()) as A;
}

const formatTime = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

function useTickets() {
  const [data, setData] = useState<TicketList | null>(null);
  const refresh = () => {
    fetchFortress<TicketList>("/api/fortress/tickets")
      .then(setData)
      .catch(() => undefined);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polling timer + window focus listener that keep the ticket count in step with Chatwoot.
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);
  return { data, refresh };
}

export function FortressTicketsRow() {
  const gt = useGT();
  const { data, refresh } = useTickets();
  const [open, setOpen] = useState(false);
  if (!data?.configured) return null;
  const openCount = data.openCount ?? 0;
  const hasUnread = (data.unreadCount ?? 0) > 0;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
      >
        <InboxIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
        <span className="min-w-0 flex-1 truncate text-left">
          <T>Tickets</T>
        </span>
        {hasUnread ? (
          <span className="relative flex size-2" aria-label={gt("Unread tickets")}>
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-success" />
          </span>
        ) : null}
        <span className="tabular-nums text-xs">{data.error ? "!" : openCount}</span>
      </button>
      <TicketsDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) refresh();
        }}
        data={data}
        onRead={refresh}
      />
    </>
  );
}

function TicketsDialog({
  open,
  onOpenChange,
  data,
  onRead,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: TicketList;
  onRead: () => void;
}) {
  const tickets = data.tickets ?? [];
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = tickets.find((t) => t.id === selectedId) ?? tickets[0] ?? null;
  const [loaded, setLoaded] = useState<{
    readonly id: number;
    readonly messages: ReadonlyArray<TicketMessage>;
  } | null>(null);

  const selectedTicketId = open ? (selected?.id ?? null) : null;
  const messages = loaded && loaded.id === selectedTicketId ? loaded.messages : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the selected ticket's history from the Fortress server while the dialog is open.
  useEffect(() => {
    if (selectedTicketId === null) return;
    let cancelled = false;
    fetchFortress<{ messages?: ReadonlyArray<TicketMessage> }>("/api/fortress/ticket-messages", {
      id: String(selectedTicketId),
    })
      .then((r) => {
        if (cancelled) return;
        setLoaded({ id: selectedTicketId, messages: r.messages ?? [] });
        onRead();
      })
      .catch(() => {
        if (!cancelled) setLoaded({ id: selectedTicketId, messages: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTicketId, onRead]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="h-[80vh] sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>
            <T>Open tickets</T>
          </DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1">
          <ul className="w-72 shrink-0 overflow-y-auto border-r">
            {tickets.length === 0 ? (
              <li className="p-4 text-sm text-muted-foreground">
                <T>No open tickets.</T>
              </li>
            ) : null}
            {tickets.map((ticket) => (
              <li key={ticket.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(ticket.id)}
                  className={cn(
                    "flex w-full flex-col gap-0.5 border-b px-3 py-2 text-left hover:bg-accent",
                    selected?.id === ticket.id && "bg-accent",
                  )}
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    {ticket.unread ? (
                      <span className="size-1.5 shrink-0 rounded-full bg-success" />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate">{ticket.name}</span>
                    <span className="shrink-0 text-3xs text-muted-foreground">{ticket.inbox}</span>
                  </span>
                  <span className="truncate text-xs text-muted-foreground">{ticket.preview}</span>
                  <span className="text-3xs text-muted-foreground">
                    {formatTime(ticket.lastActivityAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex min-w-0 flex-1 flex-col">
            {selected ? (
              <>
                <div className="flex items-center gap-2 border-b px-4 py-2 text-sm">
                  <span className="font-medium">{selected.name}</span>
                  {selected.email ? (
                    <span className="truncate text-muted-foreground">{selected.email}</span>
                  ) : null}
                  <a
                    href={selected.url}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <T>Open in Chatwoot</T>
                    <ExternalLinkIcon className="size-3" />
                  </a>
                </div>
                <div className="flex-1 space-y-3 overflow-y-auto p-4">
                  {messages === null ? (
                    <p className="text-sm text-muted-foreground">
                      <T>Loading…</T>
                    </p>
                  ) : (
                    messages.map((message) => <MessageBubble key={message.id} message={message} />)
                  )}
                </div>
              </>
            ) : null}
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function MessageBubble({ message }: { message: TicketMessage }) {
  if (message.author === "event") {
    return (
      <p className="text-center text-2xs text-muted-foreground">
        {message.content} · {formatTime(message.createdAt)}
      </p>
    );
  }
  const fromCustomer = message.author === "customer";
  return (
    <div className={cn("flex flex-col gap-1", fromCustomer ? "items-start" : "items-end")}>
      <span className="text-2xs text-muted-foreground">
        {message.senderName ?? message.author} · {formatTime(message.createdAt)}
      </span>
      <div
        className={cn(
          "max-w-[80%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm",
          fromCustomer && "bg-muted",
          message.author === "team" && "bg-primary text-primary-foreground",
          message.author === "bot" && "border bg-background",
          message.author === "note" && "border border-warning bg-warning-surface",
        )}
      >
        {message.content}
        {message.attachments.map((url) => (
          <a
            key={url}
            href={url}
            target="_blank"
            rel="noreferrer"
            className="mt-1 block truncate text-xs underline"
          >
            {url.split("/").pop()}
          </a>
        ))}
      </div>
    </div>
  );
}
