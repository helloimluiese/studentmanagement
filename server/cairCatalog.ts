import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { and, eq, isNull, ne } from "drizzle-orm";
import { hasCoordinates, normalizeMunicipality, normalizeSchoolName } from "@shared/schoolRegistry";
import { cleanRawText, computeTypoSimilarity, phPhoneticKey } from "@shared/textNormalization";
import { schoolAliases, studentsProcessed, type InsertSchoolRegistry, type SchoolRegistry } from "@shared/schema";
import { storage } from "./storage";
import { getDb } from "./db";
import { enterpriseCache } from "./cache";

interface RawCairRecord {
  id: string;
  n: string;   // schoolName
  t: string;   // schoolType
  s: string;   // sector ("Public" | "Private")
  b: string;   // barangay
  m: string;   // municipality
  p: string;   // province
  a: string;   // address
  lat: number; // latitude
  lng: number; // longitude
}

export interface IndexedCairSchool extends RawCairRecord {
  normName: string;
  tokens: string[];
  coreTokens: string[];
  acronyms: string[];
  phonKey: string;
  normMuni: string;
  normProv: string;
}

const ACRONYM_CONNECTOR_WORDS = new Set([
  "of", "the", "and", "in", "at", "for", "to", "on", "de", "del", "dela", "la",
  "ng", "sa", "inc", "incorporated", "corp", "corporation",
]);

const ACRONYM_BRANCH_WORDS = new Set([
  "campus", "branch", "main", "annex", "extension", "standalone", "stand", "alone", "city", "province",
]);

const LOCALITY_NICKNAMES: Array<[RegExp, string]> = [
  [/\bgma\b/gi, "gen mariano alvarez"],
  [/\bdasma\b/gi, "dasmarinas"],
  [/\b(lb|elbi)\b/gi, "los banos"],
  [/\bqc\b/gi, "quezon city"],
  [/\bcdo\b/gi, "cagayan de oro"],
  [/\bbgc\b/gi, "taguig"],
  [/\bmunti\b/gi, "muntinlupa"],
  [/\bpque\b/gi, "paranaque"],
  [/\bmanda\b/gi, "mandaluyong"],
];

export function expandLocalityNicknames(input: string): string {
  let out = input || "";
  for (const [pattern, replacement] of LOCALITY_NICKNAMES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function generateSchoolAcronyms(rawName: string, municipality: string): string[] {
  const cleaned = cleanRawText(rawName.replace(/\([^)]*\)/g, ""));
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 2) return [];

  const toAcr = (list: string[]) =>
    list
      .map((w) => (w[0] && /[A-Za-z]/.test(w[0]) ? w[0].toUpperCase() : ""))
      .join("");

  const noConnectors = words.filter((w) => !ACRONYM_CONNECTOR_WORDS.has(w.toLowerCase()));
  const muniWords = new Set(
    cleanRawText(municipality || "")
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
  const noBranch = noConnectors.filter((w) => {
    const l = w.toLowerCase();
    return !ACRONYM_BRANCH_WORDS.has(l) && !muniWords.has(l);
  });

  // Also generate acronym without trailing generic "GMA" / branch word if embedded in name
  const withoutTrailingBranch =
    noBranch.length >= 4 ? noBranch.slice(0, noBranch.length - 1) : noBranch;

  return Array.from(
    new Set([toAcr(words), toAcr(noConnectors), toAcr(noBranch), toAcr(withoutTrailingBranch)]),
  ).filter((a) => a.length >= 2 && a.length <= 12);
}

const GENERIC_SUFFIX_TOKENS = new Set([
  "NATIONAL",
  "HIGH",
  "SENIOR",
  "JUNIOR",
  "INTEGRATED",
  "MEMORIAL",
  "STANDALONE",
  "STAND",
  "ALONE",
  "MAIN",
  "ANNEX",
  "EXTENSION",
  "TECHNICAL",
  "VOCATIONAL",
  "SECONDARY",
  "PUBLIC",
  "PRIVATE",
  "PROVINCE",
  "CITY",
]);

const STOP_INDEX_TOKENS = new Set([
  ...Array.from(GENERIC_SUFFIX_TOKENS),
  "SAN",
  "SANTA",
  "SANTO",
  "SAINT",
  "DEL",
  "DELA",
  "LOS",
  "LAS",
  "NEW",
  "OLD",
  "EAST",
  "WEST",
  "NORTH",
  "SOUTH",
  "CENTRAL",
  "PHILIPPINE",
  "PHILIPPINES",
  "STATE",
  "CHRISTIAN",
  "CATHOLIC",
  "FOUNDATION",
  "CENTER",
  "LEARNING",
  "EDUCATION",
  "EDUCATIONAL",
  "TECHNOLOGICAL",
  "TECHNOLOGY",
  "SCIENCE",
  "ARTS",
  "TRADES",
  "BUSINESS",
]);

const LAGUNA_PROVINCES = new Set(["laguna", "cavite", "batangas", "rizal", "quezon", "metro manila"]);

interface CairIndex {
  all: IndexedCairSchool[];
  byNormName: Map<string, IndexedCairSchool[]>;
  byToken: Map<string, IndexedCairSchool[]>;
  byAcronym: Map<string, IndexedCairSchool[]>;
}

let cachedIndex: CairIndex | null = null;

function getCairCatalogPath(): string {
  return path.join(process.cwd(), "server", "data", "cair_ph_schools.json.gz");
}

export function getCairIndex(): CairIndex {
  if (cachedIndex) return cachedIndex;

  const filePath = getCairCatalogPath();
  if (!fs.existsSync(filePath)) {
    cachedIndex = { all: [], byNormName: new Map(), byToken: new Map(), byAcronym: new Map() };
    return cachedIndex;
  }

  const compressed = fs.readFileSync(filePath);
  const rawList = JSON.parse(zlib.gunzipSync(compressed).toString("utf-8")) as RawCairRecord[];

  const all: IndexedCairSchool[] = [];
  const byNormName = new Map<string, IndexedCairSchool[]>();
  const byToken = new Map<string, IndexedCairSchool[]>();
  const byAcronym = new Map<string, IndexedCairSchool[]>();

  for (const r of rawList) {
    const normName = normalizeSchoolName(r.n);
    if (!normName) continue;
    const tokens = normName.split(" ").filter(Boolean);
    const coreTokens = tokens.filter((t) => !GENERIC_SUFFIX_TOKENS.has(t));
    const acronyms = generateSchoolAcronyms(r.n, r.m);
    const entry: IndexedCairSchool = {
      ...r,
      normName,
      tokens,
      coreTokens,
      acronyms,
      phonKey: phPhoneticKey(normName),
      normMuni: normalizeMunicipality(r.m),
      normProv: normalizeMunicipality(r.p),
    };
    all.push(entry);

    const exactBucket = byNormName.get(normName);
    if (exactBucket) exactBucket.push(entry);
    else byNormName.set(normName, [entry]);

    const seenTokens = new Set<string>();
    for (const tok of tokens) {
      if (tok.length < 3 || STOP_INDEX_TOKENS.has(tok) || seenTokens.has(tok)) continue;
      seenTokens.add(tok);
      const bucket = byToken.get(tok);
      if (bucket) bucket.push(entry);
      else byToken.set(tok, [entry]);
    }

    for (const acr of acronyms) {
      const b = byAcronym.get(acr);
      if (b) b.push(entry);
      else byAcronym.set(acr, [entry]);
    }
  }

  cachedIndex = { all, byNormName, byToken, byAcronym };
  return cachedIndex;
}

export interface CairLookupContext {
  municipality?: string | null;
  province?: string | null;
  address?: string | null;
  studentType?: string | null;
  consensusMunicipalities?: string[];
  consensusProvinces?: string[];
}

export interface CairCandidateOption {
  schoolId: string;
  schoolName: string;
  schoolType: string;
  sector: string;
  barangay: string;
  municipality: string;
  province: string;
  address: string;
  latitude: number;
  longitude: number;
  confidence: number;
}

export interface CairAnalysisResult {
  status: "ready_high" | "ambiguous_review" | "suggested_review" | "unresolved";
  best: CairCandidateOption | null;
  alternatives: CairCandidateOption[];
  ambiguityReason?: string;
}

function toCandidateOption(entry: IndexedCairSchool, confidence: number): CairCandidateOption {
  return {
    schoolId: entry.id,
    schoolName: entry.n,
    schoolType: entry.t,
    sector: entry.s,
    barangay: entry.b || "",
    municipality: entry.m || entry.p || "Philippines",
    province: entry.p || entry.m || "Philippines",
    address: entry.a || [entry.b, entry.m, entry.p].filter(Boolean).join(", "),
    latitude: entry.lat,
    longitude: entry.lng,
    confidence,
  };
}

function disambiguateCandidates(
  candidates: IndexedCairSchool[],
  rawQueryCleaned: string,
  ctx?: CairLookupContext,
): IndexedCairSchool | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const queryLower = rawQueryCleaned.toLowerCase();
  const hintText = [ctx?.address, ctx?.municipality, ctx?.province]
    .filter(Boolean)
    .map((s) => cleanRawText(String(s)).toLowerCase())
    .join(" ");

  // 1. Prefer candidate whose municipality or province is explicitly named in the school string itself
  const queryLocMatches = candidates.filter(
    (c) =>
      (c.normMuni && c.normMuni.length >= 4 && queryLower.includes(c.normMuni)) ||
      (c.normProv && c.normProv.length >= 4 && queryLower.includes(c.normProv)),
  );
  if (queryLocMatches.length === 1) return queryLocMatches[0];

  const pool = queryLocMatches.length > 0 ? queryLocMatches : candidates;

  // 2. Prefer Higher Education / College over TESDA when the name is a University/College or student is a Transferee
  const isTransferee = /\b(transferee|2nd courser|college)\b/i.test(ctx?.studentType || "");
  const looksHigherEd = isTransferee || /\b(university|college|polytechnic)\b/i.test(rawQueryCleaned);
  if (looksHigherEd) {
    const colleges = pool.filter((c) => c.t === "Higher Education / College");
    if (colleges.length === 1) return colleges[0];
    if (colleges.length > 1) {
      // Narrow pool to HEIs (preferring Main campus if unspecified)
      const mainCampus = colleges.filter((c) => /\bmain\b/i.test(c.n));
      if (mainCampus.length === 1 && !queryLocMatches.length) return mainCampus[0];
      pool.splice(0, pool.length, ...colleges);
    }
  }

  // 3. Match against student's home municipality / province hint
  if (hintText) {
    const muniMatches = pool.filter((c) => c.normMuni && c.normMuni.length >= 4 && hintText.includes(c.normMuni));
    if (muniMatches.length === 1) return muniMatches[0];
    if (muniMatches.length > 1) {
      const shs = muniMatches.filter((c) => c.t.includes("Senior High"));
      if (shs.length === 1) return shs[0];
      return muniMatches[0];
    }

    const provMatches = pool.filter((c) => c.normProv && c.normProv.length >= 4 && hintText.includes(c.normProv));
    if (provMatches.length === 1) return provMatches[0];
  }

  // 4. If all candidates are actually in the exact same municipality (e.g. JHS + Stand-Alone SHS on same compound), pick Senior High first
  const uniqueMunis = new Set(pool.map((c) => `${c.normMuni}|${c.normProv}`));
  if (uniqueMunis.size === 1) {
    const shs = pool.find((c) => c.t.includes("Senior High"));
    return shs || pool[0];
  }

  // 5. Prioritize Laguna / CALABARZON if exactly 1 candidate is in Laguna and student address has no conflicting province
  const lagunaOnly = pool.filter((c) => c.normProv === "laguna");
  if (lagunaOnly.length === 1 && (!hintText || hintText.includes("laguna") || hintText.includes("binan") || hintText.includes("rosa") || hintText.includes("cabuyao") || hintText.includes("pedro") || hintText.includes("calamba"))) {
    return lagunaOnly[0];
  }

  const region4aOnly = pool.filter((c) => LAGUNA_PROVINCES.has(c.normProv));
  if (region4aOnly.length === 1 && (!hintText || Array.from(LAGUNA_PROVINCES).some((p) => hintText.includes(p)))) {
    return region4aOnly[0];
  }

  return null;
}

/**
 * Searches the 25,562-school CAIR PH Unified Coordinates dataset for a matching
 * feeder school, college/HEI, or TESDA institution.
 */
export function findSchoolInCairCatalog(
  rawSchoolName: string,
  ctx?: CairLookupContext,
): { entry: IndexedCairSchool; confidence: number } | null {
  const cleaned = cleanRawText(rawSchoolName || "");
  const normQuery = normalizeSchoolName(rawSchoolName || "");
  if (!normQuery || normQuery.length < 3) return null;

  const index = getCairIndex();
  if (index.all.length === 0) return null;

  // Tier 1: Exact normalized name match
  const exactCandidates = index.byNormName.get(normQuery);
  if (exactCandidates && exactCandidates.length > 0) {
    const chosen = disambiguateCandidates(exactCandidates, cleaned, ctx);
    if (chosen) return { entry: chosen, confidence: 98 };
  }

  // Gather candidate pool via inverted token index (fast O(1) bucket union)
  const queryTokens = normQuery.split(" ").filter(Boolean);
  const queryCoreTokens = queryTokens.filter((t) => !GENERIC_SUFFIX_TOKENS.has(t));

  const candidateSet = new Set<IndexedCairSchool>();
  for (const tok of queryTokens) {
    const bucket = index.byToken.get(tok);
    if (bucket) {
      for (const item of bucket) candidateSet.add(item);
    }
    // Also check phonetic / prefix variations for typos in distinctive words (e.g. Tagbiliran -> Tagbilaran)
    if (tok.length >= 5 && candidateSet.size < 80) {
      const prefix4 = tok.slice(0, 4);
      index.byToken.forEach((b, key) => {
        if (key.startsWith(prefix4) && Math.abs(key.length - tok.length) <= 2) {
          for (const item of b) candidateSet.add(item);
        }
      });
    }
  }

  if (candidateSet.size === 0) return null;

  const scored: Array<{ entry: IndexedCairSchool; score: number }> = [];
  const queryTokenSet = new Set(queryTokens);
  const queryHasGeneric =
    queryTokens.some((qt) => GENERIC_SUFFIX_TOKENS.has(qt)) ||
    /\b(school|high|college|university|institute|academy|polytechnic)\b/i.test(cleaned);
  const hintLower = [ctx?.address, ctx?.municipality, ctx?.province]
    .filter(Boolean)
    .map((s) => cleanRawText(String(s)).toLowerCase())
    .join(" ");

  candidateSet.forEach((cand) => {
    // Case A: Shortened prefix / colloquial school level (e.g. "binan integrated" -> "Biñan National High School")
    // Core tokens match identically, and all non-core tokens on both sides are generic school-level words.
    if (
      queryTokens.length >= 2 &&
      queryHasGeneric &&
      queryCoreTokens.length >= 1 &&
      queryCoreTokens.length === cand.coreTokens.length &&
      queryCoreTokens.every((qt, idx) => qt === cand.coreTokens[idx])
    ) {
      scored.push({ entry: cand, score: 0.95 });
      return;
    }

    // Case B: Location-appended input (e.g. "West Palale National High School Quezon Province"
    // or "Manga National High School Tagbiliran Bohol")
    if (cand.coreTokens.length >= 1 && cand.tokens.every((ct) => queryTokenSet.has(ct))) {
      const extraQueryTokens = queryTokens.filter((qt) => !cand.tokens.includes(qt));
      const candLocNorm = `${cand.normMuni} ${cand.normProv} bicol cdo region`.toUpperCase();
      const locExplained = extraQueryTokens.every(
        (et) =>
          GENERIC_SUFFIX_TOKENS.has(et) ||
          candLocNorm.includes(et) ||
          (cand.normMuni && computeTypoSimilarity(et.toLowerCase(), cand.normMuni) >= 0.8),
      );
      if (locExplained) {
        scored.push({ entry: cand, score: 0.96 });
        return;
      }
    }

    // Case C: Typo / Fuzzy similarity on normalized name (or normalized name + municipality)
    const baseSim = computeTypoSimilarity(normQuery, cand.normName);
    let bestSim = baseSim;

    if (cand.normMuni || cand.normProv) {
      const withMuni = [cand.normName, cand.normMuni.toUpperCase()].filter(Boolean).join(" ");
      const withProv = [cand.normName, cand.normProv.toUpperCase()].filter(Boolean).join(" ");
      const withBoth = [cand.normName, cand.normMuni.toUpperCase(), cand.normProv.toUpperCase()].filter(Boolean).join(" ");
      bestSim = Math.max(
        bestSim,
        computeTypoSimilarity(normQuery, withMuni),
        computeTypoSimilarity(normQuery, withProv),
        computeTypoSimilarity(normQuery, withBoth),
      );
    }

    // Require stricter similarity (0.92) when jumping to an unrelated province not mentioned in query or student hint
    const sameLocalityHint =
      (cand.normProv && (cleaned.toLowerCase().includes(cand.normProv) || hintLower.includes(cand.normProv))) ||
      (cand.normMuni && (cleaned.toLowerCase().includes(cand.normMuni) || hintLower.includes(cand.normMuni)));
    const minThreshold = sameLocalityHint ? 0.86 : 0.92;

    if (bestSim >= minThreshold) {
      scored.push({ entry: cand, score: bestSim });
    }
  });

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);

  const topScore = scored[0].score;
  const topGroup = scored.filter((s) => topScore - s.score <= 0.025).map((s) => s.entry);

  const chosen = disambiguateCandidates(topGroup, cleaned, ctx);
  if (!chosen) return null;

  return { entry: chosen, confidence: Math.round(topScore * 100) };
}

/**
 * Multi-signal, anti-false-positive analyzer for the Advanced Unmapped Smart Mapper.
 * Enforces Homonym / Multi-Province Collision Guards, Student-Origin Consensus Voting,
 * and Admission/Strand Cross-Checks, returning top candidate alternatives when ambiguous.
 */
export function analyzeCairCandidates(
  rawSchoolName: string,
  ctx?: CairLookupContext & { hasShsStrand?: boolean },
): CairAnalysisResult {
  const cleaned = cleanRawText(rawSchoolName || "");
  const normQuery = normalizeSchoolName(rawSchoolName || "");
  if (!normQuery || normQuery.length < 3) {
    return { status: "unresolved", best: null, alternatives: [] };
  }

  const index = getCairIndex();
  if (index.all.length === 0) {
    return { status: "unresolved", best: null, alternatives: [] };
  }

  const queryLower = cleaned.toLowerCase();
  const queryTokens = normQuery.split(" ").filter(Boolean);
  const queryCoreTokens = queryTokens.filter((t) => !GENERIC_SUFFIX_TOKENS.has(t));
  const queryTokenSet = new Set(queryTokens);
  const queryHasGeneric =
    queryTokens.some((qt) => GENERIC_SUFFIX_TOKENS.has(qt)) ||
    /\b(school|high|college|university|institute|academy|polytechnic)\b/i.test(cleaned);

  const consensusMunis = (ctx?.consensusMunicipalities || []).map((m) => normalizeMunicipality(m)).filter(Boolean);
  const consensusProvs = (ctx?.consensusProvinces || []).map((p) => normalizeMunicipality(p)).filter(Boolean);
  const hintLower = [
    ctx?.address,
    ctx?.municipality,
    ctx?.province,
    ...consensusMunis,
    ...consensusProvs,
  ]
    .filter(Boolean)
    .map((s) => cleanRawText(String(s)).toLowerCase())
    .join(" ");

  const isTransferee = /\b(transferee|2nd courser|college)\b/i.test(ctx?.studentType || "");
  const looksHigherEd = isTransferee || /\b(university|college|polytechnic)\b/i.test(cleaned);

  // Build candidate pool from exact + token buckets + dynamic acronym buckets
  const candidateSet = new Set<IndexedCairSchool>();
  const exactBucket = index.byNormName.get(normQuery);
  if (exactBucket) {
    for (const item of exactBucket) candidateSet.add(item);
  }

  // Dynamic Acronym + Branch/Town Lookup (e.g. "UPHSL GMA", "PUP Sta Rosa", "LPU Cavite", "SPRCNHS")
  const rawWords = cleaned.split(/\s+/).filter(Boolean);
  const firstWordUpper = (rawWords[0] || "").toUpperCase().replace(/[^A-Z]/g, "");
  const fullLettersUpper = cleaned.toUpperCase().replace(/[^A-Z]/g, "");
  const branchTailRaw = rawWords.slice(1).join(" ");
  const branchTailExpanded = cleanRawText(expandLocalityNicknames(branchTailRaw)).toLowerCase();

  const acronymMatches = new Set<IndexedCairSchool>();
  if (firstWordUpper.length >= 2 && firstWordUpper.length <= 10) {
    const directAcr = index.byAcronym.get(firstWordUpper) || [];
    for (const item of directAcr) acronymMatches.add(item);
    // Also support 5+ letter system acronyms with trailing system letter (e.g. UPHSL / UPHSD -> UPHS) when a branch/town is specified
    if (firstWordUpper.length >= 5 && branchTailExpanded.length >= 3) {
      const baseAcr = index.byAcronym.get(firstWordUpper.slice(0, -1)) || [];
      for (const item of baseAcr) acronymMatches.add(item);
    }
  }
  if (rawWords.length === 1 && fullLettersUpper.length >= 3 && fullLettersUpper.length <= 12) {
    const fullAcr = index.byAcronym.get(fullLettersUpper) || [];
    for (const item of fullAcr) acronymMatches.add(item);
  }
  for (const item of Array.from(acronymMatches)) {
    candidateSet.add(item);
  }
  for (const tok of queryTokens) {
    const bucket = index.byToken.get(tok);
    if (bucket) {
      for (const item of bucket) candidateSet.add(item);
    }
    if (tok.length >= 5 && candidateSet.size < 120) {
      const prefix4 = tok.slice(0, 4);
      index.byToken.forEach((b, key) => {
        if (key.startsWith(prefix4) && Math.abs(key.length - tok.length) <= 2) {
          for (const item of b) candidateSet.add(item);
        }
      });
    }
  }

  if (candidateSet.size === 0) {
    return { status: "unresolved", best: null, alternatives: [] };
  }

  const scored: Array<{ entry: IndexedCairSchool; score: number }> = [];

  candidateSet.forEach((cand) => {
    let score = 0;

    if (cand.normName === normQuery) {
      score = 0.97;
    } else if (
      queryTokens.length >= 2 &&
      queryHasGeneric &&
      queryCoreTokens.length >= 1 &&
      queryCoreTokens.length === cand.coreTokens.length &&
      queryCoreTokens.every((qt, idx) => qt === cand.coreTokens[idx])
    ) {
      score = 0.95;
    } else if (cand.coreTokens.length >= 1 && cand.tokens.every((ct) => queryTokenSet.has(ct))) {
      const extraQueryTokens = queryTokens.filter((qt) => !cand.tokens.includes(qt));
      const candLocNorm = `${cand.normMuni} ${cand.normProv} bicol cdo region`.toUpperCase();
      const locExplained = extraQueryTokens.every(
        (et) =>
          GENERIC_SUFFIX_TOKENS.has(et) ||
          candLocNorm.includes(et) ||
          (cand.normMuni && computeTypoSimilarity(et.toLowerCase(), cand.normMuni) >= 0.8),
      );
      if (locExplained) score = 0.96;
    }

    if (score === 0 && acronymMatches.has(cand)) {
      if (branchTailExpanded.length >= 3) {
        const candLoc = `${cand.normMuni} ${cand.normProv} ${cand.n.toLowerCase()} ${cand.b.toLowerCase()}`;
        const branchTokens = branchTailExpanded.split(/\s+/).filter((t) => t.length >= 3);
        if (branchTokens.length > 0 && branchTokens.every((bt) => candLoc.includes(bt))) {
          score = 0.94;
        }
      } else if (rawWords.length === 1 && firstWordUpper.length >= 4) {
        score = 0.89;
      }
    }

    if (score === 0) {
      let bestSim = computeTypoSimilarity(normQuery, cand.normName);
      if (cand.normMuni || cand.normProv) {
        const withMuni = [cand.normName, cand.normMuni.toUpperCase()].filter(Boolean).join(" ");
        const withProv = [cand.normName, cand.normProv.toUpperCase()].filter(Boolean).join(" ");
        bestSim = Math.max(
          bestSim,
          computeTypoSimilarity(normQuery, withMuni),
          computeTypoSimilarity(normQuery, withProv),
        );
      }
      if (bestSim >= 0.76) {
        score = bestSim;
      }
    }

    if (score === 0) return;

    // Multi-signal cross-check adjustments:
    // 1. Explicit locality named in the school string itself (+0.03)
    const namedInQuery =
      (cand.normMuni && cand.normMuni.length >= 4 && queryLower.includes(cand.normMuni)) ||
      (cand.normProv && cand.normProv.length >= 4 && queryLower.includes(cand.normProv));
    if (namedInQuery) score = Math.min(0.99, score + 0.03);

    // 2. Consensus student origin alignment (+0.02 muni, +0.01 prov)
    if (cand.normMuni && consensusMunis.includes(cand.normMuni)) {
      score = Math.min(0.99, score + 0.02);
    } else if (cand.normProv && consensusProvs.includes(cand.normProv)) {
      score = Math.min(0.99, score + 0.01);
    }

    // 3. Sector / Admission-type cross-check
    if (looksHigherEd && cand.t === "Higher Education / College") {
      score = Math.min(0.99, score + 0.02);
    } else if (looksHigherEd && cand.t !== "Higher Education / College" && !/\b(tesda|vocational|technical)\b/i.test(cleaned)) {
      score -= 0.05;
    } else if (!looksHigherEd && ctx?.hasShsStrand && cand.t.includes("Senior High")) {
      score = Math.min(0.99, score + 0.01);
    }

    if (score >= 0.75) {
      scored.push({ entry: cand, score });
    }
  });

  if (scored.length === 0) {
    return { status: "unresolved", best: null, alternatives: [] };
  }

  scored.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 0.005) return b.score - a.score;
    // Tie-break: prefer consensus locality, then Laguna, then Region 4A
    const aLocal = (a.entry.normMuni && hintLower.includes(a.entry.normMuni) ? 4 : 0) + (a.entry.normProv === "laguna" ? 2 : LAGUNA_PROVINCES.has(a.entry.normProv) ? 1 : 0);
    const bLocal = (b.entry.normMuni && hintLower.includes(b.entry.normMuni) ? 4 : 0) + (b.entry.normProv === "laguna" ? 2 : LAGUNA_PROVINCES.has(b.entry.normProv) ? 1 : 0);
    return bLocal - aLocal;
  });

  // Deduplicate top alternatives by (id)
  const uniqueScored: Array<{ entry: IndexedCairSchool; score: number }> = [];
  const seenIds = new Set<string>();
  for (const item of scored) {
    if (seenIds.has(item.entry.id)) continue;
    seenIds.add(item.entry.id);
    uniqueScored.push(item);
    if (uniqueScored.length >= 6) break;
  }

  const topScore = uniqueScored[0].score;
  const closeCompetitors = uniqueScored.filter((s) => topScore - s.score <= 0.02);
  const distinctLocalities = new Set(closeCompetitors.map((s) => `${s.entry.normMuni}|${s.entry.normProv}`));

  // Homonym / Multi-Province Collision Guard!
  if (distinctLocalities.size > 1) {
    const disambiguated = disambiguateCandidates(
      closeCompetitors.map((c) => c.entry),
      cleaned,
      ctx,
    );

    // Only auto-trust disambiguation if the locality was explicitly in the school name OR strongly matched consensus municipality
    const explicitProof =
      disambiguated &&
      ((disambiguated.normMuni && disambiguated.normMuni.length >= 4 && queryLower.includes(disambiguated.normMuni)) ||
        (disambiguated.normProv && disambiguated.normProv.length >= 4 && queryLower.includes(disambiguated.normProv)) ||
        (disambiguated.normMuni && consensusMunis[0] === disambiguated.normMuni) ||
        (looksHigherEd && /\bmain\b/i.test(disambiguated.n)));

    if (disambiguated && explicitProof && topScore >= 0.92) {
      const bestOpt = toCandidateOption(disambiguated, Math.round(topScore * 100));
      const alts = uniqueScored
        .filter((u) => u.entry.id !== disambiguated.id)
        .slice(0, 4)
        .map((u) => toCandidateOption(u.entry, Math.round(u.score * 100)));
      return { status: "ready_high", best: bestOpt, alternatives: alts };
    }

    const primary = disambiguated || uniqueScored[0].entry;
    const cappedConf = Math.min(88, Math.round(topScore * 100));
    const bestOpt = toCandidateOption(primary, cappedConf);
    const alts = uniqueScored
      .filter((u) => u.entry.id !== primary.id)
      .slice(0, 5)
      .map((u) => toCandidateOption(u.entry, Math.min(88, Math.round(u.score * 100))));

    return {
      status: "ambiguous_review",
      best: bestOpt,
      alternatives: alts,
      ambiguityReason: `Found ${distinctLocalities.size} schools with similar names in different towns/provinces. Please confirm the exact municipality.`,
    };
  }

  const bestEntry = uniqueScored[0].entry;
  const conf = Math.round(topScore * 100);
  const bestOpt = toCandidateOption(bestEntry, conf);
  const alts = uniqueScored
    .slice(1, 5)
    .map((u) => toCandidateOption(u.entry, Math.round(u.score * 100)));

  // Require >= 92% multi-signal confidence for automatic selection
  if (conf >= 92) {
    return { status: "ready_high", best: bestOpt, alternatives: alts };
  }

  return { status: "suggested_review", best: bestOpt, alternatives: alts };
}

// In-flight deduplication lock so concurrent imports don't insert duplicate school rows
const inflightRegistrations = new Map<string, Promise<SchoolRegistry>>();

/**
 * Finds a school in the CAIR PH dataset and automatically registers it in `school_registry`
 * (and optionally records an alias if the student's raw text differed from the canonical name).
 */
export async function resolveAndRegisterFromCair(
  rawSchoolName: string,
  ctx?: CairLookupContext,
): Promise<SchoolRegistry | null> {
  const found = findSchoolInCairCatalog(rawSchoolName, ctx);
  if (!found) return null;

  const { entry } = found;
  const lockKey = entry.id || `${entry.normName}|${entry.normMuni}`;
  const pending = inflightRegistrations.get(lockKey);
  if (pending) return pending;

  const task = (async (): Promise<SchoolRegistry> => {
    const db = getDb();
    const existingList = await storage.listSchoolRegistry();

    // Reuse existing school if same schoolId or same normalized name + municipality already exists
    const existing = existingList.find(
      (s) =>
        !s.deletedAt &&
        ((entry.id && s.schoolId === entry.id) ||
          (normalizeSchoolName(s.schoolName) === entry.normName &&
            normalizeMunicipality(s.municipality) === entry.normMuni)),
    );

    let registered: SchoolRegistry;
    if (existing) {
      registered = existing;
    } else {
      const insertPayload: InsertSchoolRegistry = {
        schoolId: entry.id,
        schoolName: entry.n,
        normalizedSchoolName: entry.normName,
        schoolType: entry.t,
        sector: entry.s,
        barangay: entry.b || null,
        municipality: entry.m || entry.p || "Philippines",
        province: entry.p || entry.m || "Philippines",
        address: entry.a || null,
        latitude: entry.lat,
        longitude: entry.lng,
        source: "CAIR PH Unified Coordinates",
        isActive: true,
      };
      registered = await storage.createSchoolRegistry(insertPayload);
      enterpriseCache.invalidate("schools:");
      enterpriseCache.invalidate("gis:");
    }

    // Save alias if student wrote a shorthand/variant (e.g. "Binan Integrated" -> "Biñan Integrated National High School")
    const rawNorm = normalizeSchoolName(rawSchoolName);
    if (rawNorm && rawNorm !== entry.normName) {
      const existingAlias = await db
        .select()
        .from(schoolAliases)
        .where(eq(schoolAliases.normalizedAlias, rawNorm))
        .limit(1);
      if (existingAlias.length === 0) {
        await db
          .insert(schoolAliases)
          .values({
            schoolRegistryId: registered.id,
            aliasName: rawSchoolName.trim(),
            normalizedAlias: rawNorm,
          })
          .catch(() => {});
      }
    }

    return registered;
  })();

  inflightRegistrations.set(lockKey, task);
  try {
    return await task;
  } finally {
    inflightRegistrations.delete(lockKey);
  }
}

/**
 * Automatically checks any existing unmapped students in `students_processed`
 * against the existing registry + 25,562-school CAIR PH dataset and links them.
 */
export async function backfillUnmappedStudentsFromCair(): Promise<{
  checkedGroups: number;
  resolvedStudents: number;
}> {
  const db = getDb();
  const unmapped = await db
    .select()
    .from(studentsProcessed)
    .where(
      and(
        isNull(studentsProcessed.schoolRegistryId),
        ne(studentsProcessed.enrollmentStatus, "Archived"),
      ),
    );

  if (unmapped.length === 0) return { checkedGroups: 0, resolvedStudents: 0 };

  // Group unmapped students by (rawSchoolName + municipality) so each school is resolved only once
  const groups = new Map<string, typeof unmapped>();
  for (const s of unmapped) {
    const rawName = (s.previousSchool || s.lastSchoolName || "").trim();
    if (!rawName || rawName === "Unknown") continue;
    const key = `${rawName.toLowerCase()}|${(s.municipality || "").toLowerCase()}`;
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }

  let resolvedStudents = 0;
  for (const [, studentsInGroup] of Array.from(groups.entries())) {
    const sample = studentsInGroup[0];
    const rawName = (sample.previousSchool || sample.lastSchoolName || "").trim();
    const matched = await resolveAndRegisterFromCair(rawName, {
      municipality: sample.municipality,
      province: sample.province,
      studentType: sample.strand || sample.admissionType,
    });

    if (matched && hasCoordinates(matched)) {
      for (const st of studentsInGroup) {
        await db
          .update(studentsProcessed)
          .set({
            schoolRegistryId: matched.id,
            lastSchoolType: st.lastSchoolType || matched.schoolType || null,
            mappingStatus: "mapped",
          })
          .where(eq(studentsProcessed.id, st.id));
        resolvedStudents += 1;
      }
    }
  }

  if (resolvedStudents > 0) {
    enterpriseCache.invalidate("gis:");
    enterpriseCache.invalidate("schools:");
  }

  return { checkedGroups: groups.size, resolvedStudents };
}
