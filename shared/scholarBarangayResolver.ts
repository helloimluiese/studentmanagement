import { normalizeMunicipality } from "./schoolRegistry";
import { cleanRawText, damerauLevenshtein, phPhoneticKey, stringSimilarity } from "./textNormalization";

/**
 * Scholar Barangay & Catchment Intelligence Resolver
 *
 * Pre-indexes PSGC barangays via WeakMap so resolving hundreds of scholars
 * runs in <1ms total on the main browser thread without UI stutter.
 */

export interface ResolvedBarangayLocation {
  barangayName: string;
  municipality: string;
  province: string;
  latitude: number | null;
  longitude: number | null;
  key: string;
  isSpecialOrUnmapped?: boolean;
}

export interface MinimalScholarRecord {
  barangay?: string | null;
  municipality?: string | null;
  province?: string | null;
  iskolarNiKap?: string | null;
  address?: string | null;
}

export const BORDER_CATCHMENT_BARANGAYS = [
  {
    province: "Cavite",
    municipality: "Carmona",
    barangayName: "Cabilang Baybay",
    normalizedName: "cabilang baybay",
    latitude: 14.3090,
    longitude: 121.0494,
  },
  {
    province: "Cavite",
    municipality: "Carmona",
    barangayName: "Maduya",
    normalizedName: "maduya",
    latitude: 14.3195,
    longitude: 121.0543,
  },
];

interface PreparedBarangay {
  barangayName: string;
  municipality: string;
  province: string;
  latitude: number | null;
  longitude: number | null;
  key: string;
  clean: string;
  padded: string;
  phon: string;
  wordCount: number;
  locality: string;
}

interface BarangayIndex {
  prepared: PreparedBarangay[];
  localities: Set<string>;
  resultCache: Map<string, ResolvedBarangayLocation | null>;
}

const indexCache = new WeakMap<any[], BarangayIndex>();

export function isBarangayScholar(value: string | null | undefined): boolean {
  return Boolean(value?.trim() && !/^(no|false|0|null|undefined|none|n\/?a)$/i.test(value.trim()));
}

export function cleanBarangayText(str: string): string {
  if (!str) return "";
  return cleanRawText(str)
    .toLowerCase()
    .replace(/\bsto\b/g, "santo")
    .replace(/\bsta\b/g, "santa")
    .replace(/\bst\b/g, "saint")
    .replace(/\bbrgy\b/g, "barangay")
    .replace(/\bbgy\b/g, "barangay")
    .replace(/\bdelapaz\b/g, "de la paz")
    .replace(/\bdela\s+paz\b/g, "de la paz")
    .replace(/\blangkwia\b/g, "langkiwa")
    .replace(/\bmlausak\b/g, "malusak")
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalBarangayName(name: string, municipality: string): string {
  const barangay = cleanBarangayText(name);
  const locality = normalizeMunicipality(municipality);
  if (locality === "liliw" && barangay === "cabuyao") return "cabuyew";
  if (locality === "santa rosa" && barangay === "pook") return "pooc";
  return barangay;
}

function getOrBuildIndex(dbBarangays: any[]): BarangayIndex {
  const existing = indexCache.get(dbBarangays);
  if (existing) return existing;

  const allBarangays = [...dbBarangays];
  for (const b of BORDER_CATCHMENT_BARANGAYS) {
    if (!allBarangays.some((ex) => ex.barangayName?.toLowerCase() === b.barangayName.toLowerCase() && normalizeMunicipality(ex.municipality) === normalizeMunicipality(b.municipality))) {
      allBarangays.push(b);
    }
  }

  const prepared: PreparedBarangay[] = [];
  for (const b of allBarangays) {
    if (!b?.barangayName || b.isActive === false) continue;
    const clean = cleanBarangayText(b.barangayName);
    if (clean.length < 3) continue;
    const mun = b.municipality || "Laguna";
    const munLower = mun.toLowerCase();
    prepared.push({
      barangayName: b.barangayName,
      municipality: mun,
      province: b.province || "Laguna",
      latitude: b.latitude ? Number(b.latitude) : null,
      longitude: b.longitude ? Number(b.longitude) : null,
      key: `${munLower}__${b.barangayName.toLowerCase()}`,
      clean,
      padded: ` ${clean} `,
      phon: phPhoneticKey(clean),
      wordCount: clean.split(" ").length,
      locality: normalizeMunicipality(mun),
    });
  }

  const idx = {
    prepared,
    localities: new Set(prepared.map(barangay => barangay.locality)),
    resultCache: new Map<string, ResolvedBarangayLocation | null>(),
  };
  indexCache.set(dbBarangays, idx);
  return idx;
}

export function resolveScholarBarangay(
  student: MinimalScholarRecord,
  dbBarangays: any[] = [],
): ResolvedBarangayLocation | null {
  const location = [student.barangay, student.address, student.iskolarNiKap]
    .map(value => cleanBarangayText(value ?? ""))
    .filter(value => value && !/^(yes|no|true|false|none|null|undefined|n a|[01])$/.test(value));
  if (!location.length) return null;

  const index = getOrBuildIndex(dbBarangays);
  const cacheKey = JSON.stringify([student.municipality, student.province, student.barangay, student.address, student.iskolarNiKap]);
  if (index.resultCache.has(cacheKey)) return index.resultCache.get(cacheKey) ?? null;

  const remember = (barangay?: PreparedBarangay) => {
    const result = barangay ? {
      barangayName: barangay.barangayName,
      municipality: barangay.municipality,
      province: barangay.province,
      latitude: barangay.latitude,
      longitude: barangay.longitude,
      key: barangay.key,
    } : null;
    index.resultCache.set(cacheKey, result);
    return result;
  };

  let locality = normalizeMunicipality(student.municipality);
  if (locality === "laguna") locality = "";
  if (!locality && student.address) {
    const addressSegments = student.address.split(",").map(normalizeMunicipality);
    const address = ` ${normalizeMunicipality(student.address)} `;
    const localities = Array.from(index.localities);
    const named = localities.filter(name => addressSegments.includes(name));
    const mentioned = named.length ? named : localities
      .filter(name => name !== "bay" && name.length > 3 && address.endsWith(` ${name} `));
    if (mentioned.length === 1) locality = mentioned[0];
  }

  const province = cleanBarangayText(student.province ?? "");
  const candidates = index.prepared.filter(barangay =>
    (!locality || barangay.locality === locality) &&
    (!province || cleanBarangayText(barangay.province) === province));
  if (!candidates.length) return remember();

  const explicitBarangay = canonicalBarangayName(student.barangay ?? "", locality);
  const inputs = explicitBarangay ? [explicitBarangay] : location.map(text => {
    return locality && text.endsWith(` ${locality}`) ? text.slice(0, -locality.length).trim() : text;
  });
  for (const input of inputs) {
    const padded = ` ${input} `;
    const exact = candidates.filter(barangay => explicitBarangay
      ? input === barangay.clean || input.replace(/^barangay /, "") === barangay.clean
      : padded.includes(barangay.padded));
    const strongest = exact.filter(barangay => !exact.some(other =>
      other.clean !== barangay.clean && other.padded.includes(barangay.padded)));
    const places = new Map(strongest.map(barangay => [barangay.key, barangay]));
    if (places.size) return remember(places.size === 1 ? places.values().next().value : undefined);
  }

  const words = inputs.join(" ").split(" ").filter(word => word.length >= 2 && word !== "barangay");
  const ngrams: Array<{ text: string; phon: string; wordCount: number }> = [];
  for (let i = 0; i < words.length; i++) {
    const w1 = words[i];
    if (w1.length >= 4) ngrams.push({ text: w1, phon: phPhoneticKey(w1), wordCount: 1 });
    if (i + 1 < words.length) {
      const w2 = `${w1} ${words[i + 1]}`;
      ngrams.push({ text: w2, phon: phPhoneticKey(w2), wordCount: 2 });
    }
    if (i + 2 < words.length) {
      const w3 = `${w1} ${words[i + 1]} ${words[i + 2]}`;
      ngrams.push({ text: w3, phon: phPhoneticKey(w3), wordCount: 3 });
    }
  }

  const scores = new Map<string, { barangay: PreparedBarangay; score: number }>();

  for (const b of candidates) {
    if (b.clean.length < 4) continue;
    const allowedMaxEdits = b.clean.length <= 6 ? 1 : 2;

    for (const gram of ngrams) {
      if (Math.abs(gram.wordCount - b.wordCount) > 1) continue;
      // Fast length difference prune before running Damerau-Levenshtein
      if (Math.abs(gram.text.length - b.clean.length) > 3) continue;

      const dist = damerauLevenshtein(gram.text, b.clean);
      const sim = stringSimilarity(gram.text, b.clean);
      const phonSim = b.phon && gram.phon ? stringSimilarity(gram.phon, b.phon) : 0;

      const effectiveScore =
        phonSim === 1 && sim >= 0.72
          ? Math.max(sim, 0.92)
          : Math.max(sim, sim * 0.65 + phonSim * 0.35);

      const isSafeMatch = (dist <= allowedMaxEdits && effectiveScore >= 0.8) || effectiveScore >= 0.88;
      if (isSafeMatch) {
        if (effectiveScore > (scores.get(b.key)?.score ?? 0)) {
          scores.set(b.key, { barangay: b, score: effectiveScore });
        }
      }
    }
  }

  const [best, runnerUp] = Array.from(scores.values()).sort((a, b) => b.score - a.score);
  return remember(best && best.score - (runnerUp?.score ?? 0) >= 0.05 ? best.barangay : undefined);
}
