import { CircleAlert, Inbox, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Toaster, toast } from "sonner";
import { api } from "@/api";
import { DecidedCard } from "@/components/DecidedCard";
import { DoneList } from "@/components/DoneList";
import { DraftCard } from "@/components/DraftCard";
import { EmptyState } from "@/components/EmptyState";
import { SkippedList } from "@/components/SkippedList";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

  const refresh = useCallback(async () => {
    try {
      setSnap(await api.state());
      setOffline(null);
    } catch (e) {
      setOffline((e as Error).message);
    }
  }, []);

  const running = snap?.scan.running ?? false;
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => void refresh(), running ? 2000 : 30_000);
    return () => clearInterval(timer);
  }, [refresh, running]);

  const review = useMemo(() => {
    const pending = (snap?.drafts ?? []).filter((d) => !decided.has(d.id)).map((d) => ({ draft: d, decided: null }));
    const done = [...decided.values()].map((d) => ({ draft: d.draft, decided: d }));
    return [...pending, ...done].sort((a, b) => a.draft.receivedAt.localeCompare(b.draft.receivedAt));
  }, [snap, decided]);

  async function checkInbox() {
    try {
      setSnap(await api.scan());
    } catch (e) {
      toast.error((e as Error).message);
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
              ? progress?.message ?? "Starting…"
              : snap?.scan.finishedAt
                ? `Checked ${ago(snap.scan.finishedAt)}${progress ? ` · ${progress.message}` : ""}`
                : ""}
          </span>
          <div className="flex-1" />
          <Button variant="outline" size="sm" onClick={() => void checkInbox()} disabled={!snap || running}>
            <RefreshCw className={running ? "animate-spin" : undefined} />
            {running ? "Checking…" : "Check inbox"}
          </Button>
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
        {running && (
          <p className="text-sm text-muted-foreground sm:hidden">{progress?.message ?? "Starting…"}</p>
        )}

        {!snap ? (
          <div className="space-y-4">
            <Skeleton className="h-9 w-72" />
            <Skeleton className="h-72 w-full rounded-xl" />
            <Skeleton className="h-72 w-full rounded-xl" />
          </div>
        ) : (
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="review">
                To review <Count n={pending} />
              </TabsTrigger>
              <TabsTrigger value="done">Done</TabsTrigger>
              <TabsTrigger value="skipped">
                Skipped <Count n={snap.skipped.length} />
              </TabsTrigger>
            </TabsList>

            <TabsContent value="review" className="space-y-4">
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
                      onApproved={approved}
                      onChanged={() => void refresh()}
                    />
                  ),
                )
              )}
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
  );
}
