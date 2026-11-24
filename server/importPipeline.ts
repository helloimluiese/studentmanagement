import { getDb } from "./db";
import { barangayRegistry, studentsProcessed } from "@shared/schema";
import { loadSchoolMatcher } from "./geocodeLookup";
import { hasCoordinates } from "@shared/schoolRegistry";
import { isBarangayScholar, resolveScholarBarangay } from "@shared/scholarBarangayResolver";
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
      } else {
        record.admissionType = "Freshman";
      }

      const matchResult = await matcher.matchAsync(record.previousSchool || "");
      const scholarLocation = isBarangayScholar(record.scholarship)
        ? resolveScholarBarangay({ ...record, iskolarNiKap: record.scholarship }, barangays)
        : null;
      
      const status = matchResult.status === "matched" ? "Matched" : 
                    matchResult.status === "suggested" ? "Unmatched" : "Unmatched";

      const rawNo = record.studentNumber ? String(record.studentNumber).trim() : "";
      const studentNo = rawNo || "N/A";
      const rawName = record.fullName ? String(record.fullName).trim() : "Unknown";

      let existing: any[] = [];
      if (rawNo && rawNo !== "N/A") {
        existing = await db.select().from(studentsProcessed).where(eq(studentsProcessed.studentNumber, rawNo)).limit(1);
      }

      const studentData = {
        studentNumber: studentNo,
        fullName: record.fullName || "Unknown",
        lastSchoolName: record.previousSchool || "Unknown",
        previousSchool: record.previousSchool || null,
        strand: record.strand || null,
        admissionType: record.admissionType,
        course: record.program || null,
        iskolarNiKap: record.scholarship || null,
        municipality: scholarLocation?.municipality ?? (record.municipality || "Laguna"),
        province: scholarLocation?.province ?? (record.province || null),
        barangay: scholarLocation?.barangayName ?? (record.barangay || null),
        importedSource: record.importSource || "Google Sheets Auto-Sync",
        mappingStatus: matchResult.school && hasCoordinates(matchResult.school) ? "mapped" : "needs_review",
        schoolRegistryId: matchResult.school?.id || null,
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
}
