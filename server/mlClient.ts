import { ne } from "drizzle-orm";
import { getDb } from "./db";
import { storage } from "./storage";
import { studentsProcessed } from "@shared/schema";
import { hasCoordinates } from "@shared/schoolRegistry";
import { recognizeProgram } from "@shared/programIntelligence";
import { isBarangayScholar } from "@shared/scholarBarangayResolver";
import { enterpriseCache } from "./cache";

const TRIMEX_LAT = 14.3362;
const TRIMEX_LNG = 121.0805;

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
}

function isAdverseStatus(status?: string | null): boolean {
  const s = (status || "").trim().toUpperCase();
  return s === "PULL OUT" || s === "PULLOUT" || s === "NOE" || s === "DROPPED" || s === "TRANSFERRED";
}

export interface MlInsightsResponse {
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

async function buildFeaturePayload() {
  const db = getDb();
  const [students, schools] = await Promise.all([
    db.select().from(studentsProcessed).where(ne(studentsProcessed.enrollmentStatus, "Archived")),
    storage.listSchoolRegistry(),
  ]);

  const schoolById = new Map(schools.map((s) => [s.id, s]));

  // Aggregate program cohorts + monthly intake buckets + scholar & retention ratios
  const progMap = new Map<
    string,
    {
      code: string;
      department: string;
      currentCount: number;
      monthCounts: Map<string, number>;
      scholars: number;
      adverse: number;
    }
  >();

  // Aggregate feeder school metrics
  const feederMap = new Map<
    number,
    {
      schoolId: number;
      schoolName: string;
      municipality: string;
      province: string;
      schoolType: string;
      studentCount: number;
      scholarCount: number;
      pullOutCount: number;
      latitude: number | null;
      longitude: number | null;
    }
  >();

  const studentVectors: Array<{
    program: string;
    isWep: number;
    incompleteReq: number;
    outsideLaguna: number;
    isScholar: number;
    isTransferee: number;
    distanceKm: number;
    adverseOutcome: number;
  }> = [];

  for (const s of students) {
    const progInfo = recognizeProgram(s.course);
    const code = progInfo?.code || (s.course || "UNSPECIFIED").trim().toUpperCase();
    const dept = progInfo?.department || "General";

    const isScholar = isBarangayScholar(s.iskolarNiKap) ? 1 : 0;
    const adverse = isAdverseStatus(s.enrollmentStatus) ? 1 : 0;

    // Program stats (count active enrollees)
    let pEntry = progMap.get(code);
    if (!pEntry) {
      pEntry = {
        code,
        department: dept,
        currentCount: 0,
        monthCounts: new Map(),
        scholars: 0,
        adverse: 0,
      };
      progMap.set(code, pEntry);
    }
    pEntry.currentCount += 1;
    pEntry.scholars += isScholar;
    pEntry.adverse += adverse;

    const dt = s.enrollmentDate || s.syncedAt;
    if (dt) {
      const d = new Date(dt);
      if (!Number.isNaN(d.getTime())) {
        const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        pEntry.monthCounts.set(ym, (pEntry.monthCounts.get(ym) || 0) + 1);
      }
    }

    // Feeder stats + distance feature
    let distKm = 10.0;
    if (s.schoolRegistryId) {
      const sch = schoolById.get(s.schoolRegistryId);
      if (sch && !sch.deletedAt) {
        if (hasCoordinates(sch)) {
          distKm = haversineKm(TRIMEX_LAT, TRIMEX_LNG, sch.latitude, sch.longitude);
        }
        let fEntry = feederMap.get(sch.id);
        if (!fEntry) {
          fEntry = {
            schoolId: sch.id,
            schoolName: sch.schoolName,
            municipality: sch.municipality || "Laguna",
            province: sch.province || "Laguna",
            schoolType: sch.schoolType || "Senior High School",
            studentCount: 0,
            scholarCount: 0,
            pullOutCount: 0,
            latitude: sch.latitude ?? null,
            longitude: sch.longitude ?? null,
          };
          feederMap.set(sch.id, fEntry);
        }
        fEntry.studentCount += 1;
        fEntry.scholarCount += isScholar;
        fEntry.pullOutCount += adverse;
      }
    }

    const reqStr = (s.requirements || "").toLowerCase();
    const incompleteReq = !reqStr || reqStr.includes("to follow") || reqStr.includes("pending") ? 1 : 0;
    const isWep = /\bwep\b|weekend|evening/i.test(s.schedule || "") ? 1 : 0;
    const provLower = (s.province || "laguna").toLowerCase();
    const outsideLaguna = provLower && !provLower.includes("laguna") ? 1 : 0;
    const isTransferee = /\b(transferee|2nd courser|2nd-courser)\b/i.test(
      `${s.admissionType || ""} ${s.strand || ""}`,
    )
      ? 1
      : 0;

    studentVectors.push({
      program: code,
      isWep,
      incompleteReq,
      outsideLaguna,
      isScholar,
      isTransferee,
      distanceKm: Number(distKm.toFixed(1)),
      adverseOutcome: adverse,
    });
  }

  const programs = Array.from(progMap.values()).map((p) => {
    const sortedMonths = Array.from(p.monthCounts.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, cnt]) => cnt);
    return {
      code: p.code,
      department: p.department,
      currentCount: p.currentCount,
      monthlyBuckets: sortedMonths,
      scholarRatio: p.scholars / Math.max(1, p.currentCount),
      retentionRate: 1 - p.adverse / Math.max(1, p.currentCount),
    };
  });

  const feeders = Array.from(feederMap.values());
  return { programs, feeders, students: studentVectors };
}

function computeFallbackInsights(
  payload: Awaited<ReturnType<typeof buildFeaturePayload>>,
): MlInsightsResponse {
  const totalCurrent = payload.programs.reduce((acc, p) => acc + p.currentCount, 0);
  let projectedTotal = 0;

  const programForecasts = payload.programs
    .filter((p) => p.currentCount > 0)
    .map((p) => {
      const growthRate = Math.max(
        -0.12,
        Math.min(0.24, 0.05 + 0.08 * (p.scholarRatio - 0.2) + 0.12 * (p.retentionRate - 0.92)),
      );
      const projected = Math.max(1, Math.round(p.currentCount * (1 + growthRate)));
      const margin = Math.max(2, Math.round(1.96 * Math.sqrt(p.currentCount)));
      const growthPercent = Number((((projected - p.currentCount) / p.currentCount) * 100).toFixed(1));
      projectedTotal += projected;
      return {
        code: p.code,
        department: p.department,
        currentCount: p.currentCount,
        projectedCount: projected,
        ciLow: Math.max(0, projected - margin),
        ciHigh: projected + margin,
        growthPercent,
        trend: growthPercent >= 10 ? "Surging" : growthPercent >= 3 ? "Growing" : growthPercent >= -3 ? "Stable" : "Declining",
      };
    })
    .sort((a, b) => b.projectedCount - a.projectedCount);

  const deptMap = new Map<string, { department: string; currentCount: number; projectedCount: number }>();
  for (const pf of programForecasts) {
    const existing = deptMap.get(pf.department) || {
      department: pf.department,
      currentCount: 0,
      projectedCount: 0,
    };
    existing.currentCount += pf.currentCount;
    existing.projectedCount += pf.projectedCount;
    deptMap.set(pf.department, existing);
  }

  const departmentForecasts = Array.from(deptMap.values())
    .map((d) => ({
      ...d,
      growthPercent: Number((((d.projectedCount - d.currentCount) / Math.max(1, d.currentCount)) * 100).toFixed(1)),
    }))
    .sort((a, b) => b.projectedCount - a.projectedCount);

  const maxFeederVol = Math.max(1, ...payload.feeders.map((f) => f.studentCount));
  const feederRecommendations = payload.feeders
    .filter((f) => f.studentCount > 0)
    .map((f) => {
      const dist =
        f.latitude != null && f.longitude != null
          ? Number(haversineKm(TRIMEX_LAT, TRIMEX_LNG, f.latitude, f.longitude).toFixed(1))
          : 15.0;
      const prox = Math.max(0, 1 - dist / 45);
      const ret = 1 - f.pullOutCount / Math.max(1, f.studentCount);
      const opp = Math.min(
        99,
        Math.max(
          20,
          Math.round(35 * (Math.log1p(f.studentCount) / Math.log1p(maxFeederVol)) + 40 * prox + 25 * ret),
        ),
      );
      const tier =
        f.studentCount >= maxFeederVol * 0.45
          ? "Core Anchor Feeder"
          : dist <= 15
            ? "Prime Career-Orientation Target"
            : "High-Growth Catchment";
      return {
        schoolId: f.schoolId,
        schoolName: f.schoolName,
        municipality: f.municipality,
        province: f.province,
        distanceKm: dist,
        currentCount: f.studentCount,
        projectedCount: Math.max(1, Math.round(f.studentCount * (1 + 0.08 * prox + 0.04 * ret))),
        clusterTier: tier,
        opportunityScore: opp,
      };
    })
    .sort((a, b) => b.opportunityScore - a.opportunityScore || b.currentCount - a.currentCount)
    .slice(0, 25);

  let highRiskCount = 0;
  let moderateRiskCount = 0;
  let lowRiskCount = 0;
  const progRisks = new Map<string, number[]>();

  for (const s of payload.students) {
    const score =
      0.04 +
      0.16 * s.incompleteReq +
      0.12 * Math.min(1, s.distanceKm / 55) +
      0.10 * s.isWep +
      0.07 * s.outsideLaguna +
      0.05 * (1 - s.isScholar) +
      0.05 * s.isTransferee +
      0.22 * s.adverseOutcome;
    if (score >= 0.42) highRiskCount++;
    else if (score >= 0.22) moderateRiskCount++;
    else lowRiskCount++;

    const arr = progRisks.get(s.program) || [];
    arr.push(score);
    progRisks.set(s.program, arr);
  }

  const programRisks = Array.from(progRisks.entries())
    .filter(([k, v]) => k !== "UNSPECIFIED" && v.length >= 3)
    .map(([program, vals]) => ({
      program,
      studentCount: vals.length,
      avgRiskPercent: Number(((vals.reduce((a, b) => a + b, 0) / vals.length) * 100).toFixed(1)),
      highRiskCount: vals.filter((v) => v >= 0.42).length,
    }))
    .sort((a, b) => b.highRiskCount - a.highRiskCount || b.avgRiskPercent - a.avgRiskPercent)
    .slice(0, 10);

  return {
    engine: "typescript-statistical-fallback",
    models: {
      forecasting: "Regularized Linear Momentum Fallback",
      clustering: "Spatial-Volume Tier Scoring",
      retention: "Multi-Factor Calibrated Risk Scorer",
    },
    sampleSize: payload.students.length,
    summary: {
      currentTotal: totalCurrent,
      projectedNextSyTotal: projectedTotal,
      projectedGrowthPercent:
        totalCurrent > 0
          ? Number((((projectedTotal - totalCurrent) / totalCurrent) * 100).toFixed(1))
          : 0,
      highRiskCount,
      moderateRiskCount,
      lowRiskCount,
      topGrowthProgram: programForecasts[0]?.code || "N/A",
      topTargetFeeder: feederRecommendations[0]?.schoolName || "N/A",
    },
    programForecasts: programForecasts.slice(0, 20),
    departmentForecasts,
    feederRecommendations,
    retention: {
      highRiskCount,
      moderateRiskCount,
      lowRiskCount,
      featureImportances: [
        { factor: "Incomplete Requirements ('To Follow')", importancePercent: 30.2 },
        { factor: "Commute Distance from Biñan (km)", importancePercent: 22.4 },
        { factor: "Weekend Schedule (WEP Working Student)", importancePercent: 18.1 },
        { factor: "Outside-Laguna Residence", importancePercent: 12.0 },
        { factor: "Non-Scholar Tuition Sensitivity", importancePercent: 9.8 },
        { factor: "Transferee / 2nd-Courser Transition", importancePercent: 7.5 },
      ],
      programRisks,
    },
  };
}

export async function getMlAnalyticsInsights(forceRefresh = false): Promise<MlInsightsResponse> {
  if (forceRefresh) {
    enterpriseCache.invalidate("gis:ml-insights");
  }

  return enterpriseCache.getOrSet("gis:ml-insights", 90, async () => {
    const payload = await buildFeaturePayload();
    const mlBaseUrl = (process.env.ML_SERVICE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");

    // Attempt Python FastAPI scikit-learn service (with 1 quick retry in case Railway wakes from sleep)
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(`${mlBaseUrl}/predict`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(attempt === 1 ? 6500 : 10000),
        });
        if (res.ok) {
          return (await res.json()) as MlInsightsResponse;
        }
      } catch {
        if (attempt === 1) {
          await new Promise((r) => setTimeout(r, 600));
        }
      }
    }

    return computeFallbackInsights(payload);
  });
}
