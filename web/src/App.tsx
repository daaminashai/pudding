import { CircleAlert, Inbox, ListRestart, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import { api } from "@/api";
import { ConfirmationsPanel } from "@/components/ConfirmationsPanel";
import { DecidedCard } from "@/components/DecidedCard";
import { DoneList } from "@/components/DoneList";
import { DraftCard } from "@/components/DraftCard";
import { EmptyState } from "@/components/EmptyState";
import { Hint } from "@/components/Hint";
import { ReviewToolbar } from "@/components/ReviewToolbar";
import { SkippedList } from "@/components/SkippedList";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ago, plural } from "@/lib/utils";
import type { ApproveResult, Draft, Snapshot } from "@/types";

interface Decided {
  draft: Draft;
  result: ApproveResult;
  copied: boolean;
}

function Count({ n }: { n: number }) {
  if (n === 0) return null;
  return <span className="rounded-full bg-foreground/8 px-1.5 text-xs tabular-nums">{n}</span>;
}

export function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [tab, setTab] = useState("review");
  // Approved cards stay in place (with what to do next) until dismissed.
  const [decided, setDecided] = useState<Map<number, Decided>>(new Map());
  // Drafts ticked for a bulk action, and what each card's reply box says right now.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const texts = useRef(new Map<number, string>());
  const [refreshing, setRefreshing] = useState(false);
  const onTextChange = useCallback((id: number, text: string) => {
    texts.current.set(id, text);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setSnap(await api.state());
      setOffline(null);
    } catch (e) {
      setOffline((e as Error).message);
    }
  }, []);

  const running = snap?.scan.running ?? false;
  const busy = running || (snap?.bulk?.running ?? false);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => void refresh(), busy ? 1500 : 30_000);
    return () => clearInterval(timer);
  }, [refresh, busy]);

  const review = useMemo(() => {
    const pending = (snap?.drafts ?? []).filter((d) => !decided.has(d.id)).map((d) => ({ draft: d, decided: null }));
    const done = [...decided.values()].map((d) => ({ draft: d.draft, decided: d }));
    return [...pending, ...done].sort((a, b) => a.draft.receivedAt.localeCompare(b.draft.receivedAt));
  }, [snap, decided]);

  // Replies in a bulk send that haven't had their turn yet are locked.
  const bulk = snap?.bulk ?? null;
  const waiting = useMemo(
    () => new Set(bulk?.running && bulk.kind === "reply" ? bulk.ids.slice(bulk.processed) : []),
    [bulk],
  );
  const selectable = useMemo(
    () => review.filter((r) => !r.decided && !waiting.has(r.draft.id)).map((r) => r.draft),
    [review, waiting],
  );

  async function checkInbox() {
    try {
      setSnap(await api.scan());
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function refreshQueue() {
    setRefreshing(true);
    try {
      const r = await api.refreshDrafts();
      const total = r.removed + r.skippedRemoved;
      if (total > 0) {
        const what = [
          r.removed > 0 && plural(r.removed, "draft"),
          r.skippedRemoved > 0 && plural(r.skippedRemoved, "skipped email"),
        ];
        const them = total === 1 ? "it" : "them";
        // Only drafts go to Done; skipped emails just leave the Skipped tab.
        const done =
          r.removed === 0
            ? ""
            : r.skippedRemoved === 0
              ? ` You'll find ${them} in Done.`
              : ` The ${r.removed === 1 ? "draft is" : "drafts are"} in Done.`;
        const handled = total - r.newer;
        const newer = `Check inbox to draft a fresh reply to ${r.newer === 1 ? "the one" : "the ones"} with a newer email.`;
        toast(`Took out ${what.filter(Boolean).join(" and ")}`, {
          description:
            r.newer === 0
              ? `A teammate already answered or archived ${them} in Jelly.${done}`
              : handled === 0
                ? newer
                : `${plural(handled, "was", "were")} already answered or archived in Jelly. ${newer}`,
        });
      } else if (r.errors.length === 0) {
        toast("Nothing to take out", { description: "Nothing waiting here was answered or archived in Jelly." });
      }
      if (r.errors.length > 0) {
        toast.error(`${plural(r.errors.length, "conversation")} couldn't be checked`, { description: r.errors[0] });
      }
      void refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  function approved(draft: Draft, result: ApproveResult, copied: boolean) {
    setDecided((m) => new Map(m).set(draft.id, { draft, result, copied }));
    if (result.status === "sent") toast(result.warning ? "Marked as sent" : "Sent", { description: draft.subject });
    void refresh();
  }

  const progress = snap?.scan.progress ?? null;
  const pct = progress && progress.conversations > 0 ? (progress.processed / progress.conversations) * 100 : null;
  const pending = snap?.drafts.length ?? 0;

  return (
    <TooltipProvider>
      <div className="min-h-dvh">
        <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md">
          <div className="mx-auto flex h-14 max-w-[860px] items-center gap-3 px-4">
            <div className="flex items-center gap-2.5">
              <div className="grid size-7 place-items-center rounded-lg bg-foreground text-background">
                <Inbox className="size-4" />
              </div>
              <span className="font-semibold tracking-tight">Pudding</span>
            </div>
            <span className="hidden truncate text-sm text-muted-foreground sm:inline">
              {running
                ? (progress?.message ?? "Starting…")
                : snap?.scan.finishedAt
                  ? `Checked ${ago(snap.scan.finishedAt)}${progress ? ` · ${progress.message}` : ""}`
                  : ""}
            </span>
            <div className="flex-1" />
            <Hint
              side="bottom"
              label="Look for emails that arrived since the last check and draft replies to them. Emails that already have a draft aren't drafted again."
            >
              <Button variant="outline" size="sm" onClick={() => void checkInbox()} disabled={!snap || running}>
                <RefreshCw className={running ? "animate-spin" : undefined} />
                {running ? "Checking…" : "Check inbox"}
              </Button>
            </Hint>
          </div>
          {running && <Progress value={pct} className="h-0.5 rounded-none" />}
        </header>

        <main className="mx-auto max-w-[860px] space-y-4 px-4 pt-6 pb-24">
          {offline && (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertTitle>Can't reach the Pudding server</AlertTitle>
              <AlertDescription>{offline}. Is it still running?</AlertDescription>
            </Alert>
          )}
          {snap?.scan.error && (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertTitle>The last check failed</AlertTitle>
              <AlertDescription>{snap.scan.error}</AlertDescription>
            </Alert>
          )}
          {progress && progress.errors.length > 0 && (
            <Alert>
              <TriangleAlert />
              <AlertTitle>{plural(progress.errors.length, "conversation")} couldn't be checked</AlertTitle>
              <AlertDescription>They'll be tried again on the next check.</AlertDescription>
            </Alert>
          )}
          {snap?.sending.reasonUnavailable && (
            <Alert variant="muted">
              <TriangleAlert />
              <AlertDescription className="text-foreground">{snap.sending.reasonUnavailable}</AlertDescription>
            </Alert>
          )}
          {running && <p className="text-sm text-muted-foreground sm:hidden">{progress?.message ?? "Starting…"}</p>}

          {!snap ? (
            <div className="space-y-4">
              <Skeleton className="h-9 w-72" />
              <Skeleton className="h-72 w-full rounded-xl" />
              <Skeleton className="h-72 w-full rounded-xl" />
            </div>
          ) : (
            <Tabs value={tab} onValueChange={setTab}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <TabsList>
                  <Hint label="Drafted replies waiting for you to approve, rewrite or discard.">
                    <TabsTrigger value="review">
                      To review <Count n={pending} />
                    </TabsTrigger>
                  </Hint>
                  <Hint label="Replies to the sign-up confirmation email that only share a favorite food. Check them over and send them all at once.">
                    <TabsTrigger value="confirmations">
                      Confirmations <Count n={snap.confirmations.length} />
                    </TabsTrigger>
                  </Hint>
                  <Hint label="Replies you sent, approved or discarded, and drafts that went out of date.">
                    <TabsTrigger value="done">Done</TabsTrigger>
                  </Hint>
                  <Hint label="Emails Pudding didn't draft a reply for: automated mail, and messages that don't need an answer.">
                    <TabsTrigger value="skipped">
                      Skipped <Count n={snap.skipped.length} />
                    </TabsTrigger>
                  </Hint>
                </TabsList>
                {((tab === "review" && pending > 0) ||
                  (tab === "confirmations" && snap.confirmations.length > 0) ||
                  (tab === "skipped" && snap.skipped.length > 0)) && (
                  <Hint label="Check every waiting draft and skipped email against Jelly and take out the ones a teammate already answered or archived. Nothing is drafted or sent.">
                    <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void refreshQueue()} disabled={refreshing}>
                      {refreshing ? <LoaderCircle className="animate-spin" /> : <ListRestart />}
                      {refreshing ? "Refreshing…" : "Refresh"}
                    </Button>
                  </Hint>
                )}
              </div>

              <TabsContent value="review" className="space-y-4">
                <ReviewToolbar
                  drafts={selectable}
                  selected={selected}
                  onSelectedChange={setSelected}
                  textOf={(d) => texts.current.get(d.id) ?? d.draft}
                  bulk={bulk}
                  gapSeconds={snap.bulkGapSeconds}
                  sendingUnavailable={snap.sending.reasonUnavailable}
                  onChanged={() => void refresh()}
                />
                {review.length === 0 ? (
                  running ? (
                    <EmptyState icon={LoaderCircle} title="Drafting replies…">
                      They'll show up here as they're ready.
                    </EmptyState>
                  ) : (
                    <EmptyState icon={Inbox} title="You're all caught up">
                      Nothing to review. Check the inbox to look for new emails.
                    </EmptyState>
                  )
                ) : (
                  review.map(({ draft, decided: d }) =>
                    d ? (
                      <DecidedCard
                        key={draft.id}
                        draft={draft}
                        result={d.result}
                        copied={d.copied}
                        onDismiss={() =>
                          setDecided((m) => {
                            const next = new Map(m);
                            next.delete(draft.id);
                            return next;
                          })
                        }
                      />
                    ) : (
                      <DraftCard
                        key={draft.id}
                        draft={draft}
                        sendingUnavailable={snap.sending.reasonUnavailable}
                        selected={selected.has(draft.id) && !waiting.has(draft.id)}
                        onSelectedChange={(v) =>
                          setSelected((s) => {
                            const next = new Set(s);
                            if (v) next.add(draft.id);
                            else next.delete(draft.id);
                            return next;
                          })
                        }
                        bulk={waiting.has(draft.id) ? (bulk?.current === draft.id ? "sending" : "queued") : null}
                        onTextChange={onTextChange}
                        onApproved={approved}
                        onChanged={() => void refresh()}
                      />
                    ),
                  )
                )}
              </TabsContent>
              <TabsContent value="confirmations">
                <ConfirmationsPanel
                  confirmations={snap.confirmations}
                  bulk={snap.bulk}
                  gapSeconds={snap.bulkGapSeconds}
                  sendingUnavailable={snap.sending.reasonUnavailable}
                  onChanged={() => void refresh()}
                />
              </TabsContent>
              <TabsContent value="done">
                <DoneList drafts={snap.done} />
              </TabsContent>
              <TabsContent value="skipped">
                <SkippedList
                  items={snap.skipped}
                  onDrafted={() => {
                    void refresh();
                    setTab("review");
                  }}
                />
              </TabsContent>
            </Tabs>
          )}
        </main>
        <Toaster position="bottom-right" theme="system" />
      </div>
    </TooltipProvider>
  );
}
