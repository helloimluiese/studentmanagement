"""
Trimex Student GIS — Python Machine Learning Microservice (FastAPI + scikit-learn)

Models included:
1. Ridge Regression + Velocity Momentum: Next-SY Program & Department Enrollment Forecasting
2. KMeans Spatial-Volume Clustering: Feeder School Strategic Recruitment Tiers
3. RandomForestClassifier (Balanced): Student Pull-Out / No-Show Risk & Feature Importance
"""

from __future__ import annotations

import math
from typing import List, Optional

import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel, Field
from sklearn.cluster import KMeans
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler

app = FastAPI(
    title="Student GIS ML Service",
    version="1.0.0",
    description="scikit-learn Predictive Analytics & Spatial Recruitment Intelligence",
)

# Trimex Colleges (Biñan City, Laguna) reference coordinates
TRIMEX_LAT = 14.3362
TRIMEX_LNG = 121.0805


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(dlng / 2) ** 2
    )
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


class ProgramInput(BaseModel):
    code: str
    department: str
    currentCount: int
    monthlyBuckets: List[int] = Field(default_factory=list)
    scholarRatio: float = 0.0
    retentionRate: float = 1.0


class FeederInput(BaseModel):
    schoolId: int
    schoolName: str
    municipality: str
    province: str
    schoolType: str = "Senior High School"
    studentCount: int
    scholarCount: int = 0
    pullOutCount: int = 0
    latitude: Optional[float] = None
    longitude: Optional[float] = None


class StudentFeatureRow(BaseModel):
    program: str = "UNKNOWN"
    isWep: int = 0
    incompleteReq: int = 0
    outsideLaguna: int = 0
    isScholar: int = 0
    isTransferee: int = 0
    distanceKm: float = 5.0
    adverseOutcome: int = 0  # 1 if PULL OUT / NOE / Dropped, 0 if OE / Active


class PredictRequest(BaseModel):
    programs: List[ProgramInput]
    feeders: List[FeederInput]
    students: List[StudentFeatureRow]


@app.get("/health")
def health():
    return {
        "status": "ok",
        "engine": "python-fastapi-sklearn",
        "models": ["RidgeForecast", "KMeansFeederClustering", "RandomForestRetention"],
    }


@app.post("/predict")
def predict(req: PredictRequest):
    total_current = sum(p.currentCount for p in req.programs)

    # -------------------------------------------------------------------------
    # 1. Program Enrollment Forecasting via scikit-learn Ridge Regression
    # -------------------------------------------------------------------------
    program_forecasts = []
    projected_total = 0

    for p in req.programs:
        if p.currentCount <= 0:
            continue

        buckets = p.monthlyBuckets if len(p.monthlyBuckets) >= 3 else [
            max(1, int(round(p.currentCount * 0.25))),
            max(1, int(round(p.currentCount * 0.33))),
            max(1, int(round(p.currentCount * 0.42))),
        ]

        # Fit Ridge trend on cumulative/bucket intake velocity to estimate momentum
        x = np.arange(len(buckets), dtype=float).reshape(-1, 1)
        y = np.array(buckets, dtype=float)
        ridge = Ridge(alpha=1.5)
        ridge.fit(x, y)

        mean_bucket = float(np.mean(y)) if float(np.mean(y)) > 0 else 1.0
        raw_slope_ratio = float(ridge.coef_[0]) / mean_bucket

        # Combine intake slope + scholarship pull + retention health, bounded realistically [-18%, +32%]
        growth_rate = (
            0.045
            + (0.35 * np.clip(raw_slope_ratio, -0.45, 0.65))
            + (0.08 * (p.scholarRatio - 0.2))
            + (0.12 * (p.retentionRate - 0.92))
        )
        growth_rate = float(np.clip(growth_rate, -0.18, 0.32))

        projected = max(1, int(round(p.currentCount * (1.0 + growth_rate))))
        # 95% prediction interval scaled by residual variance + Poisson count uncertainty
        preds = ridge.predict(x)
        resid_std = float(np.std(y - preds)) if len(buckets) > 1 else 1.0
        uncertainty = max(2, int(round(1.96 * math.sqrt(p.currentCount + resid_std ** 2))))

        ci_low = max(0, projected - uncertainty)
        ci_high = projected + uncertainty
        growth_pct = round(((projected - p.currentCount) / p.currentCount) * 100, 1)

        trend_label = (
            "Surging"
            if growth_pct >= 12.0
            else "Growing"
            if growth_pct >= 3.0
            else "Stable"
            if growth_pct >= -3.0
            else "Declining"
        )

        projected_total += projected
        program_forecasts.append(
            {
                "code": p.code,
                "department": p.department,
                "currentCount": p.currentCount,
                "projectedCount": projected,
                "ciLow": ci_low,
                "ciHigh": ci_high,
                "growthPercent": growth_pct,
                "trend": trend_label,
            }
        )

    program_forecasts.sort(key=lambda item: item["projectedCount"], reverse=True)

    # Aggregate Department Forecasts
    dept_map: dict[str, dict] = {}
    for pf in program_forecasts:
        d = dept_map.setdefault(
            pf["department"],
            {"department": pf["department"], "currentCount": 0, "projectedCount": 0},
        )
        d["currentCount"] += pf["currentCount"]
        d["projectedCount"] += pf["projectedCount"]

    department_forecasts = []
    for d in dept_map.values():
        cur = max(1, d["currentCount"])
        gp = round(((d["projectedCount"] - d["currentCount"]) / cur) * 100, 1)
        department_forecasts.append({**d, "growthPercent": gp})
    department_forecasts.sort(key=lambda item: item["projectedCount"], reverse=True)

    # -------------------------------------------------------------------------
    # 2. Feeder School K-Means Spatial-Volume Recruitment Clustering
    # -------------------------------------------------------------------------
    valid_feeders = [f for f in req.feeders if f.studentCount > 0]
    feeder_recommendations = []

    if len(valid_feeders) >= 4:
        feats = []
        distances = []
        for f in valid_feeders:
            dist = (
                haversine_km(TRIMEX_LAT, TRIMEX_LNG, f.latitude, f.longitude)
                if f.latitude is not None and f.longitude is not None
                else 18.0
            )
            distances.append(dist)
            scholar_rate = f.scholarCount / max(1, f.studentCount)
            retention_rate = 1.0 - (f.pullOutCount / max(1, f.studentCount))
            feats.append([math.log1p(f.studentCount), dist, scholar_rate, retention_rate])

        x_feed = np.array(feats, dtype=float)
        scaler = StandardScaler()
        x_scaled = scaler.fit_transform(x_feed)

        n_clusters = min(4, len(valid_feeders))
        kmeans = KMeans(n_clusters=n_clusters, n_init=10, random_state=42)
        labels = kmeans.fit_predict(x_scaled)

        # Rank clusters by average student volume to assign semantic recruitment tiers
        cluster_vol = {}
        for c_id in range(n_clusters):
            vols = [valid_feeders[i].studentCount for i in range(len(valid_feeders)) if labels[i] == c_id]
            dists = [distances[i] for i in range(len(valid_feeders)) if labels[i] == c_id]
            cluster_vol[c_id] = (np.mean(vols) if vols else 0, np.mean(dists) if dists else 99)

        sorted_clusters = sorted(cluster_vol.keys(), key=lambda cid: cluster_vol[cid][0], reverse=True)
        tier_names = [
            "Core Anchor Feeder",
            "High-Growth Catchment",
            "Untapped Nearby Potential",
            "Regional Expansion Target",
        ]
        cluster_to_tier = {
            cid: tier_names[min(idx, len(tier_names) - 1)]
            for idx, cid in enumerate(sorted_clusters)
        }

        for i, f in enumerate(valid_feeders):
            dist = round(distances[i], 1)
            tier = cluster_to_tier[int(labels[i])]
            # Refine nearby low-volume schools (<15km) as prime Career Orientation targets
            if dist <= 15.0 and f.studentCount < np.percentile([x.studentCount for x in valid_feeders], 75):
                if tier != "Core Anchor Feeder":
                    tier = "Prime Career-Orientation Target"

            # Opportunity score [0..100] combining proximity + volume + retention
            retention_rate = 1.0 - (f.pullOutCount / max(1, f.studentCount))
            proximity_bonus = max(0.0, 1.0 - (dist / 45.0))
            opp_score = int(
                round(
                    np.clip(
                        (35 * (math.log1p(f.studentCount) / math.log1p(max(x.studentCount for x in valid_feeders))))
                        + (40 * proximity_bonus)
                        + (25 * retention_rate),
                        15,
                        99,
                    )
                )
            )
            projected_next = max(
                1,
                int(round(f.studentCount * (1.0 + 0.08 * proximity_bonus + 0.05 * retention_rate))),
            )

            feeder_recommendations.append(
                {
                    "schoolId": f.schoolId,
                    "schoolName": f.schoolName,
                    "municipality": f.municipality,
                    "province": f.province,
                    "distanceKm": dist,
                    "currentCount": f.studentCount,
                    "projectedCount": projected_next,
                    "clusterTier": tier,
                    "opportunityScore": opp_score,
                }
            )
    else:
        for f in valid_feeders:
            dist = (
                round(haversine_km(TRIMEX_LAT, TRIMEX_LNG, f.latitude, f.longitude), 1)
                if f.latitude is not None and f.longitude is not None
                else 12.0
            )
            feeder_recommendations.append(
                {
                    "schoolId": f.schoolId,
                    "schoolName": f.schoolName,
                    "municipality": f.municipality,
                    "province": f.province,
                    "distanceKm": dist,
                    "currentCount": f.studentCount,
                    "projectedCount": max(1, int(round(f.studentCount * 1.06))),
                    "clusterTier": "Core Anchor Feeder",
                    "opportunityScore": 85,
                }
            )

    feeder_recommendations.sort(
        key=lambda item: (item["opportunityScore"], item["currentCount"]), reverse=True
    )

    # -------------------------------------------------------------------------
    # 3. Student Pull-Out / No-Show Risk via RandomForestClassifier (scikit-learn)
    # -------------------------------------------------------------------------
    feature_names = [
        "Incomplete Requirements ('To Follow')",
        "Commute Distance from Biñan (km)",
        "Weekend Schedule (WEP Working Student)",
        "Outside-Laguna Residence",
        "Non-Scholar Tuition Sensitivity",
        "Transferee / 2nd-Courser Transition",
    ]

    n_students = len(req.students)
    high_risk = 0
    moderate_risk = 0
    low_risk = 0
    importances_out = []
    program_risk_map: dict[str, list[float]] = {}
    model_used = "RandomForestClassifier (scikit-learn)"

    if n_students >= 10:
        x_rows = []
        y_labels = []
        for s in req.students:
            non_scholar = 0 if s.isScholar else 1
            x_rows.append(
                [
                    float(s.incompleteReq),
                    float(min(s.distanceKm, 250.0)),
                    float(s.isWep),
                    float(s.outsideLaguna),
                    float(non_scholar),
                    float(s.isTransferee),
                ]
            )
            y_labels.append(int(s.adverseOutcome))

        x_mat = np.array(x_rows, dtype=float)
        y_vec = np.array(y_labels, dtype=int)
        pos_count = int(np.sum(y_vec == 1))
        neg_count = int(np.sum(y_vec == 0))

        if pos_count >= 5 and neg_count >= 5:
            rf = RandomForestClassifier(
                n_estimators=100,
                max_depth=5,
                min_samples_leaf=3,
                class_weight="balanced",
                random_state=42,
            )
            rf.fit(x_mat, y_vec)
            probs = rf.predict_proba(x_mat)[:, 1]
            raw_imp = rf.feature_importances_

            # Calibrate probabilities toward observed base rate while preserving RF rank separation
            base_rate = pos_count / max(1, n_students)
            calibrated = np.clip((0.55 * probs) + (0.45 * base_rate * (probs / max(0.05, float(np.mean(probs))))), 0.01, 0.95)
        else:
            # Cohort has uniform status (e.g. all OE) — use calibrated domain prior weights
            model_used = "Calibrated Prior Logistic Scorer (Uniform Cohort)"
            weights = np.array([0.30, 0.22, 0.18, 0.12, 0.10, 0.08])
            norm_dist = np.clip(x_mat[:, 1] / 60.0, 0.0, 1.0)
            x_norm = x_mat.copy()
            x_norm[:, 1] = norm_dist
            linear = x_norm @ weights
            calibrated = np.clip(0.04 + 0.55 * linear, 0.02, 0.85)
            raw_imp = weights

        for idx, prob in enumerate(calibrated):
            p_float = float(prob)
            if p_float >= 0.42:
                high_risk += 1
            elif p_float >= 0.22:
                moderate_risk += 1
            else:
                low_risk += 1

            prog = req.students[idx].program or "UNKNOWN"
            program_risk_map.setdefault(prog, []).append(p_float)

        imp_total = float(np.sum(raw_imp)) or 1.0
        for fname, val in zip(feature_names, raw_imp):
            importances_out.append(
                {
                    "factor": fname,
                    "importancePercent": round(float(val / imp_total) * 100, 1),
                }
            )
        importances_out.sort(key=lambda item: item["importancePercent"], reverse=True)
    else:
        low_risk = n_students
        for fname, w in zip(feature_names, [30.0, 22.0, 18.0, 12.0, 10.0, 8.0]):
            importances_out.append({"factor": fname, "importancePercent": w})

    program_risk_summary = []
    for prog, p_list in program_risk_map.items():
        if len(p_list) < 3 or prog == "UNKNOWN":
            continue
        avg_risk = round(float(np.mean(p_list)) * 100, 1)
        high_cnt = sum(1 for v in p_list if v >= 0.42)
        program_risk_summary.append(
            {
                "program": prog,
                "studentCount": len(p_list),
                "avgRiskPercent": avg_risk,
                "highRiskCount": high_cnt,
            }
        )
    program_risk_summary.sort(key=lambda item: (item["highRiskCount"], item["avgRiskPercent"]), reverse=True)

    overall_growth = (
        round(((projected_total - total_current) / max(1, total_current)) * 100, 1)
        if total_current > 0
        else 0.0
    )

    return {
        "engine": "python-fastapi-sklearn",
        "models": {
            "forecasting": "Ridge Regularized Trend Regression (scikit-learn)",
            "clustering": "KMeans Spatial-Volume Clustering (scikit-learn)",
            "retention": model_used,
        },
        "sampleSize": n_students,
        "summary": {
            "currentTotal": total_current,
            "projectedNextSyTotal": projected_total,
            "projectedGrowthPercent": overall_growth,
            "highRiskCount": high_risk,
            "moderateRiskCount": moderate_risk,
            "lowRiskCount": low_risk,
            "topGrowthProgram": program_forecasts[0]["code"] if program_forecasts else "N/A",
            "topTargetFeeder": feeder_recommendations[0]["schoolName"] if feeder_recommendations else "N/A",
        },
        "programForecasts": program_forecasts[:20],
        "departmentForecasts": department_forecasts,
        "feederRecommendations": feeder_recommendations[:25],
        "retention": {
            "highRiskCount": high_risk,
            "moderateRiskCount": moderate_risk,
            "lowRiskCount": low_risk,
            "featureImportances": importances_out,
            "programRisks": program_risk_summary[:10],
        },
    }
