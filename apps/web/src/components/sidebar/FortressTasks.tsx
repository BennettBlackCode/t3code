// Fortress fork: Tasks row under Tickets, opening a list / board / calendar view of Fortress Tasks.
import { T, useGT } from "gt-react";
import {
  CalendarDaysIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ListTodoIcon,
  PlusIcon,
  RepeatIcon,
  SquareCheckBigIcon,
} from "lucide-react";
import { useEffect, useState, type DragEvent } from "react";

import { fetchFortress } from "~/lib/fortressApi";
import { useStableCallback } from "~/hooks/useStableCallback";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

const POLL_MS = 30_000;
const API = "/api/fortress/tasks-api";

type Status = "todo" | "doing" | "done";
type Priority = "low" | "normal" | "high" | "urgent";
type View = "list" | "board" | "calendar";

interface Task {
  readonly id: number;
  readonly title: string;
  readonly notes: string;
  readonly status: Status;
  readonly priority: Priority;
  readonly due: string | null;
  readonly due_time: string | null;
  readonly labels: ReadonlyArray<string>;
  readonly owner: string;
  readonly recur: string | null;
  readonly created_by: string;
  readonly completed_at: string | null;
}

type TaskDraft = Partial<Task> & { readonly id?: number };

const STATUSES: ReadonlyArray<Status> = ["todo", "doing", "done"];
const PRIORITIES: ReadonlyArray<Priority> = ["low", "normal", "high", "urgent"];
const RECUR_PRESETS = ["", "daily", "weekdays", "weekly", "monthly", "yearly"] as const;

const localToday = () => new Date().toLocaleDateString("en-CA");
const shiftDate = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const formatDue = (task: Task, today: string) => {
  if (!task.due) return null;
  const d = new Date(`${task.due}T00:00:00`);
  const day =
    task.due === today
      ? null
      : task.due === shiftDate(today, 1)
        ? null
        : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return { day, isToday: task.due === today, isTomorrow: task.due === shiftDate(today, 1) };
};

// The local server only accepts GET/POST from the window, so PATCH/DELETE travel as POST ?_method=.
async function api<A>(
  path: string,
  method = "GET",
  body?: unknown,
  params?: Record<string, string>,
) {
  const tunneled = method === "PATCH" || method === "DELETE";
  return fetchFortress<A>(`${API}${path}`, tunneled ? { ...params, _method: method } : params, {
    method: tunneled ? "POST" : method,
    body,
  });
}

function useTasks() {
  const [tasks, setTasks] = useState<ReadonlyArray<Task> | null>(null);
  const [today, setToday] = useState(localToday);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);
  const refresh = useStableCallback(() => {
    Promise.all([
      api<{ tasks?: ReadonlyArray<Task>; configured?: boolean }>("/tasks"),
      api<{ tasks?: ReadonlyArray<Task> }>("/tasks", "GET", undefined, {
        status: "done",
        limit: "100",
      }),
      api<{ today?: string }>("/meta"),
    ])
      .then(([open, done, meta]) => {
        if (open.configured === false) {
          setConfigured(false);
          return;
        }
        setTasks([...(open.tasks ?? []), ...(done.tasks ?? [])]);
        if (meta.today) setToday(meta.today);
        setError(null);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polling timer + window focus listener that keep the board in step with the Tasks server.
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);
  return { tasks, today, error, configured, refresh };
}

export function FortressTasksRow() {
  const gt = useGT();
  const { tasks, today, error, configured, refresh } = useTasks();
  const [open, setOpen] = useState(false);
  if (!configured) return null;
  const dueCount = (tasks ?? []).filter(
    (t) => t.status !== "done" && t.due && t.due <= today,
  ).length;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
      >
        <SquareCheckBigIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
        <span className="min-w-0 flex-1 truncate text-left">
          <T>Tasks</T>
        </span>
        <span className="text-xs tabular-nums" aria-label={gt("Tasks due today")}>
          {error && !tasks ? "!" : dueCount}
        </span>
      </button>
      <TasksDialog
        open={open}
        onOpenChange={setOpen}
        tasks={tasks ?? []}
        today={today}
        error={error}
        refresh={refresh}
      />
    </>
  );
}

function TasksDialog({
  open,
  onOpenChange,
  tasks,
  today,
  error,
  refresh,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tasks: ReadonlyArray<Task>;
  today: string;
  error: string | null;
  refresh: () => void;
}) {
  const gt = useGT();
  const [view, setView] = useState<View>("list");
  const [editing, setEditing] = useState<TaskDraft | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const run = (work: Promise<unknown>) => {
    work
      .then(() => {
        setActionError(null);
        refresh();
      })
      .catch((cause: unknown) =>
        setActionError(cause instanceof Error ? cause.message : String(cause)),
      );
  };
  const patch = (task: Task, fields: Partial<Task>) =>
    run(api(`/tasks/${task.id}`, "PATCH", fields));
  const toggleDone = (task: Task) =>
    run(
      task.status === "done"
        ? api(`/tasks/${task.id}`, "PATCH", { status: "todo" })
        : api(`/tasks/${task.id}/done`, "POST"),
    );

  const shownError = actionError ?? error;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="h-[85vh] sm:max-w-6xl">
        <DialogHeader>
          <div className="flex items-center gap-3 pe-8">
            <DialogTitle>
              <T>Tasks</T>
            </DialogTitle>
            <ToggleGroup
              aria-label={gt("Task view")}
              value={[view]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "list" || value === "board" || value === "calendar") setView(value);
              }}
            >
              <Toggle value="list">
                <ListTodoIcon />
                <T>List</T>
              </Toggle>
              <Toggle value="board">
                <SquareCheckBigIcon />
                <T>Board</T>
              </Toggle>
              <Toggle value="calendar">
                <CalendarDaysIcon />
                <T>Calendar</T>
              </Toggle>
            </ToggleGroup>
            <Button
              type="button"
              size="sm"
              className="ms-auto"
              onClick={() => setEditing({ status: "todo", priority: "normal", due: today })}
            >
              <PlusIcon />
              <T>New task</T>
            </Button>
          </div>
          {shownError ? <p className="text-sm text-destructive-foreground">{shownError}</p> : null}
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col px-6 pb-6">
          {view === "list" ? (
            <ListView tasks={tasks} today={today} onOpen={setEditing} onToggle={toggleDone} />
          ) : view === "board" ? (
            <BoardView
              tasks={tasks}
              today={today}
              onOpen={setEditing}
              onMove={(task, status) =>
                status === "done" && task.status !== "done"
                  ? toggleDone(task)
                  : patch(task, { status })
              }
            />
          ) : (
            <CalendarView
              tasks={tasks}
              today={today}
              onOpen={setEditing}
              onNew={(due) => setEditing({ status: "todo", priority: "normal", due })}
              onMoveDate={(task, due) => patch(task, { due })}
            />
          )}
        </div>
      </DialogPopup>
      {editing ? (
        <TaskEditor
          key={editing.id ?? "new"}
          draft={editing}
          onClose={() => setEditing(null)}
          onSave={(fields) => {
            run(
              editing.id
                ? api(`/tasks/${editing.id}`, "PATCH", fields)
                : api("/tasks", "POST", { ...fields, created_by: "bennett" }),
            );
            setEditing(null);
          }}
          onDelete={
            editing.id
              ? () => {
                  run(api(`/tasks/${editing.id}`, "DELETE"));
                  setEditing(null);
                }
              : undefined
          }
        />
      ) : null}
    </Dialog>
  );
}

function useLabels() {
  const gt = useGT();
  return {
    status: { todo: gt("To do"), doing: gt("Doing"), done: gt("Done") } satisfies Record<
      Status,
      string
    >,
    priority: {
      low: gt("Low"),
      normal: gt("Normal"),
      high: gt("High"),
      urgent: gt("Urgent"),
    } satisfies Record<Priority, string>,
  };
}

function TaskMeta({ task, today }: { task: Task; today: string }) {
  const names = useLabels();
  const due = formatDue(task, today);
  const overdue = task.status !== "done" && task.due !== null && task.due < today;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {due ? (
        <span
          className={cn(overdue && "text-destructive-foreground", due.isToday && "text-foreground")}
        >
          {due.isToday ? <T>Today</T> : due.isTomorrow ? <T>Tomorrow</T> : due.day}
          {task.due_time ? ` ${task.due_time}` : ""}
        </span>
      ) : null}
      {task.recur ? <RepeatIcon className="size-3" /> : null}
      {task.priority === "urgent" || task.priority === "high" ? (
        <Badge size="sm" variant={task.priority === "urgent" ? "error" : "warning"}>
          {names.priority[task.priority]}
        </Badge>
      ) : null}
      {task.labels.map((label) => (
        <Badge key={label} size="sm" variant="outline">
          {label}
        </Badge>
      ))}
      {task.owner !== "bennett" ? <span>@{task.owner}</span> : null}
    </span>
  );
}

function ListView({
  tasks,
  today,
  onOpen,
  onToggle,
}: {
  tasks: ReadonlyArray<Task>;
  today: string;
  onOpen: (task: Task) => void;
  onToggle: (task: Task) => void;
}) {
  const gt = useGT();
  const open = tasks.filter((t) => t.status !== "done");
  const byDue = (a: Task, b: Task) =>
    (a.due ?? "9999").localeCompare(b.due ?? "9999") ||
    (a.due_time ?? "99").localeCompare(b.due_time ?? "99");
  const groups: ReadonlyArray<{ key: string; title: string; items: ReadonlyArray<Task> }> = [
    {
      key: "overdue",
      title: gt("Overdue"),
      items: open.filter((t) => t.due && t.due < today).toSorted(byDue),
    },
    {
      key: "today",
      title: gt("Today"),
      items: open.filter((t) => t.due === today).toSorted(byDue),
    },
    {
      key: "upcoming",
      title: gt("Upcoming"),
      items: open.filter((t) => t.due && t.due > today).toSorted(byDue),
    },
    { key: "someday", title: gt("No date"), items: open.filter((t) => !t.due) },
    {
      key: "done",
      title: gt("Done"),
      items: tasks.filter((t) => t.status === "done").slice(0, 20),
    },
  ];
  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto">
      {open.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          <T>Nothing open. Nice.</T>
        </p>
      ) : null}
      {groups
        .filter((g) => g.items.length > 0)
        .map((group) => (
          <section key={group.key}>
            <h3 className="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground">
              {group.title}
              <span className="tabular-nums">{group.items.length}</span>
            </h3>
            <ul className="divide-y rounded-lg border">
              {group.items.map((task) => (
                <li key={task.id} className="flex items-center gap-3 px-3 py-2 hover:bg-accent/50">
                  <Checkbox
                    checked={task.status === "done"}
                    onCheckedChange={() => onToggle(task)}
                    aria-label={gt("Complete task")}
                  />
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
                    onClick={() => onOpen(task)}
                  >
                    <span
                      className={cn(
                        "truncate text-sm",
                        task.status === "done" && "text-muted-foreground line-through",
                      )}
                    >
                      {task.title}
                    </span>
                    <TaskMeta task={task} today={today} />
                  </button>
                  {task.status === "doing" ? (
                    <Badge size="sm" variant="info">
                      <T>Doing</T>
                    </Badge>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}

function BoardView({
  tasks,
  today,
  onOpen,
  onMove,
}: {
  tasks: ReadonlyArray<Task>;
  today: string;
  onOpen: (task: Task) => void;
  onMove: (task: Task, status: Status) => void;
}) {
  const names = useLabels();
  const [dragId, setDragId] = useState<number | null>(null);
  const [over, setOver] = useState<Status | null>(null);
  const drop = (status: Status) => (event: DragEvent) => {
    event.preventDefault();
    const task = tasks.find((t) => t.id === dragId);
    setDragId(null);
    setOver(null);
    if (task && task.status !== status) onMove(task, status);
  };
  return (
    <div className="grid min-h-0 flex-1 grid-cols-3 gap-3">
      {STATUSES.map((status) => {
        const items = tasks
          .filter((t) => t.status === status)
          .slice(0, status === "done" ? 30 : undefined);
        return (
          <section
            key={status}
            onDragOver={(event) => {
              event.preventDefault();
              setOver(status);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={drop(status)}
            className={cn(
              "flex min-h-0 flex-col rounded-lg border bg-muted/40",
              over === status && "border-ring",
            )}
          >
            <h3 className="flex items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground">
              {names.status[status]}
              <span className="tabular-nums">{items.length}</span>
            </h3>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
              {items.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  draggable
                  onDragStart={() => setDragId(task.id)}
                  onDragEnd={() => setDragId(null)}
                  onClick={() => onOpen(task)}
                  className={cn(
                    "flex w-full flex-col items-start gap-1 rounded-md border bg-card px-3 py-2 text-left shadow-xs hover:border-ring",
                    dragId === task.id && "opacity-50",
                  )}
                >
                  <span
                    className={cn(
                      "text-sm",
                      task.status === "done" && "text-muted-foreground line-through",
                    )}
                  >
                    {task.title}
                  </span>
                  <TaskMeta task={task} today={today} />
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function CalendarView({
  tasks,
  today,
  onOpen,
  onNew,
  onMoveDate,
}: {
  tasks: ReadonlyArray<Task>;
  today: string;
  onOpen: (task: Task) => void;
  onNew: (due: string) => void;
  onMoveDate: (task: Task, due: string) => void;
}) {
  const gt = useGT();
  const [month, setMonth] = useState(() => today.slice(0, 7));
  const [dragId, setDragId] = useState<number | null>(null);
  const first = new Date(`${month}-01T00:00:00Z`);
  const start = shiftDate(`${month}-01`, -first.getUTCDay());
  const days = Array.from({ length: 42 }, (_, i) => shiftDate(start, i));
  const weekdays = days
    .slice(0, 7)
    .map((d) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: "short" }));
  const stepMonth = (n: number) => {
    const d = new Date(`${month}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + n);
    setMonth(d.toISOString().slice(0, 7));
  };
  const byDay = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!task.due) continue;
    byDay.set(task.due, [...(byDay.get(task.due) ?? []), task]);
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">
          {first.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })}
        </span>
        <div className="ms-auto flex items-center gap-1">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={gt("Previous month")}
            onClick={() => stepMonth(-1)}
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setMonth(today.slice(0, 7))}
          >
            <T>Today</T>
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={gt("Next month")}
            onClick={() => stepMonth(1)}
          >
            <ChevronRightIcon />
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-7 text-xs text-muted-foreground">
        {weekdays.map((name) => (
          <span key={name} className="px-2 py-1">
            {name}
          </span>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6 overflow-hidden rounded-lg border">
        {days.map((day) => {
          const items = byDay.get(day) ?? [];
          const inMonth = day.startsWith(month);
          return (
            <div
              key={day}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const task = tasks.find((t) => t.id === dragId);
                setDragId(null);
                if (task && task.due !== day) onMoveDate(task, day);
              }}
              onDoubleClick={() => onNew(day)}
              className={cn(
                "flex min-h-0 flex-col gap-0.5 overflow-hidden border-e border-b p-1",
                !inMonth && "bg-muted/40",
              )}
            >
              <span
                className={cn(
                  "flex size-5 items-center justify-center self-end rounded-full text-xs",
                  day === today
                    ? "bg-primary text-primary-foreground"
                    : inMonth
                      ? "text-foreground"
                      : "text-muted-foreground",
                )}
              >
                {Number(day.slice(8))}
              </span>
              {items.slice(0, 4).map((task) => (
                <button
                  key={task.id}
                  type="button"
                  draggable
                  onDragStart={() => setDragId(task.id)}
                  onClick={() => onOpen(task)}
                  className={cn(
                    "truncate rounded px-1 py-0.5 text-left text-xs hover:bg-accent",
                    task.status === "done"
                      ? "text-muted-foreground line-through"
                      : task.due && task.due < today
                        ? "bg-destructive/8 text-destructive-foreground"
                        : "bg-accent/60",
                  )}
                >
                  {task.due_time ? `${task.due_time} ` : ""}
                  {task.title}
                </button>
              ))}
              {items.length > 4 ? (
                <span className="px-1 text-xs text-muted-foreground">+{items.length - 4}</span>
              ) : null}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        <T>Double-click a day to add a task. Drag tasks between days to reschedule.</T>
      </p>
    </div>
  );
}

function TaskEditor({
  draft,
  onClose,
  onSave,
  onDelete,
}: {
  draft: TaskDraft;
  onClose: () => void;
  onSave: (fields: Record<string, unknown>) => void;
  onDelete: (() => void) | undefined;
}) {
  const gt = useGT();
  const names = useLabels();
  const [title, setTitle] = useState(draft.title ?? "");
  const [notes, setNotes] = useState(draft.notes ?? "");
  const [status, setStatus] = useState<Status>(draft.status ?? "todo");
  const [priority, setPriority] = useState<Priority>(draft.priority ?? "normal");
  const [due, setDue] = useState(draft.due ?? "");
  const [time, setTime] = useState(draft.due_time ?? "");
  const [labels, setLabels] = useState((draft.labels ?? []).join(", "));
  const [owner, setOwner] = useState(draft.owner ?? "bennett");
  const [recur, setRecur] = useState(draft.recur ?? "");
  const recurNames: Record<string, string> = {
    "": gt("Does not repeat"),
    daily: gt("Daily"),
    weekdays: gt("Weekdays"),
    weekly: gt("Weekly"),
    monthly: gt("Monthly"),
    yearly: gt("Yearly"),
    custom: gt("Custom…"),
  };
  const [recurMode, setRecurMode] = useState<string>(
    (RECUR_PRESETS as ReadonlyArray<string>).includes(draft.recur ?? "")
      ? (draft.recur ?? "")
      : "custom",
  );

  const save = () => {
    if (!title.trim()) return;
    onSave({
      title: title.trim(),
      notes,
      status,
      priority,
      due: due || null,
      due_time: time || null,
      labels: labels
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean),
      owner: owner.trim() || "bennett",
      recur: (recurMode === "custom" ? recur.trim() : recurMode) || null,
    });
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogPopup className="sm:max-w-lg">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{draft.id ? <T>Edit task</T> : <T>New task</T>}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <Input
                nativeInput
                autoFocus
                value={title}
                onChange={(event) => setTitle(event.currentTarget.value)}
                placeholder={gt("What needs doing?")}
                aria-label={gt("Title")}
              />
              <Textarea
                value={notes}
                onChange={(event) => setNotes(event.currentTarget.value)}
                placeholder={gt("Notes")}
                aria-label={gt("Notes")}
                size="sm"
              />
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-2">
                  <Label>
                    <T>Status</T>
                  </Label>
                  <Select value={status} onValueChange={(v) => v && setStatus(v as Status)}>
                    <SelectTrigger size="sm" aria-label={gt("Status")}>
                      <SelectValue>{names.status[status]}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {names.status[s]}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label>
                    <T>Priority</T>
                  </Label>
                  <Select value={priority} onValueChange={(v) => v && setPriority(v as Priority)}>
                    <SelectTrigger size="sm" aria-label={gt("Priority")}>
                      <SelectValue>{names.priority[priority]}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {PRIORITIES.map((p) => (
                        <SelectItem key={p} value={p}>
                          {names.priority[p]}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label>
                    <T>Due date</T>
                  </Label>
                  <Input
                    nativeInput
                    type="date"
                    size="sm"
                    value={due}
                    onChange={(event) => setDue(event.currentTarget.value)}
                    aria-label={gt("Due date")}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label>
                    <T>Time</T>
                  </Label>
                  <Input
                    nativeInput
                    type="time"
                    size="sm"
                    value={time}
                    onChange={(event) => setTime(event.currentTarget.value)}
                    aria-label={gt("Time")}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label>
                    <T>Labels</T>
                  </Label>
                  <Input
                    nativeInput
                    size="sm"
                    value={labels}
                    onChange={(event) => setLabels(event.currentTarget.value)}
                    placeholder={gt("ops, 1cw")}
                    aria-label={gt("Labels")}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label>
                    <T>Owner</T>
                  </Label>
                  <Input
                    nativeInput
                    size="sm"
                    value={owner}
                    onChange={(event) => setOwner(event.currentTarget.value)}
                    aria-label={gt("Owner")}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Label>
                  <T>Repeat</T>
                </Label>
                <Select value={recurMode} onValueChange={(v) => v !== null && setRecurMode(v)}>
                  <SelectTrigger size="sm" aria-label={gt("Repeat")}>
                    <SelectValue>{recurNames[recurMode]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {[...RECUR_PRESETS, "custom"].map((r) => (
                      <SelectItem key={r || "none"} value={r}>
                        {recurNames[r]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {recurMode === "custom" ? (
                  <Input
                    nativeInput
                    size="sm"
                    value={recur}
                    onChange={(event) => setRecur(event.currentTarget.value)}
                    placeholder={gt("weekly:mon,thu · monthly:15 · monthly:last · every:3d")}
                    aria-label={gt("Custom repeat rule")}
                  />
                ) : null}
              </div>
            </div>
          </DialogPanel>
          <DialogFooter>
            {onDelete ? (
              <Button
                type="button"
                variant="ghost-destructive"
                className="sm:me-auto"
                onClick={onDelete}
              >
                <T>Delete</T>
              </Button>
            ) : null}
            <Button type="button" variant="ghost-muted" onClick={onClose}>
              <T>Cancel</T>
            </Button>
            <Button type="submit" disabled={!title.trim()}>
              <T>Save</T>
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
