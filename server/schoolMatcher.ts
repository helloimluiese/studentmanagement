import Fuse from "fuse.js";
import { normalizeSchoolName } from "@shared/schoolRegistry";
import { cleanRawText, computeTypoSimilarity } from "@shared/textNormalization";
import { type SchoolRegistry, type SchoolAlias, schoolMatchHistory } from "@shared/schema";
import { getDb } from "./db";
import { eq } from "drizzle-orm";

export type MatchResult = {
  status: "matched" | "unmatched" | "suggested";
  school: SchoolRegistry | null;
  suggestions?: SchoolRegistry[];
  matchType?: "exact" | "alias" | "normalized" | "historical" | "address" | "municipality" | "province" | "program" | "fuzzy" | "acronym";
  confidence?: number;
};

export class SchoolMatchingEngine {
  private registry: SchoolRegistry[];
  private normalizedMap: Map<string, SchoolRegistry[]>;
  private aliasMap: Map<string, SchoolRegistry>;
  private acronymMap: Map<string, SchoolRegistry[]>;
  private fuse: Fuse<SchoolRegistry>;

  constructor(schools: SchoolRegistry[], aliases: SchoolAlias[]) {
    this.registry = schools;
    this.normalizedMap = new Map();
    this.aliasMap = new Map();
    this.acronymMap = new Map();

    for (const school of schools) {
      const key = normalizeSchoolName(school.schoolName);
      const candidates = this.normalizedMap.get(key) ?? [];
      candidates.push(school);
      this.normalizedMap.set(key, candidates);
      
      const acronyms = this.getAcronyms(school.schoolName, school.municipality);
      for (const acronym of acronyms) {
        if (!this.acronymMap.has(acronym)) {
          this.acronymMap.set(acronym, []);
        }
        // Avoid duplicate school entries for the same acronym
        if (!this.acronymMap.get(acronym)!.some(s => s.id === school.id)) {
          this.acronymMap.get(acronym)!.push(school);
        }
      }
    }

    const schoolsById = new Map(schools.map(school => [school.id, school]));
    for (const alias of aliases) {
      const school = schoolsById.get(alias.schoolRegistryId);
      if (school) {
        this.aliasMap.set(alias.normalizedAlias, school);
      }
    }

    this.fuse = new Fuse(schools, {
      keys: [
        { name: "schoolName", weight: 0.75 },
        { name: "normalizedSchoolName", weight: 0.2 },
      ],
      threshold: 0.4,
      includeScore: true,
      minMatchCharLength: 3,
    });
  }

  private matchName(rawName: string): MatchResult | undefined {
    const normalized = normalizeSchoolName(rawName);
    if (!normalized) return;
    const candidates = this.normalizedMap.get(normalized) ?? [];
    if (candidates.length > 1) {
      return { status: "suggested", school: null, suggestions: candidates };
    }
    const [school] = candidates;
    if (school) {
      const exact = school.schoolName.toLowerCase() === rawName.toLowerCase();
      return { status: "matched", school, matchType: exact ? "exact" : "normalized", confidence: exact ? 100 : 95 };
    }
    const alias = this.aliasMap.get(normalized);
    if (alias) return { status: "matched", school: alias, matchType: "alias", confidence: 95 };
  }

  /**
   * Return fuzzy suggestions from the internal Fuse index.
   * This keeps the Fuse usage encapsulated and avoids touching private fields from outside.
   */
  public suggestions(query: string, limit = 5): SchoolRegistry[] {
    if (!query) return [];
    const results = this.fuse.search(query, { limit });
    return results.map(r => r.item);
  }

  private getAcronyms(name: string, municipality?: string | null): string[] {
    const cleanName = name.replace(/\([^)]*\)/g, "").trim();
    const words = cleanName.split(/[\s-]+/).filter(Boolean);
    const ACRONYM_STOP_WORDS = new Set([
      "of", "the", "and", "in", "at", "for", "to", "on", "de", "del", "dela", "la",
      "ng", "sa", "inc", "incorporated", "corp", "corporation",
    ]);
    const BRANCH_WORDS = new Set(["campus", "branch", "main", "annex", "extension", "standalone"]);

    const getAcr = (wordList: string[]) =>
      wordList
        .map((w) => {
          const m = w.match(/^[A-Za-z]/);
          return m ? m[0].toUpperCase() : "";
        })
        .join("");

    // 1. All words (legacy)
    const fullAcronym = getAcr(words);

    // 2. Skip connector stop-words ("University of Perpetual Help System" -> "UPHS", "Polytechnic University of the Philippines" -> "PUP")
    const noStopWords = words.filter((w) => !ACRONYM_STOP_WORDS.has(w.toLowerCase()));
    const stopSkippedAcronym = getAcr(noStopWords);

    // 3. Skip connector stop-words AND branch/municipality words
    const muniWords = new Set(
      (municipality || "")
        .toLowerCase()
        .split(/[\s-]+/)
        .filter((w) => w.length >= 3),
    );
    const coreInstitutionWords = noStopWords.filter((w) => {
      const lower = w.toLowerCase();
      return !BRANCH_WORDS.has(lower) && !muniWords.has(lower);
    });
    const coreAcronym = getAcr(coreInstitutionWords);

    return Array.from(new Set([fullAcronym, stopSkippedAcronym, coreAcronym])).filter(
      (a) => a.length >= 2,
    );
  }

  public async matchAsync(rawName: string, metadata?: { address?: string; municipality?: string; province?: string; program?: string }): Promise<MatchResult> {
    if (!rawName) return { status: "unmatched", school: null };

    const nameMatch = this.matchName(rawName);
    if (nameMatch) return nameMatch;

    // 4. Acronym Match (70-90%)
    // Allow inputs like "CGC Binan" or "CGC - Binan"
    const parts = rawName.split(/[\s-]+/);
    const potentialAcronym = parts[0].toUpperCase().replace(/[^A-Z]/g, '');
    const potentialBranch = parts.slice(1).join(' ').trim().toLowerCase();

    // Also consider the entire string as a potential acronym
    const fullAcronym = rawName.toUpperCase().replace(/[^A-Z]/g, '');
    
    // We only try acronym matching if the potential acronym or full acronym looks like one (2-10 chars)
    const validPotentialAcronym = potentialAcronym.length >= 2 && potentialAcronym.length <= 10;
    const validFullAcronym = fullAcronym.length >= 2 && fullAcronym.length <= 10 && rawName.length <= 15;

    if (validPotentialAcronym || validFullAcronym) {
      let matchedSchools: SchoolRegistry[] = [];
      let usedBranch = false;
      
      if (validPotentialAcronym) {
        const matches = this.acronymMap.get(potentialAcronym) || [];
        // If there's a branch part, prioritize schools that match the branch
        if (potentialBranch && matches.length > 0) {
           const branchMatches = matches.filter(s => {
             const muni = s.municipality?.toLowerCase() || "";
             const name = s.schoolName.toLowerCase();
             return (muni && (muni.includes(potentialBranch) || potentialBranch.includes(muni))) || name.includes(potentialBranch);
           });
           if (branchMatches.length > 0) {
             matchedSchools = branchMatches;
             usedBranch = true;
           } else {
             // We had a branch but it didn't match. We can still consider the acronym matches.
             matchedSchools = matches;
           }
        } else if (matches.length > 0) {
           matchedSchools = matches;
        }
      }
      
      if (matchedSchools.length === 0 && validFullAcronym) {
        matchedSchools = this.acronymMap.get(fullAcronym) || [];
        usedBranch = false;
      }
      
      // If we didn't match the branch but the user provided a long branch name, this is likely a false positive acronym match
      if (matchedSchools.length > 0 && !usedBranch && potentialBranch && potentialBranch.length > 5 && !validFullAcronym) {
        matchedSchools = [];
      }

      if (matchedSchools.length > 0) {
        let confidence = usedBranch ? 90 : 85;
        let matchedSchool = matchedSchools[0];
        
        if (matchedSchools.length > 1) {
           confidence = 70; // lower confidence for collision
           
           if (metadata?.municipality) {
             const byMuni = matchedSchools.filter(s => s.municipality?.toLowerCase() === metadata.municipality?.toLowerCase());
             if (byMuni.length === 1) {
               matchedSchool = byMuni[0];
               confidence = usedBranch ? 90 : 85; // restored confidence
             } else if (byMuni.length > 1) {
                return { status: "suggested", school: null, suggestions: byMuni, confidence };
             } else {
               return { status: "suggested", school: null, suggestions: matchedSchools, confidence };
             }
           } else {
             return { status: "suggested", school: null, suggestions: matchedSchools, confidence };
           }
        }
        
        return { status: "matched", school: matchedSchool, matchType: "acronym", confidence };
      }
    }

    // 7. Historical Match (40% - boosted if multiple occurrences)
    const db = getDb();
    const historyResult = await db.select().from(schoolMatchHistory).where(eq(schoolMatchHistory.importedName, rawName)).limit(1);
    if (historyResult.length > 0 && historyResult[0].officialSchoolId) {
      const histSchool = this.registry.find(s => s.id === historyResult[0].officialSchoolId);
      if (histSchool) {
        const confidence = Math.min(40 + (historyResult[0].occurrences * 5), 85);
        return { status: "matched", school: histSchool, matchType: "historical", confidence };
      }
    }

    const ranked = this.rankFuzzy(rawName);
    const [best, runnerUp] = ranked;
    if (best && best.score >= 0.8 && best.score - (runnerUp?.score ?? 0) >= 0.05) {
      return { status: "matched", school: best.school, matchType: "fuzzy", confidence: Math.round(best.score * 100) };
    }
    if (best) {
      return { status: "suggested", school: null, suggestions: ranked.slice(0, 3).map(result => result.school) };
    }

    // 11. Unmatched
    return { status: "unmatched", school: null };
  }

  // Legacy synchronous wrapper for existing code, degrades pg_trgm to just fuse.js
  public match(rawName: string): MatchResult {
    if (!rawName.trim()) return { status: "unmatched", school: null };
    const nameMatch = this.matchName(rawName);
    if (nameMatch) return nameMatch;

    // 4. Acronym Match (70-90%)
    const parts = rawName.split(/[\s-]+/);
    const potentialAcronym = parts[0].toUpperCase().replace(/[^A-Z]/g, '');
    const potentialBranch = parts.slice(1).join(' ').trim().toLowerCase();
    const fullAcronym = rawName.toUpperCase().replace(/[^A-Z]/g, '');

    const validPotentialAcronym = potentialAcronym.length >= 2 && potentialAcronym.length <= 10;
    const validFullAcronym = fullAcronym.length >= 2 && fullAcronym.length <= 10 && rawName.length <= 15;

    if (validPotentialAcronym || validFullAcronym) {
      let matchedSchools: SchoolRegistry[] = [];
      let usedBranch = false;
      
      if (validPotentialAcronym) {
        const matches = this.acronymMap.get(potentialAcronym) || [];
        if (potentialBranch && matches.length > 0) {
           const branchMatches = matches.filter(s => {
             const muni = s.municipality?.toLowerCase() || "";
             const name = s.schoolName.toLowerCase();
             return (muni && (muni.includes(potentialBranch) || potentialBranch.includes(muni))) || name.includes(potentialBranch);
           });
           if (branchMatches.length > 0) {
             matchedSchools = branchMatches;
             usedBranch = true;
           } else {
             matchedSchools = matches;
           }
        } else if (matches.length > 0) {
           matchedSchools = matches;
        }
      }
      
      if (matchedSchools.length === 0 && validFullAcronym) {
        matchedSchools = this.acronymMap.get(fullAcronym) || [];
      }

      if (matchedSchools.length > 0) {
        if (matchedSchools.length === 1) {
          return { status: "matched", school: matchedSchools[0], matchType: "acronym", confidence: usedBranch ? 90 : 85 };
        } else {
          return { status: "suggested", school: null, suggestions: matchedSchools, confidence: 70 };
        }
      }
    }

    const ranked = this.rankFuzzy(rawName);
    const [best, runnerUp] = ranked;
    if (best && best.score >= 0.8 && best.score - (runnerUp?.score ?? 0) >= 0.05) {
      return { status: "matched", school: best.school, matchType: "fuzzy", confidence: Math.round(best.score * 100) };
    }
    if (best) return { status: "suggested", school: null, suggestions: ranked.slice(0, 3).map(result => result.school) };
    return { status: "unmatched", school: null };
  }

  private rankFuzzy(rawName: string): Array<{ school: SchoolRegistry; score: number }> {
    const cleanedQuery = cleanRawText(rawName);
    const normalized = normalizeSchoolName(rawName);
    const scores = new Map(this.fuse.search(cleanedQuery || rawName)
      .map(result => [result.item.id, 1 - (result.score ?? 1)]));
    return this.registry.map(school => {
      let score = scores.get(school.id) ?? 0;
      if (normalized.length >= 4) {
        score = Math.max(score,
          computeTypoSimilarity(normalized, normalizeSchoolName(school.schoolName)),
          computeTypoSimilarity(cleanedQuery || rawName, school.schoolName),
        );
      }
      return { school, score };
    }).filter(result => result.score >= 0.6).sort((a, b) => b.score - a.score);
  }
}
