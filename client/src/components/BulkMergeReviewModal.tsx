import { useState, useMemo, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SchoolRegistry } from "@shared/schema";
import { useBulkMergeSchools } from "@/hooks/use-schools";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Merge, MapPin, CheckCircle2, Minus, Maximize2, X, AlertCircle } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";

interface MergePair {
  duplicate: SchoolRegistry;
  target: SchoolRegistry;
}

type MergeStep = "review" | "merging" | "geolocating" | "done" | "error";

export function BulkMergeReviewModal({
  open,
  onOpenChange,
  schools,
  duplicateIds,
  duplicateMasterMap,
  studentOriginsMap,
  onGeolocate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schools: SchoolRegistry[];
  duplicateIds: Set<number>;
  duplicateMasterMap: Map<number, SchoolRegistry>;
  studentOriginsMap?: Map<number, string>;
  onGeolocate: (school: SchoolRegistry) => Promise<void> | void;
}) {
  const [step, setStep] = useState<MergeStep>("review");
  const [progress, setProgress] = useState(0);
  const [minimized, setMinimized] = useState(false);
  const [mergedCount, setMergedCount] = useState(0);
  const [geolocatedCount, setGeolocatedCount] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successfulMasters, setSuccessfulMasters] = useState<SchoolRegistry[]>([]);
  const bulkMerge = useBulkMergeSchools();
  const { toast } = useToast();

  const isWorking = step === "merging" || step === "geolocating";

  // Build merge pairs directly from the single-source-of-truth duplicateIds & duplicateMasterMap
  // so the list ALWAYS matches the Auto-Merge (N) badge count.
  const mergePairs = useMemo(() => {
    if (duplicateIds.size === 0) return [];

    const schoolById = new Map<number, SchoolRegistry>();
    schools.forEach((s) => schoolById.set(s.id, s));

    const pairs: MergePair[] = [];
    const seenDuplicates = new Set<number>();

    duplicateIds.forEach((dupId) => {
      if (seenDuplicates.has(dupId)) return;
      const duplicate = schoolById.get(dupId);
      const target = duplicateMasterMap.get(dupId);
      if (duplicate && target && duplicate.id !== target.id) {
        seenDuplicates.add(dupId);
        pairs.push({ duplicate, target });
      }
    });

    return pairs;
  }, [schools, duplicateIds, duplicateMasterMap]);

  // When reopened while minimized, restore the full modal view
  useEffect(() => {
    if (open && minimized) {
      setMinimized(false);
    }
  }, [open, minimized]);

  // Reset state only when fully closed (not minimized and not actively running)
  useEffect(() => {
    if (!open && !minimized && !isWorking) {
      const timer = setTimeout(() => {
        setStep("review");
        setProgress(0);
        setMergedCount(0);
        setGeolocatedCount(0);
        setErrorMessage(null);
        setSuccessfulMasters([]);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [open, minimized, isWorking]);

  const handleMinimize = () => {
    setMinimized(true);
    onOpenChange(false);
  };

  const handleRestore = () => {
    setMinimized(false);
    onOpenChange(true);
  };

  const handleDismissFloating = () => {
    setMinimized(false);
    onOpenChange(false);
  };

  const handleMerge = async () => {
    if (mergePairs.length === 0) return;

    const totalToMerge = mergePairs.length;
    setMergedCount(totalToMerge);
    setGeolocatedCount(0);
    setErrorMessage(null);
    setStep("merging");
    setProgress(20);

    try {
      const payload = mergePairs.map((p) => ({
        duplicateId: p.duplicate.id,
        targetId: p.target.id,
      }));

      await bulkMerge.mutateAsync({ pairs: payload });
      setProgress(100);

      // Collect unique masters for geolocation
      const uniqueMasterIds = new Set<number>();
      const masters: SchoolRegistry[] = [];
      mergePairs.forEach((p) => {
        if (!uniqueMasterIds.has(p.target.id)) {
          uniqueMasterIds.add(p.target.id);
          masters.push(p.target);
        }
      });

      setSuccessfulMasters(masters);

      setTimeout(() => {
        setStep("geolocating");
        setProgress(0);
        handleGeolocateAll(masters, totalToMerge);
      }, 600);
    } catch (error) {
      console.error(error);
      const msg = error instanceof Error ? error.message : "Failed to merge duplicate schools.";
      setErrorMessage(msg);
      setStep("error");
      toast({
        variant: "destructive",
        title: "Auto-Merge Failed",
        description: msg,
      });
    }
  };

  const handleGeolocateAll = async (masters: SchoolRegistry[], totalToMerge: number) => {
    if (masters.length === 0) {
      setStep("done");
      setProgress(100);
      toast({
        title: "Auto-Merge Complete",
        description: `Successfully merged ${totalToMerge} duplicate school${totalToMerge === 1 ? "" : "s"}.`,
      });
      return;
    }

    for (let i = 0; i < masters.length; i++) {
      try {
        await onGeolocate(masters[i]);
      } catch (err) {
        console.error(`Failed to geolocate master ${masters[i].id}:`, err);
      }
      setGeolocatedCount(i + 1);
      setProgress(Math.round(((i + 1) / masters.length) * 100));
      // Small delay to prevent API rate limiting
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    setTimeout(() => {
      setStep("done");
      toast({
        title: "Auto-Merge Complete",
        description: `Successfully merged ${totalToMerge} duplicate school${totalToMerge === 1 ? "" : "s"} and updated geolocations.`,
      });
    }, 400);
  };

  const showFloatingWidget = minimized && !open && (isWorking || step === "done" || step === "error");

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(val) => {
          if (!val && isWorking) {
            // Closing while running minimizes to background instead of blocking the user
            handleMinimize();
            return;
          }
          if (!val) {
            setMinimized(false);
          }
          onOpenChange(val);
        }}
      >
        <DialogContent className="sm:max-w-xl">
          {isWorking && (
            <button
              type="button"
              onClick={handleMinimize}
              title="Minimize to background"
              aria-label="Minimize to background"
              className="absolute right-10 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            >
              <Minus className="h-4 w-4" />
              <span className="sr-only">Minimize</span>
            </button>
          )}
          {step === "review" && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Merge className="h-5 w-5 text-amber-600" />
                  Review Bulk Merge
                </DialogTitle>
                <DialogDescription>
                  We found <strong>{mergePairs.length}</strong> duplicate record{mergePairs.length === 1 ? "" : "s"}. The system will automatically merge them into their respective master records (prioritizing verified records with coordinates).
                </DialogDescription>
              </DialogHeader>

              {mergePairs.length > 0 ? (
                <ScrollArea className="h-[300px] w-full rounded-md border p-4 bg-slate-50">
                  <div className="space-y-4">
                    {mergePairs.map((pair) => (
                      <div key={`${pair.duplicate.id}-${pair.target.id}`} className="bg-white p-3 rounded-md border border-slate-200">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                          <div className="text-sm font-semibold text-slate-800 flex items-center gap-2">
                            {pair.duplicate.schoolName}
                          </div>
                          <div className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full flex items-center gap-1 w-fit">
                            <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                            Duplicate
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div>
                            <span className="block text-[10px] uppercase font-bold text-slate-400 mb-0.5">Original Record</span>
                            <span className="text-slate-700">{pair.target.schoolName}</span>
                            {studentOriginsMap?.has(pair.target.id) && (
                              <div className="text-[10px] text-primary mt-1">Populated by students mostly from {studentOriginsMap.get(pair.target.id)}</div>
                            )}
                          </div>
                          <div>
                            <span className="block text-[10px] uppercase font-bold text-slate-400 mb-0.5">Will Be Deleted</span>
                            <span className="text-amber-700">{pair.duplicate.schoolName}</span>
                            {studentOriginsMap?.has(pair.duplicate.id) && (
                              <div className="text-[10px] text-amber-600 mt-1">Populated by students mostly from {studentOriginsMap.get(pair.duplicate.id)}</div>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              ) : (
                <div className="h-[200px] flex items-center justify-center text-slate-500 flex-col gap-2">
                  <CheckCircle2 className="h-8 w-8 text-emerald-500" />
                  <p>No duplicates found to merge.</p>
                </div>
              )}

              <DialogFooter>
                <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                <Button
                  onClick={handleMerge}
                  disabled={mergePairs.length === 0 || bulkMerge.isPending}
                  className="bg-amber-600 hover:bg-amber-700 text-white"
                >
                  {bulkMerge.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Merge className="h-4 w-4 mr-2" />}
                  Merge &amp; Geolocate All
                </Button>
              </DialogFooter>
            </>
          )}

          {step === "merging" && (
            <div className="py-12 flex flex-col items-center justify-center space-y-6">
              <Loader2 className="h-12 w-12 animate-spin text-amber-500" />
              <div className="text-center space-y-2">
                <h3 className="font-semibold text-lg">Merging Records...</h3>
                <p className="text-sm text-slate-500">
                  Combining {mergedCount} duplicate pair{mergedCount === 1 ? "" : "s"} and reassigning references.
                </p>
              </div>
              <Progress value={progress} className="w-[80%]" />
            </div>
          )}

          {step === "geolocating" && (
            <div className="py-12 flex flex-col items-center justify-center space-y-6">
              <MapPin className="h-12 w-12 animate-bounce text-blue-500" />
              <div className="text-center space-y-2">
                <h3 className="font-semibold text-lg">Geolocating Master Records...</h3>
                <p className="text-sm text-slate-500">
                  Fetching missing addresses ({geolocatedCount} / {successfulMasters.length}) · {progress}%
                </p>
              </div>
              <Progress value={progress} className="w-[80%]" />
            </div>
          )}

          {step === "done" && (
            <div className="py-12 flex flex-col items-center justify-center space-y-4">
              <div className="h-16 w-16 bg-emerald-100 rounded-full flex items-center justify-center">
                <CheckCircle2 className="h-8 w-8 text-emerald-600" />
              </div>
              <div className="text-center space-y-1">
                <h3 className="font-semibold text-xl">Success!</h3>
                <p className="text-sm text-slate-500 text-balance">
                  Successfully merged {mergedCount} record{mergedCount === 1 ? "" : "s"} and updated their geolocations.
                </p>
              </div>
              <Button className="mt-4" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </div>
          )}

          {step === "error" && (
            <div className="py-10 flex flex-col items-center justify-center space-y-4">
              <div className="h-14 w-14 bg-rose-100 rounded-full flex items-center justify-center">
                <AlertCircle className="h-7 w-7 text-rose-600" />
              </div>
              <div className="text-center space-y-1">
                <h3 className="font-semibold text-lg">Auto-Merge Failed</h3>
                <p className="text-sm text-slate-500 max-w-sm">
                  {errorMessage || "An unexpected error occurred while merging records."}
                </p>
              </div>
              <div className="flex gap-2 mt-2">
                <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
                <Button onClick={() => setStep("review")}>Back to Review</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {showFloatingWidget && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-4 right-4 z-50 w-80 rounded-xl border border-border/80 bg-card/95 p-3.5 shadow-xl backdrop-blur-md transition-all animate-in fade-in slide-in-from-bottom-3"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              {step === "merging" && (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              )}
              {step === "geolocating" && (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/15 text-blue-600">
                  <MapPin className="h-4 w-4 animate-pulse" />
                </div>
              )}
              {step === "done" && (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-600">
                  <CheckCircle2 className="h-4 w-4" />
                </div>
              )}
              {step === "error" && (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-rose-500/15 text-rose-600">
                  <AlertCircle className="h-4 w-4" />
                </div>
              )}
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-foreground">
                  {step === "merging" && "Auto-Merging Schools..."}
                  {step === "geolocating" && "Geolocating Masters..."}
                  {step === "done" && "Auto-Merge Complete"}
                  {step === "error" && "Auto-Merge Failed"}
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {step === "merging" && `Merging ${mergedCount} duplicate${mergedCount === 1 ? "" : "s"} · ${progress}%`}
                  {step === "geolocating" && `${geolocatedCount}/${successfulMasters.length} updated · ${progress}%`}
                  {step === "done" && `Merged ${mergedCount} record${mergedCount === 1 ? "" : "s"}`}
                  {step === "error" && (errorMessage || "Something went wrong")}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={handleRestore}
                title="Expand Auto-Merge"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </Button>
              {!isWorking && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  onClick={handleDismissFloating}
                  title="Dismiss"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>

          {isWorking && (
            <div className="mt-2.5">
              <Progress value={progress} className="h-1.5" />
            </div>
          )}
        </div>
      )}
    </>
  );
}
