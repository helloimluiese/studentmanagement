import { storage } from "./storage";
import { schoolAliases, type SchoolRegistry } from "@shared/schema";
import { hasCoordinates, normalizeMunicipality, normalizeSchoolName } from "@shared/schoolRegistry";
import { cleanBarangayText } from "@shared/scholarBarangayResolver";
import type { GeocodeSchoolResponse } from "@shared/routes";
import { getDb } from "./db";
import { SchoolMatchingEngine } from "./schoolMatcher";
import { eq } from "drizzle-orm";

export function isSchoolDirectoryEntry(school: SchoolRegistry): boolean {
  return school.schoolType?.toLowerCase() !== "barangay" && !school.deletedAt;
}

export async function loadSchoolMatcher(municipality?: string): Promise<SchoolMatchingEngine> {
  const locality = normalizeMunicipality(municipality);
  const [schools, aliases] = await Promise.all([
    storage.listSchoolRegistry(),
    getDb().select().from(schoolAliases),
  ]);
  return new SchoolMatchingEngine(schools.filter(school =>
    isSchoolDirectoryEntry(school) && school.isActive &&
    (!locality || locality === "laguna" || normalizeMunicipality(school.municipality) === locality),
  ), aliases);
}

export async function lookupSchoolInRegistry(schoolName: string): Promise<{
  school: SchoolRegistry;
  source: "registry" | "alias";
} | null> {
  const normalized = normalizeSchoolName(schoolName);
  if (!normalized) return null;
  const schools = (await storage.listSchoolRegistry()).filter(school =>
    isSchoolDirectoryEntry(school) && school.isActive);
  const matches = schools.filter(school => normalizeSchoolName(school.schoolName) === normalized);
  if (matches.length > 1) return null;
  if (matches.length === 1) return { school: matches[0], source: "registry" };

  const [alias] = await getDb().select().from(schoolAliases)
    .where(eq(schoolAliases.normalizedAlias, normalized)).limit(1);
  const school = schools.find(candidate => candidate.id === alias?.schoolRegistryId);
  return school ? { school, source: "alias" } : null;
}

interface GoogleGeocodeResult {
  types?: string[];
  partial_match?: boolean;
  formatted_address?: string;
  address_components?: { types: string[]; short_name: string; long_name: string }[];
  geometry?: { location?: { lat: number; lng: number } };
}

async function searchGoogle(address: string): Promise<GoogleGeocodeResult[]> {
  const key = process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY;
  if (!key) return [];
  const params = new URLSearchParams({ address, components: "country:PH", key });
  try {
    const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return [];
    const data: { status: string; results?: GoogleGeocodeResult[] } = await response.json();
    return data.status === "OK" ? (data.results ?? []).filter(result =>
      !result.partial_match && result.address_components?.some(component =>
        component.types.includes("country") && component.short_name === "PH") &&
      Number.isFinite(result.geometry?.location?.lat) && Number.isFinite(result.geometry?.location?.lng),
    ) : [];
  } catch {
    console.warn("[geocode] Google geocoding request failed");
    return [];
  }
}

export async function geocodeBarangay(
  barangay: { barangayName: string; municipality: string; province: string },
): Promise<{ latitude: number; longitude: number } | null> {
  const { barangayName, municipality, province } = barangay;
  const results = await searchGoogle(`Barangay ${barangayName}, ${municipality}, ${province}, Philippines`);
  const matches = results.filter(result => {
    const components = result.address_components ?? [];
    const nameMatches = components.some(component =>
      component.types.some(type => /^(sublocality|neighborhood|administrative_area_level_5)/.test(type)) &&
      cleanBarangayText(component.long_name).replace(/^barangay /, "") === cleanBarangayText(barangayName));
    return nameMatches && components.some(component =>
      component.types.some(type => ["locality", "administrative_area_level_3"].includes(type)) &&
      normalizeMunicipality(component.long_name) === normalizeMunicipality(municipality)) &&
      components.some(component => component.types.includes("administrative_area_level_2") &&
        normalizeMunicipality(component.long_name) === normalizeMunicipality(province));
  });
  if (matches.length !== 1) return null;
  const location = matches[0].geometry!.location!;
  return { latitude: location.lat, longitude: location.lng };
}

export async function geocodeSchoolPreview(
  schoolName: string,
  municipality?: string,
): Promise<GeocodeSchoolResponse | null> {
  const trimmed = schoolName.trim();
  if (trimmed.length < 2) return null;

  const match = (await loadSchoolMatcher(municipality)).match(trimmed);
  if (match.school && hasCoordinates(match.school)) {
    const source = match.matchType === "alias" ? "alias"
      : match.matchType === "exact" || match.matchType === "normalized" ? "registry" : "master-directory";
    return {
      latitude: match.school.latitude!,
      longitude: match.school.longitude!,
      displayName: match.school.schoolName,
      source,
      schoolId: match.school.id,
      reused: true,
    };
  }

  if (match.status === "suggested") return null;
  const officialName = match.school?.schoolName ?? trimmed;
  const queryName = normalizeSchoolName(officialName);
  const locality = normalizeMunicipality(municipality);
  const results = await searchGoogle([officialName, municipality, "Philippines"].filter(Boolean).join(", "));
  const matches = results.filter(result =>
    result.types?.some(type => ["school", "primary_school", "secondary_school", "university", "establishment", "point_of_interest"].includes(type)) &&
    Boolean(queryName) && normalizeSchoolName(result.formatted_address?.split(",")[0] ?? "") === queryName &&
    (!locality || result.address_components?.some(component => component.types.some(type =>
      ["locality", "administrative_area_level_2", "administrative_area_level_3"].includes(type)) &&
      normalizeMunicipality(component.long_name) === locality)),
  );
  if (matches.length !== 1) return null;
  const [result] = matches;
  const location = result.geometry!.location!;
  return {
    latitude: location.lat,
    longitude: location.lng,
    displayName: result.formatted_address ?? officialName,
    source: "Google Maps",
    reused: false,
  };
}
