import { getDb } from "./db";
import { barangayRegistry, studentsProcessed } from "@shared/schema";
import { loadSchoolMatcher } from "./geocodeLookup";
import { hasCoordinates } from "@shared/schoolRegistry";
import { isBarangayScholar, resolveScholarBarangay } from "@shared/scholarBarangayResolver";
import { resolveAndRegisterFromCair } from "./cairCatalog";
import { enterpriseCache } from "./cache";
import { eq } from "drizzle-orm";

interface ImportProgress {
  total: number;
  processed: number;
  matched: number;
  unmatched: number;
  errors: number;
  percentage: number;
  isProcessing: boolean;
}

let currentProgress: ImportProgress = {
  total: 0,
  processed: 0,
  matched: 0,
  unmatched: 0,
  errors: 0,
  percentage: 0,
  isProcessing: false,
};

// Start a new import session
export function startImportSession(totalRecords: number) {
  currentProgress = {
    total: totalRecords,
    processed: 0,
    matched: 0,
    unmatched: 0,
    errors: 0,
    percentage: 0,
    isProcessing: true,
  };
}

export function getImportProgress(): ImportProgress {
  return currentProgress;
}

export function endImportSession() {
  currentProgress.isProcessing = false;
  currentProgress.percentage = 100;
}

export async function processBatch(records: any[]) {
  if (!currentProgress.isProcessing) return;

  const db = getDb();
  const [matcher, barangays] = await Promise.all([
    loadSchoolMatcher(),
    db.select().from(barangayRegistry),
  ]);
  const cairBatchCache = new Map<string, any>();

  for (const record of records) {
    try {
      // Returnee Heuristic
      const prevSchoolUpper = (record.previousSchool || "").toUpperCase();
      const strandUpper = (record.strand || "").toUpperCase();

      if (
        strandUpper.includes("RETURNEE") ||
        prevSchoolUpper.includes("RETURNEE") ||
        (prevSchoolUpper.includes("TRIMEX") && strandUpper.includes("2ND COURSER")) ||
        (prevSchoolUpper.includes("TRIMEX") && strandUpper.includes("2ND-COURSER"))
      ) {
        record.previousSchool = "Trimex Colleges";
        record.admissionType = "Returnee";
      } else if (strandUpper.includes("TRANSFEREE") || strandUpper.includes("2ND COURSER") || strandUpper.includes("2ND-COURSER")) {
        record.admissionType = "Transferee";
      } else {
        record.admissionType = "Freshman";
      }

      const rawPrevSchool = (record.previousSchool || "").trim();
      const matchResult = await matcher.matchAsync(rawPrevSchool, {
        address: record.address,
        municipality: record.municipality,
        province: record.province,
        program: record.program,
      });

      let matchedSchool = matchResult.school;

      // Fallback to 25,562-school CAIR PH Unified Coordinates dataset before marking Unmatched
      if (!matchedSchool && rawPrevSchool) {
        const cacheKey = `${rawPrevSchool.toLowerCase()}|${(record.municipality || "").toLowerCase()}|${(record.address || "").toLowerCase()}`;
        if (cairBatchCache.has(cacheKey)) {
          matchedSchool = cairBatchCache.get(cacheKey);
        } else {
          matchedSchool = await resolveAndRegisterFromCair(rawPrevSchool, {
            address: record.address,
            municipality: record.municipality,
            province: record.province,
            studentType: record.strand || record.admissionType,
          });
          cairBatchCache.set(cacheKey, matchedSchool);
        }
      }

      const scholarLocation = isBarangayScholar(record.scholarship)
        ? resolveScholarBarangay({ ...record, iskolarNiKap: record.scholarship }, barangays)
        : null;
      
      const status = matchedSchool ? "Matched" : "Unmatched";

      const rawNo = record.studentNumber ? String(record.studentNumber).trim() : "";
      const studentNo = rawNo || "N/A";

      let existing: any[] = [];
      if (rawNo && rawNo !== "N/A") {
        existing = await db.select().from(studentsProcessed).where(eq(studentsProcessed.studentNumber, rawNo)).limit(1);
      }

      const studentData = {
        studentNumber: studentNo,
        fullName: record.fullName || "Unknown",
        lastSchoolName: rawPrevSchool || "Unknown",
        previousSchool: rawPrevSchool || null,
        lastSchoolType: matchedSchool?.schoolType || null,
        strand: record.strand || null,
        admissionType: record.admissionType,
        course: record.program || null,
        iskolarNiKap: record.scholarship || null,
        municipality: scholarLocation?.municipality ?? (matchedSchool?.municipality || record.municipality || "Laguna"),
        province: scholarLocation?.province ?? (matchedSchool?.province || record.province || null),
        barangay: scholarLocation?.barangayName ?? (record.barangay || null),
        schedule: record.schedule || null,
        contactNumber: record.contactNumber || null,
        requirements: record.requirements || null,
        importedSource: record.importSource || "Google Sheets Auto-Sync",
        mappingStatus: matchedSchool && hasCoordinates(matchedSchool) ? "mapped" : "needs_review",
        schoolRegistryId: matchedSchool?.id || null,
        enrollmentStatus: record.enrollmentStatus || "Active",
      };

      if (existing.length > 0) {
        await db.update(studentsProcessed).set(studentData).where(eq(studentsProcessed.id, existing[0].id));
      } else {
        await db.insert(studentsProcessed).values(studentData);
      }

      currentProgress.processed++;
      if (status === "Matched") currentProgress.matched++;
      else currentProgress.unmatched++;
      
    } catch (e) {
      console.error("[importPipeline] Error processing record:", e);
      currentProgress.processed++;
      currentProgress.errors++;
    }
  }

  currentProgress.percentage = Math.round((currentProgress.processed / currentProgress.total) * 100);
  
  if (currentProgress.processed >= currentProgress.total) {
    currentProgress.isProcessing = false;
  }
  enterpriseCache.invalidate("gis:");
  enterpriseCache.invalidate("schools:");
}
