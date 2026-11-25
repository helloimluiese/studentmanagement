import { useQuery } from "@tanstack/react-query";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
} from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Sparkles,
  TrendingUp,
  AlertTriangle,
  ShieldCheck,
  Target,
  RefreshCw,
  Loader2,
  MapPin,
  Cpu,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface MlInsights {
  engine: "python-fastapi-sklearn" | "typescript-statistical-fallback";
  models: {
    forecasting: string;
    clustering: string;
    retention: string;
  };
  sampleSize: number;
  summary: {
    currentTotal: number;
    projectedNextSyTotal: number;
    projectedGrowthPercent: number;
    highRiskCount: number;
    moderateRiskCount: number;
    lowRiskCount: number;
    topGrowthProgram: string;
    topTargetFeeder: string;
  };
  programForecasts: Array<{
    code: string;
    department: string;
    currentCount: number;
    projectedCount: number;
    ciLow: number;
    ciHigh: number;
    growthPercent: number;
    trend: string;
  }>;
  departmentForecasts: Array<{
    department: string;
    currentCount: number;
    projectedCount: number;
    growthPercent: number;
  }>;
  feederRecommendations: Array<{
    schoolId: number;
    schoolName: string;
    municipality: string;
    province: string;
    distanceKm: number;
    currentCount: number;
    projectedCount: number;
    clusterTier: string;
    opportunityScore: number;
  }>;
  retention: {
    highRiskCount: number;
    moderateRiskCount: number;
    lowRiskCount: number;
    featureImportances: Array<{ factor: string; importancePercent: number }>;
    programRisks: Array<{
      program: string;
      studentCount: number;
      avgRiskPercent: number;
      highRiskCount: number;
    }>;
  };
}

export function PredictiveAnalyticsPanel({
  onSelectSchoolOnMap,
}: {
  onSelectSchoolOnMap: (schoolId: number) => void;
}) {
  const { data, isLoading, isFetching, refetch } = useQuery<MlInsights>({
    queryKey: ["/api/analytics/ml-insights"],
    queryFn: async () => {
      const res = await fetch("/api/analytics/ml-insights", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load ML insights");
      return res.json();
    },
    staleTime: 60_000,
  });

  const handleRetrainRefresh = async () => {
    await fetch("/api/analytics/ml-insights?refresh=1", { credentials: "include" });
    void refetch();
  };

  if (isLoading) {
    return (
      <Card className="rounded-2xl border-border/60 bg-card/80 p-12 shadow-sm">
        <div className="flex flex-col items-center justify-center gap-3 text-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm font-semibold text-foreground">
            Running Python scikit-learn Models (Ridge · KMeans · RandomForest)...
          </p>
          <p className="text-xs text-muted-foreground">
            Training on live student cohorts and spatial feeder coordinates
          </p>
        </div>
      </Card>
    );
  }

  if (!data) return null;

  const isPythonLive = data.engine === "python-fastapi-sklearn";

  return (
    <div className="mt-4 space-y-5">
      {/* Engine Status Banner */}
      <div className="flex flex-col gap-3 rounded-2xl border border-border/60 bg-card/80 p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
            <Cpu className="h-5 w-5" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-bold text-foreground">
                Predictive Enrollment &amp; Retention ML Engine
              </h3>
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px] font-semibold",
                  isPythonLive
                    ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "border-amber-500/35 bg-amber-500/10 text-amber-600 dark:text-amber-400",
                )}
              >
                {isPythonLive
                  ? "Python FastAPI · scikit-learn Active"
                  : "Statistical Fallback Mode"}
              </Badge>
              <Badge variant="secondary" className="text-[10px] font-mono">
                N = {data.sampleSize.toLocaleString()} records
              </Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Models: <strong>{data.models.forecasting}</strong> ·{" "}
              <strong>{data.models.clustering}</strong> ·{" "}
              <strong>{data.models.retention}</strong>
            </p>
          </div>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={handleRetrainRefresh}
          disabled={isFetching}
          className="gap-1.5 self-start sm:self-center shrink-0"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
          Re-Run ML Models
        </Button>
      </div>

      {/* Top Forecast KPI Strip */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="rounded-2xl border-border/60 bg-card/80 p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Next-SY Forecast
            </span>
            <TrendingUp className="h-4 w-4 text-emerald-500" />
          </div>
          <p className="mt-2 text-2xl font-extrabold font-mono text-foreground">
            {data.summary.projectedNextSyTotal.toLocaleString()}
          </p>
          <p className="mt-0.5 text-[11px] text-emerald-600 dark:text-emerald-400 font-semibold">
            {data.summary.projectedGrowthPercent >= 0 ? "+" : ""}
            {data.summary.projectedGrowthPercent}% vs current ({data.summary.currentTotal.toLocaleString()})
          </p>
        </Card>

        <Card className="rounded-2xl border-border/60 bg-card/80 p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Top Surge Program
            </span>
            <Sparkles className="h-4 w-4 text-indigo-500" />
          </div>
          <p className="mt-2 text-2xl font-extrabold text-foreground truncate">
            {data.summary.topGrowthProgram}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Highest projected intake volume
          </p>
        </Card>

        <Card className="rounded-2xl border-border/60 bg-card/80 p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Retention Watchlist
            </span>
            <AlertTriangle className="h-4 w-4 text-rose-500" />
          </div>
          <p className="mt-2 text-2xl font-extrabold font-mono text-rose-600 dark:text-rose-400">
            {data.summary.highRiskCount.toLocaleString()}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            High pull-out/no-show risk · {data.summary.moderateRiskCount.toLocaleString()} moderate
          </p>
        </Card>

        <Card className="rounded-2xl border-border/60 bg-card/80 p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              #1 Recruitment Hub
            </span>
            <Target className="h-4 w-4 text-amber-500" />
          </div>
          <p
            className="mt-2 text-sm font-extrabold text-foreground line-clamp-2 leading-tight"
            title={data.summary.topTargetFeeder}
          >
            {data.summary.topTargetFeeder}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">K-Means top opportunity score</p>
        </Card>
      </div>

      {/* Charts Row: Program Forecast vs Random Forest Feature Importances */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card className="rounded-2xl border-border/60 bg-card/80 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-bold">
              Program Enrollment Forecast (Current vs. Next SY)
            </CardTitle>
            <CardDescription className="text-xs">
              Ridge regression projection with 95% confidence bounds across top 10 programs
            </CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data.programForecasts.slice(0, 10)}
                margin={{ top: 8, right: 12, left: 0, bottom: 24 }}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.2} />
                <XAxis
                  dataKey="code"
                  tick={{ fontSize: 10 }}
                  angle={-25}
                  textAnchor="end"
                  height={42}
                />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="currentCount" name="Current SY" fill="#64748b" radius={[4, 4, 0, 0]} />
                <Bar
                  dataKey="projectedCount"
                  name="Projected Next SY"
                  fill="#10b981"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-border/60 bg-card/80 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-bold">
              Pull-Out / No-Show Risk Drivers (Feature Importance)
            </CardTitle>
            <CardDescription className="text-xs">
              Relative weight of enrollment &amp; geographic factors driving NOE / Pull-Out risk
            </CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data.retention.featureImportances}
                layout="vertical"
                margin={{ top: 6, right: 20, left: 30, bottom: 6 }}
              >
                <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} opacity={0.2} />
                <XAxis type="number" unit="%" tick={{ fontSize: 11 }} />
                <YAxis
                  dataKey="factor"
                  type="category"
                  width={175}
                  tick={{ fontSize: 10 }}
                />
                <Tooltip formatter={(val: any) => `${val}%`} />
                <Bar dataKey="importancePercent" name="Importance" radius={[0, 6, 6, 0]} barSize={20}>
                  {data.retention.featureImportances.map((_, index) => (
                    <Cell
                      key={index}
                      fill={index === 0 ? "#e11d48" : index === 1 ? "#f59e0b" : "#3b82f6"}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Tables Row: Program Forecast CI Table + KMeans Feeder Recruitment Recommendations */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card className="rounded-2xl border-border/60 bg-card/80 shadow-sm overflow-hidden">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-bold">
              Program Projections &amp; 95% Prediction Intervals
            </CardTitle>
            <CardDescription className="text-xs">
              Use upper bound (`CI High`) for section &amp; faculty capacity planning
            </CardDescription>
          </CardHeader>
          <div className="max-h-80 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Program</TableHead>
                  <TableHead className="text-xs text-right">Current</TableHead>
                  <TableHead className="text-xs text-right">Projected</TableHead>
                  <TableHead className="text-xs text-right">95% CI</TableHead>
                  <TableHead className="text-xs text-right">Trend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.programForecasts.map((pf) => (
                  <TableRow key={pf.code}>
                    <TableCell className="font-semibold text-xs">
                      {pf.code}{" "}
                      <span className="text-[10px] text-muted-foreground font-normal">
                        ({pf.department})
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {pf.currentCount}
                    </TableCell>
                    <TableCell className="text-right font-mono font-bold text-xs text-emerald-600 dark:text-emerald-400">
                      {pf.projectedCount}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[11px] text-muted-foreground">
                      {pf.ciLow}–{pf.ciHigh}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px]",
                          pf.growthPercent >= 3
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                            : pf.growthPercent < -2
                              ? "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                              : "border-border/60",
                        )}
                      >
                        {pf.growthPercent >= 0 ? "+" : ""}
                        {pf.growthPercent}%
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>

        <Card className="rounded-2xl border-border/60 bg-card/80 shadow-sm overflow-hidden">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-bold flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4 text-amber-500" />
              K-Means Feeder Recruitment &amp; Career-Orientation Targets
            </CardTitle>
            <CardDescription className="text-xs">
              Click any school to inspect its catchment pin on the GIS Map
            </CardDescription>
          </CardHeader>
          <div className="max-h-80 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Feeder School</TableHead>
                  <TableHead className="text-xs">ML Cluster Tier</TableHead>
                  <TableHead className="text-xs text-right">Dist</TableHead>
                  <TableHead className="text-xs text-right">Next SY</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.feederRecommendations.map((f) => (
                  <TableRow
                    key={f.schoolId}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => onSelectSchoolOnMap(f.schoolId)}
                  >
                    <TableCell className="text-xs">
                      <div className="font-semibold text-foreground flex items-center gap-1">
                        <MapPin className="h-3 w-3 text-primary shrink-0" />
                        <span className="line-clamp-1">{f.schoolName}</span>
                      </div>
                      <span className="text-[10px] text-muted-foreground">
                        {f.municipality}, {f.province}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="secondary"
                        className={cn(
                          "text-[10px]",
                          f.clusterTier.includes("Career-Orientation") &&
                            "bg-amber-500/15 text-amber-700 dark:text-amber-300",
                          f.clusterTier.includes("Anchor") &&
                            "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
                        )}
                      >
                        {f.clusterTier}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-[11px] text-muted-foreground">
                      {f.distanceKm} km
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs font-bold">
                      {f.currentCount} → {f.projectedCount}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      </div>
    </div>
  );
}
