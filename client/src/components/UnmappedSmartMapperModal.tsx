import { useState, useEffect, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SchoolNameAutocomplete } from "./SchoolNameAutocomplete";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { api } from "@shared/routes";
import type { SchoolRegistry } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  Sparkles,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  MapPin,
  Search,
  Minus,
  Maximize2,
  X,
  Globe,
  ShieldCheck,
  ChevronLeft,
  ChevronRight,
  Users,
  Crosshair,
} from "lucide-react";
import { MapContainer, TileLayer, Marker, useMapEvents } from "react-leaflet";
import L from "leaflet";

const pinIcon = L.divIcon({
  className: "smart-mapper-pin",
  html: `<div style="width:22px;height:22px;border-radius:9999px;background:#e11d48;border:3px solid #fff;box-shadow:0 4px 12px rgba(0,0,0,0.35);"></div>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

export interface SmartProposal {
  existingSchoolId?: number;
  schoolId?: string;
  schoolName: string;
  schoolType: string;
  sector: string;
  barangay: string;
  municipality: string;
  province: string;
  address: string;
  latitude: number;
  longitude: number;
  source: "Registry / Alias" | "CAIR PH Dataset" | "Google Maps" | "Manual";
  confidence: number;
}

export interface UnmappedSchoolGroup {
  groupKey: string;
  rawSchoolName: string;
  studentCount: number;
  processedIds: number[];
  importIds: number[];
  sampleStudents: Array<{
    studentNumber: string;
    fullName: string;
    course: string;
    locality: string;
  }>;
  consensusLocality: string;
  dominantStudentType: string;
  status: "ready_high" | "ambiguous_review" | "suggested_review" | "unresolved";
  ambiguityReason?: string;
  proposal: SmartProposal | null;
  alternatives: SmartProposal[];
}

interface PlanSummary {
  totalStudents: number;
  totalUnmappedStudents: number;
  totalGroups: number;
  readyHighGroups: number;
  readyHighStudents: number;
  reviewGroups: number;
  reviewStudents: number;
  unresolvedGroups: number;
  unresolvedStudents: number;
  projectedMappedPercent: number;
}

type FilterTab = "all" | "ready_high" | "review" | "unresolved";
type RunPhase = "idle" | "scanning" | "ready" | "applying" | "done" | "error";

function MapClickPin({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(Number(e.latlng.lat.toFixed(6)), Number(e.latlng.lng.toFixed(6)));
    },
  });
  return null;
}

export function UnmappedSmartMapperModal({
  open,
  onOpenChange,
  existingSchools,
  initialFocusSchool,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingSchools: SchoolRegistry[];
  initialFocusSchool?: string | null;
}) {
  const { toast } = useToast();
  const [phase, setPhase] = useState<RunPhase>("idle");
  const [minimized, setMinimized] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [summary, setSummary] = useState<PlanSummary | null>(null);
  const [groups, setGroups] = useState<UnmappedSchoolGroup[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [confirmedKeys, setConfirmedKeys] = useState<Set<string>>(new Set());

  const [filterTab, setFilterTab] = useState<FilterTab>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [expandedPinKey, setExpandedPinKey] = useState<string | null>(null);
  const [linkingGroupKey, setLinkingGroupKey] = useState<string | null>(null);
  const [linkSearchText, setLinkSearchText] = useState("");

  const [appliedStats, setAppliedStats] = useState<{
    resolvedGroups: number;
    resolvedStudents: number;
    schoolsCreated: number;
  } | null>(null);

  const isWorking = phase === "scanning" || phase === "applying";
  const ITEMS_PER_PAGE = 40;

  // Restore modal if reopened while minimized
  useEffect(() => {
    if (open && minimized) {
      setMinimized(false);
    }
  }, [open, minimized]);

  // Pre-fill search if opened from a specific student's Unmapped row
  useEffect(() => {
    if (open && initialFocusSchool) {
      setSearchQuery(initialFocusSchool);
      setFilterTab("all");
      setPage(1);
    } else if (open && !initialFocusSchool) {
      setSearchQuery("");
    }
  }, [open, initialFocusSchool]);

  // Automatically run fast local Tier 1 + Tier 2 (CAIR 25,562-school) scan on open
  useEffect(() => {
    if (open && !minimized && phase === "idle") {
      void runGeneratePlan(false);
    }
  }, [open, minimized, phase]);

  // Reset when completely closed and not running in background
  useEffect(() => {
    if (!open && !minimized && !isWorking) {
      const timer = setTimeout(() => {
        setPhase("idle");
        setProgress(0);
        setProgressLabel("");
        setErrorMessage(null);
        setExpandedPinKey(null);
        setLinkingGroupKey(null);
        setAppliedStats(null);
      }, 250);
      return () => clearTimeout(timer);
    }
  }, [open, minimized, isWorking]);

  const runGeneratePlan = async (includeGoogleFallback: boolean) => {
    setPhase("scanning");
    setErrorMessage(null);
    setProgress(includeGoogleFallback ? 25 : 40);
    setProgressLabel(
      includeGoogleFallback
        ? "Scanning unresolved schools with CAIR + Google Maps..."
        : "Scanning unmapped records against Registry & 25,562 CAIR PH schools...",
    );

    try {
      const res = await apiRequest("POST", "/api/admin/unmapped/generate-plan", {
        includeGoogleFallback,
      });
      const data = await res.json();
      setProgress(100);

      const nextGroups: UnmappedSchoolGroup[] = data.groups || [];
      setGroups(nextGroups);
      setSummary(data.summary || null);

      // Anti-Mis-Mapping Default: auto-check ONLY verified >=92% non-ambiguous matches
      const autoSafe = new Set<string>();
      for (const g of nextGroups) {
        if (g.status === "ready_high" && g.proposal) {
          autoSafe.add(g.groupKey);
        }
      }
      setSelectedKeys(autoSafe);
      setConfirmedKeys(new Set());
      setPage(1);
      setPhase("ready");
    } catch (err: any) {
      const msg = err?.message || "Failed to generate smart mapping plan.";
      setErrorMessage(msg);
      setPhase("error");
      toast({
        variant: "destructive",
        title: "Smart Scan Failed",
        description: msg,
      });
    }
  };

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

  const updateGroupProposal = (
    groupKey: string,
    nextProposal: SmartProposal,
    autoCheck = true,
  ) => {
    setGroups((prev) =>
      prev.map((g) =>
        g.groupKey === groupKey
          ? {
              ...g,
              proposal: nextProposal,
              status: nextProposal.confidence >= 92 ? "ready_high" : "suggested_review",
              ambiguityReason: undefined,
            }
          : g,
      ),
    );
    if (autoCheck) {
      setConfirmedKeys((prev) => new Set(prev).add(groupKey));
      setSelectedKeys((prev) => new Set(prev).add(groupKey));
    }
  };

  const filteredGroups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return groups.filter((g) => {
      if (filterTab === "ready_high" && g.status !== "ready_high") return false;
      if (
        filterTab === "review" &&
        g.status !== "ambiguous_review" &&
        g.status !== "suggested_review"
      ) {
        return false;
      }
      if (filterTab === "unresolved" && g.status !== "unresolved") return false;

      if (!q) return true;
      return (
        g.rawSchoolName.toLowerCase().includes(q) ||
        (g.proposal?.schoolName || "").toLowerCase().includes(q) ||
        (g.proposal?.municipality || "").toLowerCase().includes(q) ||
        (g.proposal?.province || "").toLowerCase().includes(q) ||
        g.consensusLocality.toLowerCase().includes(q) ||
        g.sampleStudents.some(
          (s) =>
            s.fullName.toLowerCase().includes(q) ||
            s.studentNumber.toLowerCase().includes(q),
        )
      );
    });
  }, [groups, filterTab, searchQuery]);

  const totalPages = Math.max(1, Math.ceil(filteredGroups.length / ITEMS_PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const pagedGroups = useMemo(() => {
    const start = (safePage - 1) * ITEMS_PER_PAGE;
    return filteredGroups.slice(start, start + ITEMS_PER_PAGE);
  }, [filteredGroups, safePage]);

  const selectedGroupsToApply = useMemo(
    () =>
      groups.filter(
        (g) =>
          selectedKeys.has(g.groupKey) &&
          g.proposal &&
          Number.isFinite(g.proposal.latitude) &&
          Number.isFinite(g.proposal.longitude),
      ),
    [groups, selectedKeys],
  );

  const selectedStudentsImpact = useMemo(
    () => selectedGroupsToApply.reduce((sum, g) => sum + g.studentCount, 0),
    [selectedGroupsToApply],
  );

  const handleApplySelected = async () => {
    if (selectedGroupsToApply.length === 0) return;

    setPhase("applying");
    setProgress(5);
    setErrorMessage(null);

    const CHUNK = 25;
    let totalResolvedGroups = 0;
    let totalResolvedStudents = 0;
    let totalSchoolsCreated = 0;

    try {
      for (let i = 0; i < selectedGroupsToApply.length; i += CHUNK) {
        const batch = selectedGroupsToApply.slice(i, i + CHUNK);
        setProgressLabel(
          `Mapping batch ${Math.min(i + CHUNK, selectedGroupsToApply.length)} of ${selectedGroupsToApply.length} school groups...`,
        );

        const payloadItems = batch.map((g) => ({
          groupKey: g.groupKey,
          rawSchoolName: g.rawSchoolName,
          processedIds: g.processedIds,
          importIds: g.importIds,
          existingSchoolId: g.proposal?.existingSchoolId,
          school: g.proposal
            ? {
                schoolId: g.proposal.schoolId,
                schoolName: g.proposal.schoolName,
                schoolType: g.proposal.schoolType,
                sector: g.proposal.sector,
                barangay: g.proposal.barangay,
                municipality: g.proposal.municipality,
                province: g.proposal.province,
                address: g.proposal.address,
                latitude: g.proposal.latitude,
                longitude: g.proposal.longitude,
                source:
                  g.proposal.source === "CAIR PH Dataset"
                    ? "CAIR PH Unified Coordinates"
                    : g.proposal.source,
              }
            : undefined,
        }));

        const res = await apiRequest("POST", "/api/admin/unmapped/apply-plan", {
          items: payloadItems,
        });
        const data = await res.json();

        totalResolvedGroups += Number(data.resolvedGroups || 0);
        totalResolvedStudents += Number(data.resolvedStudents || 0);
        totalSchoolsCreated += Number(data.schoolsCreated || 0);

        setProgress(
          Math.min(98, Math.round(((i + batch.length) / selectedGroupsToApply.length) * 100)),
        );
      }

      setProgress(100);
      setAppliedStats({
        resolvedGroups: totalResolvedGroups,
        resolvedStudents: totalResolvedStudents,
        schoolsCreated: totalSchoolsCreated,
      });

      // Refresh all live GIS & Registry queries
      void queryClient.invalidateQueries({ queryKey: [api.gis.overview.path] });
      void queryClient.invalidateQueries({ queryKey: [api.gis.processedStudents.path] });
      void queryClient.invalidateQueries({ queryKey: [api.gis.mapData.path] });
      void queryClient.invalidateQueries({ queryKey: [api.schoolRegistry.list.path] });
      void queryClient.invalidateQueries({ queryKey: ["/api/imports/staging"] });

      setPhase("done");
      toast({
        title: "Smart Mapping Complete!",
        description: `Mapped ${totalResolvedStudents.toLocaleString()} student${totalResolvedStudents === 1 ? "" : "s"} across ${totalResolvedGroups} school${totalResolvedGroups === 1 ? "" : "s"}.`,
      });
    } catch (err: any) {
      const msg = err?.message || "Failed while applying mappings.";
      setErrorMessage(msg);
      setPhase("error");
      toast({
        variant: "destructive",
        title: "Mapping Apply Failed",
        description: msg,
      });
    }
  };

  const showFloatingWidget =
    minimized && !open && (isWorking || phase === "done" || phase === "error");

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(val) => {
          if (!val && isWorking) {
            handleMinimize();
            return;
          }
          if (!val) setMinimized(false);
          onOpenChange(val);
        }}
      >
        <DialogContent className="sm:max-w-5xl max-h-[92dvh] flex flex-col overflow-hidden p-0 gap-0">
          {isWorking && (
            <button
              type="button"
              onClick={handleMinimize}
              title="Minimize to background"
              aria-label="Minimize to background"
              className="absolute right-10 top-4 z-20 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            >
              <Minus className="h-4 w-4" />
              <span className="sr-only">Minimize</span>
            </button>
          )}

          <div className="border-b border-border/60 bg-muted/20 px-6 pt-5 pb-4 shrink-0">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base sm:text-lg">
                <Sparkles className="h-5 w-5 text-amber-500" />
                Smart Unmapped Resolution &amp; Mapping Studio
              </DialogTitle>
              <DialogDescription className="text-xs sm:text-sm">
                Multi-signal large-dataset scanner powered by Official Registry Aliases &amp;{" "}
                <strong>25,562 CAIR PH Schools</strong> with strict homonym &amp; province cross-checks.
              </DialogDescription>
            </DialogHeader>

            {summary && phase === "ready" && (
              <div className="mt-3.5 grid grid-cols-2 gap-2 sm:grid-cols-5">
                <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-300">
                    Unmapped Students
                  </p>
                  <p className="text-lg font-black font-mono text-foreground">
                    {summary.totalUnmappedStudents.toLocaleString()}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    across {summary.totalGroups.toLocaleString()} schools
                  </p>
                </div>

                <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                    Safe Auto-Ready (≥92%)
                  </p>
                  <p className="text-lg font-black font-mono text-foreground">
                    {summary.readyHighGroups.toLocaleString()}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    unlocks {summary.readyHighStudents.toLocaleString()} students
                  </p>
                </div>

                <div className="rounded-xl border border-sky-500/25 bg-sky-500/10 px-3 py-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-sky-700 dark:text-sky-300">
                    Verify / Homonyms
                  </p>
                  <p className="text-lg font-black font-mono text-foreground">
                    {summary.reviewGroups.toLocaleString()}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {summary.reviewStudents.toLocaleString()} students
                  </p>
                </div>

                <div className="rounded-xl border border-rose-500/25 bg-rose-500/10 px-3 py-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-rose-700 dark:text-rose-300">
                    Needs Pin / Lookup
                  </p>
                  <p className="text-lg font-black font-mono text-foreground">
                    {summary.unresolvedGroups.toLocaleString()}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {summary.unresolvedStudents.toLocaleString()} students
                  </p>
                </div>

                <div className="rounded-xl border border-border/60 bg-card px-3 py-2 col-span-2 sm:col-span-1">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                    Projected Mapped
                  </p>
                  <p className="text-lg font-black font-mono text-emerald-600 dark:text-emerald-400">
                    {summary.projectedMappedPercent}%
                  </p>
                  <p className="text-[10px] text-muted-foreground">after safe auto-apply</p>
                </div>
              </div>
            )}
          </div>

          {isWorking && (
            <div className="flex-1 py-16 px-6 flex flex-col items-center justify-center space-y-5">
              <Loader2 className="h-12 w-12 animate-spin text-amber-500" />
              <div className="text-center space-y-1.5 max-w-md">
                <h3 className="font-semibold text-lg text-foreground">
                  {phase === "scanning"
                    ? "Generating Verified Mapping Plan..."
                    : "Applying Verified Mappings..."}
                </h3>
                <p className="text-xs sm:text-sm text-muted-foreground">{progressLabel}</p>
              </div>
              <Progress value={progress} className="w-full max-w-md h-2" />
            </div>
          )}

          {phase === "done" && appliedStats && (
            <div className="flex-1 py-14 px-6 flex flex-col items-center justify-center space-y-4">
              <div className="h-16 w-16 rounded-full bg-emerald-500/15 flex items-center justify-center">
                <CheckCircle2 className="h-9 w-9 text-emerald-600" />
              </div>
              <div className="text-center space-y-1 max-w-md">
                <h3 className="font-bold text-xl text-foreground">Mapping Applied!</h3>
                <p className="text-sm text-muted-foreground">
                  Successfully mapped{" "}
                  <strong>{appliedStats.resolvedStudents.toLocaleString()}</strong> students across{" "}
                  <strong>{appliedStats.resolvedGroups}</strong> feeder schools (
                  {appliedStats.schoolsCreated} new schools added to official registry + aliases
                  saved).
                </p>
              </div>
              <div className="flex items-center gap-2 pt-2">
                <Button variant="outline" onClick={() => void runGeneratePlan(false)}>
                  Re-Scan Remaining Unmapped
                </Button>
                <Button onClick={() => onOpenChange(false)}>Done</Button>
              </div>
            </div>
          )}

          {phase === "error" && (
            <div className="flex-1 py-14 px-6 flex flex-col items-center justify-center space-y-4">
              <AlertTriangle className="h-10 w-10 text-rose-500" />
              <div className="text-center space-y-1 max-w-md">
                <h3 className="font-semibold text-lg">Operation Interrupted</h3>
                <p className="text-sm text-muted-foreground">{errorMessage}</p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
                <Button onClick={() => void runGeneratePlan(false)}>Retry Scan</Button>
              </div>
            </div>
          )}

          {phase === "ready" && (
            <>
              {/* Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 bg-background px-6 py-2.5 shrink-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  {(
                    [
                      { id: "all", label: `All (${groups.length})` },
                      {
                        id: "ready_high",
                        label: `Safe Auto-Ready (${summary?.readyHighGroups ?? 0})`,
                      },
                      {
                        id: "review",
                        label: `Verify / Homonyms (${summary?.reviewGroups ?? 0})`,
                      },
                      {
                        id: "unresolved",
                        label: `Needs Pin (${summary?.unresolvedGroups ?? 0})`,
                      },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => {
                        setFilterTab(tab.id);
                        setPage(1);
                      }}
                      className={cn(
                        "rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors",
                        filterTab === tab.id
                          ? "bg-primary text-primary-foreground shadow-xs"
                          : "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-2 flex-1 sm:flex-initial justify-end">
                  <div className="relative w-full sm:w-64">
                    <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      value={searchQuery}
                      onChange={(e) => {
                        setSearchQuery(e.target.value);
                        setPage(1);
                      }}
                      placeholder="Filter school, town, student..."
                      className="h-8 pl-8 text-xs"
                    />
                  </div>
                  {(summary?.unresolvedGroups ?? 0) > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5 text-xs shrink-0"
                      onClick={() => void runGeneratePlan(true)}
                      title="Query Google Geocoding API for remaining unresolved schools"
                    >
                      <Globe className="h-3.5 w-3.5 text-sky-500" />
                      Google Scan ({Math.min(35, summary?.unresolvedGroups ?? 0)})
                    </Button>
                  )}
                </div>
              </div>

              {/* Group List */}
              {groups.length === 0 ? (
                <div className="flex-1 py-16 flex flex-col items-center justify-center text-center px-6">
                  <CheckCircle2 className="h-12 w-12 text-emerald-500 mb-2" />
                  <p className="font-semibold text-base text-foreground">
                    100% Mapped — Zero Unmapped Students!
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Every active student record is linked to a verified feeder school with
                    coordinates.
                  </p>
                </div>
              ) : (
                <ScrollArea className="flex-1 min-h-0 bg-muted/10">
                  <div className="divide-y divide-border/50 px-6 py-2">
                    {pagedGroups.map((group) => {
                      const isChecked = selectedKeys.has(group.groupKey);
                      const isConfirmed = confirmedKeys.has(group.groupKey);
                      const hasValidProposal = Boolean(
                        group.proposal &&
                          Number.isFinite(group.proposal.latitude) &&
                          Number.isFinite(group.proposal.longitude),
                      );
                      const isPinOpen = expandedPinKey === group.groupKey;
                      const isLinking = linkingGroupKey === group.groupKey;

                      return (
                        <div
                          key={group.groupKey}
                          className={cn(
                            "py-3.5 transition-colors",
                            isChecked && "bg-emerald-500/[0.03]",
                          )}
                        >
                          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                            {/* Left: Raw School + Student Consensus Info */}
                            <div className="flex items-start gap-3 min-w-0 flex-1">
                              <Checkbox
                                checked={isChecked}
                                onCheckedChange={(val) => {
                                  if (val && !hasValidProposal) {
                                    // Seed a manual proposal & open the map pin editor instead of blocking with a disabled stop cursor
                                    updateGroupProposal(
                                      group.groupKey,
                                      {
                                        schoolName: group.rawSchoolName,
                                        schoolType: "Public Senior High School",
                                        sector: "Public",
                                        barangay: "",
                                        municipality:
                                          group.consensusLocality.split(",")[0]?.trim() ||
                                          "Biñan City",
                                        province: "Laguna",
                                        address: group.consensusLocality,
                                        latitude: 14.3362,
                                        longitude: 121.0805,
                                        source: "Manual",
                                        confidence: 100,
                                      },
                                      true,
                                    );
                                    setExpandedPinKey(group.groupKey);
                                    return;
                                  }
                                  setSelectedKeys((prev) => {
                                    const next = new Set(prev);
                                    if (val) next.add(group.groupKey);
                                    else next.delete(group.groupKey);
                                    return next;
                                  });
                                }}
                                className="mt-1 cursor-pointer"
                              />
                              <div className="min-w-0 flex-1 space-y-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-semibold text-sm text-foreground break-words">
                                    {group.rawSchoolName}
                                  </span>
                                  <Badge
                                    variant="secondary"
                                    className="text-[10px] font-semibold gap-1 bg-amber-500/15 text-amber-700 dark:text-amber-300 border-0"
                                  >
                                    <Users className="h-3 w-3" />
                                    {group.studentCount}{" "}
                                    {group.studentCount === 1 ? "student" : "students"}
                                  </Badge>
                                  <Badge variant="outline" className="text-[10px]">
                                    {group.dominantStudentType}
                                  </Badge>
                                </div>

                                <p className="text-[11px] text-muted-foreground">
                                  Student Origin Consensus:{" "}
                                  <strong className="text-foreground/80">
                                    {group.consensusLocality}
                                  </strong>{" "}
                                  · Sample:{" "}
                                  {group.sampleStudents
                                    .slice(0, 2)
                                    .map((s) => `${s.fullName} (${s.course})`)
                                    .join(", ")}
                                </p>

                                {group.ambiguityReason && !isConfirmed && (
                                  <div className="flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/25 rounded-md px-2.5 py-1 mt-1 w-fit">
                                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                                    <span>{group.ambiguityReason}</span>
                                  </div>
                                )}

                                {/* 1-Click Competing Location Pills when Homonym / Alternatives exist */}
                                {group.alternatives.length > 0 && (
                                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                                    <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                      Other Candidates:
                                    </span>
                                    {group.alternatives.slice(0, 4).map((alt, i) => (
                                      <button
                                        key={`${alt.schoolId || alt.schoolName}-${i}`}
                                        type="button"
                                        onClick={() => updateGroupProposal(group.groupKey, alt, true)}
                                        className="rounded-md border border-border/70 bg-card px-2 py-0.5 text-[11px] text-muted-foreground hover:border-primary hover:text-foreground transition-colors"
                                        title={`Switch to ${alt.schoolName} (${alt.municipality}, ${alt.province})`}
                                      >
                                        {alt.schoolName} ·{" "}
                                        <strong>
                                          {alt.municipality}, {alt.province}
                                        </strong>
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* Right: Generated Proposal + Override Actions */}
                            <div className="lg:w-[410px] shrink-0 rounded-xl border border-border/60 bg-card p-2.5 space-y-2">
                              {group.proposal ? (
                                <div className="space-y-1">
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="flex items-center gap-1.5 min-w-0">
                                      <ShieldCheck
                                        className={cn(
                                          "h-4 w-4 shrink-0",
                                          group.status === "ready_high" || isConfirmed
                                            ? "text-emerald-500"
                                            : "text-amber-500",
                                        )}
                                      />
                                      <span className="text-xs font-bold text-foreground truncate">
                                        {group.proposal.schoolName}
                                      </span>
                                    </div>
                                    <div className="flex items-center gap-1 shrink-0">
                                      <Badge
                                        variant="outline"
                                        className={cn(
                                          "text-[10px] font-semibold",
                                          group.status === "ready_high" || isConfirmed
                                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                            : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
                                        )}
                                      >
                                        {isConfirmed ? "Confirmed" : `${group.proposal.confidence}%`}
                                      </Badge>
                                      <Badge variant="secondary" className="text-[10px]">
                                        {group.proposal.source}
                                      </Badge>
                                    </div>
                                  </div>

                                  <p className="text-[11px] text-muted-foreground">
                                    {group.proposal.municipality}, {group.proposal.province} ·{" "}
                                    <span className="font-mono text-[10px]">
                                      {group.proposal.latitude.toFixed(5)},{" "}
                                      {group.proposal.longitude.toFixed(5)}
                                    </span>
                                  </p>
                                </div>
                              ) : (
                                <div className="text-xs text-rose-600 dark:text-rose-400 font-medium flex items-center gap-1.5">
                                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                                  No automatic match found — link to registry or pin on map below.
                                </div>
                              )}

                              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-7 text-[11px] px-2.5 gap-1"
                                  onClick={() => {
                                    setLinkingGroupKey(isLinking ? null : group.groupKey);
                                    setLinkSearchText("");
                                    setExpandedPinKey(null);
                                  }}
                                >
                                  <Search className="h-3 w-3" />
                                  {isLinking ? "Cancel Link" : "Link Registry"}
                                </Button>

                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-7 text-[11px] px-2.5 gap-1"
                                  onClick={() => {
                                    if (!group.proposal) {
                                      // Seed default Laguna center pin for manual placement
                                      updateGroupProposal(
                                        group.groupKey,
                                        {
                                          schoolName: group.rawSchoolName,
                                          schoolType: "Public Senior High School",
                                          sector: "Public",
                                          barangay: "",
                                          municipality:
                                            group.consensusLocality.split(",")[0]?.trim() ||
                                            "Biñan City",
                                          province: "Laguna",
                                          address: group.consensusLocality,
                                          latitude: 14.3362,
                                          longitude: 121.0805,
                                          source: "Manual",
                                          confidence: 100,
                                        },
                                        true,
                                      );
                                    }
                                    setExpandedPinKey(isPinOpen ? null : group.groupKey);
                                    setLinkingGroupKey(null);
                                  }}
                                >
                                  <Crosshair className="h-3 w-3" />
                                  {isPinOpen ? "Hide Map" : "Pin / Verify Map"}
                                </Button>

                                {group.proposal &&
                                  group.status !== "ready_high" &&
                                  !isConfirmed && (
                                    <Button
                                      type="button"
                                      size="sm"
                                      className="h-7 text-[11px] px-2.5 bg-emerald-600 hover:bg-emerald-700 text-white ml-auto"
                                      onClick={() =>
                                        updateGroupProposal(
                                          group.groupKey,
                                          { ...group.proposal!, confidence: 100 },
                                          true,
                                        )
                                      }
                                    >
                                      Confirm Location
                                    </Button>
                                  )}
                              </div>

                              {isLinking && (
                                <div className="pt-1">
                                  <SchoolNameAutocomplete
                                    value={linkSearchText}
                                    onValueChange={setLinkSearchText}
                                    existingSchools={existingSchools}
                                    placeholder="Search official school in registry..."
                                    inputClassName="h-8 text-xs"
                                    onSelect={(sel) => {
                                      if (sel.type === "registry" && sel.school.latitude && sel.school.longitude) {
                                        updateGroupProposal(
                                          group.groupKey,
                                          {
                                            existingSchoolId: sel.school.id,
                                            schoolId: sel.school.schoolId || undefined,
                                            schoolName: sel.school.schoolName,
                                            schoolType:
                                              sel.school.schoolType || "Public Senior High School",
                                            sector: sel.school.sector || "Public",
                                            barangay: sel.school.barangay || "",
                                            municipality: sel.school.municipality || "Laguna",
                                            province: sel.school.province || "Laguna",
                                            address: sel.school.address || "",
                                            latitude: sel.school.latitude,
                                            longitude: sel.school.longitude,
                                            source: "Registry / Alias",
                                            confidence: 100,
                                          },
                                          true,
                                        );
                                        setLinkingGroupKey(null);
                                      }
                                    }}
                                  />
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Expandable Interactive Leaflet Pin Verifier / Editor */}
                          {isPinOpen && group.proposal && (
                            <div className="mt-3 rounded-xl border border-border/70 bg-card p-3 space-y-2.5">
                              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                                <Input
                                  value={group.proposal.schoolName}
                                  onChange={(e) =>
                                    updateGroupProposal(group.groupKey, {
                                      ...group.proposal!,
                                      schoolName: e.target.value,
                                    })
                                  }
                                  placeholder="Official School Name"
                                  className="h-8 text-xs"
                                />
                                <Input
                                  value={group.proposal.municipality}
                                  onChange={(e) =>
                                    updateGroupProposal(group.groupKey, {
                                      ...group.proposal!,
                                      municipality: e.target.value,
                                    })
                                  }
                                  placeholder="Municipality / City"
                                  className="h-8 text-xs"
                                />
                                <Input
                                  value={group.proposal.province}
                                  onChange={(e) =>
                                    updateGroupProposal(group.groupKey, {
                                      ...group.proposal!,
                                      province: e.target.value,
                                    })
                                  }
                                  placeholder="Province"
                                  className="h-8 text-xs"
                                />
                              </div>

                              <div className="h-52 w-full overflow-hidden rounded-lg border border-border/60 relative">
                                <MapContainer
                                  center={[group.proposal.latitude, group.proposal.longitude]}
                                  zoom={14}
                                  style={{ height: "100%", width: "100%" }}
                                >
                                  <TileLayer
                                    attribution="&copy; OpenStreetMap"
                                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                                  />
                                  <Marker
                                    position={[group.proposal.latitude, group.proposal.longitude]}
                                    icon={pinIcon}
                                  />
                                  <MapClickPin
                                    onPick={(lat, lng) =>
                                      updateGroupProposal(
                                        group.groupKey,
                                        {
                                          ...group.proposal!,
                                          latitude: lat,
                                          longitude: lng,
                                          source: "Manual",
                                          confidence: 100,
                                        },
                                        true,
                                      )
                                    }
                                  />
                                </MapContainer>
                              </div>
                              <p className="text-[11px] text-muted-foreground">
                                Click anywhere on the map to move the pin · Coordinates:{" "}
                                <strong className="font-mono">
                                  {group.proposal.latitude.toFixed(6)},{" "}
                                  {group.proposal.longitude.toFixed(6)}
                                </strong>
                              </p>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
              )}

              {/* Footer Pagination + Bulk Apply */}
              <DialogFooter className="border-t border-border/60 bg-muted/20 px-6 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 shrink-0">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2"
                    disabled={safePage <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <span>
                    Page {safePage} of {totalPages} ({filteredGroups.length} school groups)
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2"
                    disabled={safePage >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>

                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                    Close
                  </Button>
                  <Button
                    size="sm"
                    disabled={selectedGroupsToApply.length === 0}
                    onClick={handleApplySelected}
                    className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
                  >
                    <MapPin className="h-3.5 w-3.5" />
                    Apply {selectedGroupsToApply.length} Verified Mapping
                    {selectedGroupsToApply.length === 1 ? "" : "s"} (
                    {selectedStudentsImpact.toLocaleString()} Students)
                  </Button>
                </div>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Minimized Background Progress Widget */}
      {showFloatingWidget && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-4 right-4 z-50 w-80 rounded-xl border border-border/80 bg-card/95 p-3.5 shadow-xl backdrop-blur-md transition-all animate-in fade-in slide-in-from-bottom-3"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              {isWorking && (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              )}
              {phase === "done" && (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-600">
                  <CheckCircle2 className="h-4 w-4" />
                </div>
              )}
              {phase === "error" && (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-rose-500/15 text-rose-600">
                  <AlertTriangle className="h-4 w-4" />
                </div>
              )}

              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-foreground">
                  {phase === "scanning" && "Scanning Unmapped Schools..."}
                  {phase === "applying" && "Auto-Mapping Students..."}
                  {phase === "done" && "Smart Mapping Complete"}
                  {phase === "error" && "Smart Mapping Error"}
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {isWorking && `${progressLabel || "Processing"} · ${progress}%`}
                  {phase === "done" &&
                    appliedStats &&
                    `Mapped ${appliedStats.resolvedStudents.toLocaleString()} students`}
                  {phase === "error" && (errorMessage || "Action needed")}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={handleRestore}
                title="Expand Smart Mapper"
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
