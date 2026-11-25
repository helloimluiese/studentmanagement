import type { Express } from "express";
import type { Server } from "http";
import { getDb } from "./db";
import { storage } from "./storage";
import { detectLocationMismatch, isAmbiguousSchoolName, extractLocationHintsFromName, buildSmartGeocodeQuery } from "@shared/locationIntelligence";
import { api } from "@shared/routes";
import {
  imports,
  mappingLogs,
  schoolAliases,
  schoolRegistry as schoolsTable,
  studentsProcessed,
  studentsRaw,
  studentImports,
  systemSettings,
  departments,
  programs,
  schoolMatchHistory,
  schoolRegistry,
  students,
  referrals,
  publicReferrals,
  insertPublicReferralSchema,
  users,
  barangayRegistry,
} from "@shared/schema";
import { eq, and, avg, count, desc, inArray, not, isNull, ne, or } from "drizzle-orm";
import { isAdmin, hashPassword, comparePasswords } from "./auth";
import { authLimiter, uploadLimiter, writeLimiter, publicApiLimiter } from "./security";
import { logAuditEvent } from "./auditLogger";
import { enterpriseCache } from "./cache";
import { enterpriseQueue } from "./queue";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { hasCoordinates, normalizeMunicipality, normalizeSchoolName } from "@shared/schoolRegistry";
import { SchoolMatchingEngine } from "./schoolMatcher";
import { analyzeCairCandidates } from "./cairCatalog";
import { z } from "zod";
import { previewIntegrationSource } from "./integrationService";
import {
  getGisOverviewStats,
  getImportLogs,
  getMappingQueue,
  getProcessedStudents,
  recomputeSchoolStudentCounts,
  searchSchools,
  syncStudents,
  updateProcessedStudent,
  batchUpdateProcessedStudentStatus,
  verifySchoolMapping,
  getGisMapData,
} from "./gisPipeline";
import {
  geocodeSchoolPreview,
  geocodeBarangay,
  isSchoolDirectoryEntry,
  lookupSchoolInRegistry,
} from "./geocodeLookup";
import multer from "multer";
import { syncExcelToJSON } from "./syncMasterDirectory";
import { startImportSession, getImportProgress, processBatch } from "./importPipeline";
import { seedPrograms } from "./seed";
import { setDynamicCatalog } from "@shared/programIntelligence";

async function refreshCatalog() {
  enterpriseCache.invalidate("departments:");
  enterpriseCache.invalidate("programs:");
  const db = getDb();
  const dbPrograms = await db.select().from(programs);
  const deptRecords = await db.select().from(departments);
  const deptMap = new Map(deptRecords.map(d => [d.id, d]));

  const formatted = dbPrograms.map(p => {
    const dept = deptMap.get(p.departmentId);
    return {
      ...p,
      code: p.code,
      college: dept?.code || "Unknown",
      collegeName: dept?.name || "Unknown",
      department: dept?.code || "Unknown",
      departmentName: dept?.name || "Unknown",
      program: p.name,
      track: p.track || "General",
      level: p.level,
      color: p.color,
      departmentColor: dept?.color || "#e5e7eb"
    };
  });
  setDynamicCatalog(formatted as any);
}

const ALLOWED_UPLOAD_EXTENSIONS = new Set([".xlsx", ".xls", ".csv"]);
const ALLOWED_UPLOAD_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
  "application/csv",
  "text/plain",
  "application/octet-stream",
]);

const upload = multer({
  dest: "server/uploads/",
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB max
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
      return cb(new Error("Invalid file type. Only .xlsx, .xls, and .csv files are allowed."));
    }
    if (file.mimetype && !ALLOWED_UPLOAD_MIMES.has(file.mimetype)) {
      return cb(new Error("Unsupported file MIME type."));
    }
    cb(null, true);
  },
});

const SENSITIVE_SETTING_KEY_PATTERN = /(token|secret|password|apikey|api_key|private_key)/i;

function parsePositiveIntId(raw: string | string[] | undefined): number | null {
  const val = Array.isArray(raw) ? raw[0] : raw;
  if (!val) return null;
  const n = Number(val);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const createUserBodySchema = z.object({
  username: z.string().trim().min(3, "Username must be at least 3 characters").max(64).regex(/^[a-zA-Z0-9._-]+$/, "Username may only contain letters, numbers, dots, underscores, and hyphens"),
  password: z.string().min(8, "Password must be at least 8 characters").max(256),
  role: z.enum(["admin", "user"]).default("user"),
  isActive: z.boolean().optional().default(true),
});

const updateUserBodySchema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters").max(256).optional(),
  role: z.enum(["admin", "user"]).optional(),
  isActive: z.boolean().optional(),
});

const barangayCreateSchema = z.object({
  province: z.string().trim().min(1).max(255).default("Laguna"),
  municipality: z.string().trim().min(1, "Municipality is required").max(255),
  barangayName: z.string().trim().min(1, "Barangay name is required").max(255),
  normalizedName: z.string().trim().max(255).optional().default(""),
  latitude: z.coerce.number().min(-90).max(90).nullable().optional(),
  longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
  isActive: z.boolean().optional().default(true),
});

const barangayPatchSchema = barangayCreateSchema.partial();

const departmentUpsertSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  code: z.string().trim().min(1, "Department code is required").max(100),
  name: z.string().trim().min(1, "Department name is required").max(255),
  color: z.string().trim().min(1, "Department color is required").max(50),
  targetValue: z.coerce.number().int().min(0).optional().default(0),
});

const programUpsertSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  departmentId: z.coerce.number().int().positive("Department ID is required"),
  code: z.string().trim().min(1, "Program code is required").max(100),
  name: z.string().trim().min(1, "Program name is required").max(255),
  track: z.string().trim().max(255).nullable().optional(),
  level: z.string().trim().max(100).optional().default("Bachelor"),
  color: z.string().trim().min(1, "Program color is required").max(50),
  targetValue: z.coerce.number().int().min(0).optional().default(0),
});

const settingsUpdateSchema = z.record(z.string().min(1).max(128), z.string().max(10000));

const publicReferralPatchSchema = z.object({
  status: z.enum(["pending", "approved", "rejected"]).optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Seed DB with default programs on startup
  await seedPrograms();
  await refreshCatalog();

  // Register real background job workers (Pillar 4)
  enterpriseQueue.registerHandler<{ records: any[] }>("IMPORT_STUDENTS", async (payload, updateProgress) => {
    updateProgress(10);
    await processBatch(payload.records);
    enterpriseCache.invalidate("gis:");
    updateProgress(100);
    return { recordCount: payload.records.length };
  });

  enterpriseQueue.registerHandler("RECOMPUTE_COUNTS", async (_payload, updateProgress) => {
    updateProgress(25);
    await recomputeSchoolStudentCounts();
    enterpriseCache.invalidate("gis:");
    updateProgress(100);
    return { recomputed: true };
  });

  // Admin Background Job Queue Status Endpoints
  app.get("/api/jobs", isAdmin, (_req, res) => {
    res.json({
      stats: enterpriseQueue.getStats(),
      jobs: enterpriseQueue.listJobs(50),
    });
  });

  app.get("/api/jobs/:id", isAdmin, (req, res) => {
    const jobId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const job = enterpriseQueue.getJob(jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });
    res.json(job);
  });

  // Admin routes
  app.get("/api/users", isAdmin, async (req, res) => {
    const allUsers = await getDb().select({ id: users.id, username: users.username, role: users.role, isActive: users.isActive, createdAt: users.createdAt }).from(users).orderBy(desc(users.createdAt));
    res.json(allUsers);
  });

  app.post("/api/users", isAdmin, writeLimiter, async (req, res) => {
    try {
      const parsed = createUserBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid user data" });
      }
      const { username, password, role, isActive } = parsed.data;
      const db = getDb();
      const existing = await db.select().from(users).where(eq(users.username, username)).limit(1);
      if (existing.length > 0) return res.status(400).json({ message: "Username already exists" });
      const hashedPassword = await hashPassword(password);
      const [insertResult] = await db.insert(users).values({ username, password: hashedPassword, role, isActive });
      const user = await db.select({ id: users.id, username: users.username, role: users.role, isActive: users.isActive }).from(users).where(eq(users.id, insertResult.insertId)).limit(1).then(r => r[0]);
      await logAuditEvent({ action: "CREATE", targetResource: `user:${username}`, details: `Created ${role} account` }, req);
      res.status(201).json(user);
    } catch (err) {
      res.status(500).json({ message: "Failed to create user" });
    }
  });

  app.put("/api/users/:id", isAdmin, writeLimiter, async (req, res) => {
    try {
      const userId = parsePositiveIntId(req.params.id);
      if (!userId) return res.status(400).json({ message: "Invalid user ID" });
      const parsed = updateUserBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid user update data" });
      }
      const { password, role, isActive } = parsed.data;
      const updates: any = {};
      if (password) updates.password = await hashPassword(password);
      if (role) updates.role = role;
      if (isActive !== undefined) updates.isActive = isActive;
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ message: "No valid fields provided for update" });
      }

      await getDb().update(users).set(updates).where(eq(users.id, userId));
      const user = await getDb().select({ id: users.id, username: users.username, role: users.role, isActive: users.isActive }).from(users).where(eq(users.id, userId)).limit(1).then(r => r[0]);
      if (!user) return res.status(404).json({ message: "User not found" });
      await logAuditEvent({ action: "UPDATE", targetResource: `user:${userId}`, details: `Updated account fields: ${Object.keys(updates).join(", ")}` }, req);
      res.json(user);
    } catch (err) {
      res.status(500).json({ message: "Failed to update user" });
    }
  });

  app.delete("/api/users/:id", isAdmin, writeLimiter, async (req, res) => {
    try {
      const userId = parsePositiveIntId(req.params.id);
      if (!userId) return res.status(400).json({ message: "Invalid user ID" });
      if (userId === (req.user as any)?.id) return res.status(400).json({ message: "Cannot delete your own account" });
      await getDb().delete(users).where(eq(users.id, userId));
      await logAuditEvent({ action: "DELETE", targetResource: `user:${userId}`, details: "Deleted user account" }, req);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ message: "Failed to delete user" });
    }
  });

  // School routes (unified list + search endpoint; eliminates duplicate registration)
  app.get(api.schoolRegistry.list.path, async (req, res) => {
    const q = String(req.query.q || "").trim();
    if (q) {
      const results = await searchSchools(q);
      return res.json(results);
    }
    const schoolsList = await enterpriseCache.getOrSet("schools:all", 120, async () =>
      (await storage.listSchoolRegistry()).filter(isSchoolDirectoryEntry));
    res.json(schoolsList);
  });

  app.post(api.schoolRegistry.import.path, isAdmin, uploadLimiter, async (req, res) => {
    try {
      const input = api.schoolRegistry.import.input.parse(req.body);
      const result = await storage.importSchools(input.schoolRegistry as any);
      enterpriseCache.invalidate("schools:");
      enterpriseCache.invalidate("gis:");
      res.json(result);
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      throw err;
    }
  });

  // Admin Master Directory Routes
  app.get("/api/admin/directory", isAdmin, async (req, res) => {
    res.json(await storage.listSchoolRegistry());
  });

  app.post("/api/admin/clear-data", isAdmin, writeLimiter, async (req, res) => {
    try {
      const db = getDb();
      const safeDelete = async (table: any) => {
        try { await db.delete(table); } catch (e) { console.warn(`Failed to delete table:`, (e as Error).message); }
      };

      await safeDelete(mappingLogs);
      await safeDelete(studentsProcessed);
      await safeDelete(studentsRaw);
      await safeDelete(studentImports);
      await safeDelete(imports);
      await safeDelete(referrals);
      await safeDelete(students);
      enterpriseCache.invalidate();
      await logAuditEvent({ action: "CLEAR_ALL_DATA", targetResource: "all_student_tables", details: "Factory reset of student and import tables" }, req);
      res.json({ success: true, message: "All student and import data has been factory reset." });
    } catch (err) {
      console.error("[clear-data] error:", err);
      res.status(500).json({ success: false, message: "Failed to clear data" });
    }
  });

  app.post("/api/admin/archive-data", isAdmin, writeLimiter, async (req, res) => {
    try {
      const db = getDb();
      const now = new Date();
      await db.update(studentsProcessed).set({ enrollmentStatus: "Archived", archivedAt: now });
      await db.update(studentImports).set({ enrollmentStatus: "Archived" });
      enterpriseCache.invalidate();
      await logAuditEvent({ action: "UPDATE", targetResource: "students_processed", details: "Archived all active student records" }, req);
      res.json({ success: true, message: "All active student data has been archived successfully." });
    } catch (err) {
      console.error("[archive-data] error:", err);
      res.status(500).json({ success: false, message: "Failed to archive data" });
    }
  });

  app.post("/api/admin/directory/import", isAdmin, uploadLimiter, (req, res, next) => {
    upload.single("file")(req, res, (err: any) => {
      if (err) {
        return res.status(400).json({ success: false, message: err.message || "Invalid file upload" });
      }
      next();
    });
  }, async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    const uploadedPath = req.file.path;
    try {
      // Sync excel to JSON and reload memory
      const schools = syncExcelToJSON(uploadedPath);
      await storage.importSchools(schools as any);
      enterpriseCache.invalidate("schools:");
      enterpriseCache.invalidate("gis:");
      await logAuditEvent({ action: "IMPORT_DIRECTORY", targetResource: "school_registry", details: `Imported ${schools.length} schools from ${req.file.originalname}` }, req);
      res.json({ success: true, count: schools.length, message: `Successfully imported ${schools.length} schools into the master directory.` });
    } catch (err) {
      console.error("[directory/import] error:", err);
      res.status(500).json({ success: false, message: err instanceof Error ? err.message : "Failed to import directory" });
    } finally {
      await unlink(uploadedPath).catch(() => { });
    }
  });

  app.get(api.schoolRegistry.get.path, async (req, res) => {
    const id = parsePositiveIntId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid school ID" });
    const school = await storage.getSchoolRegistry(id);
    if (!school) return res.status(404).json({ message: 'School not found' });
    res.json(school);
  });

  app.post(api.schoolRegistry.create.path, isAdmin, writeLimiter, async (req, res) => {
    try {
      const input = api.schoolRegistry.create.input.parse(req.body);
      const school = await storage.createSchoolRegistry(input);
      // Auto-link any unmapped processed students whose school name matches the newly added school
      if (school?.id && school.schoolName) {
        const db = getDb();
        await db.update(studentsProcessed).set({
          schoolRegistryId: school.id,
          mappingStatus: hasCoordinates(school) ? "mapped" : "needs_review",
        }).where(
          and(
            isNull(studentsProcessed.schoolRegistryId),
            or(
              eq(studentsProcessed.lastSchoolName, school.schoolName),
              eq(studentsProcessed.previousSchool, school.schoolName),
            ),
          ),
        );
      }
      enterpriseCache.invalidate("schools:");
      enterpriseCache.invalidate("gis:");
      res.status(201).json(school);
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      throw err;
    }
  });

  app.put(api.schoolRegistry.update.path, isAdmin, writeLimiter, async (req, res) => {
    try {
      const id = parsePositiveIntId(req.params.id);
      if (!id) return res.status(400).json({ message: "Invalid school ID" });
      const input = api.schoolRegistry.update.input.parse(req.body);
      const school = await storage.updateSchoolRegistry(id, input);
      if (!school) return res.status(404).json({ message: 'School not found' });
      if (hasCoordinates(school)) {
        const db = getDb();
        await db.update(studentsProcessed)
          .set({ mappingStatus: "mapped" })
          .where(eq(studentsProcessed.schoolRegistryId, id));
      }
      enterpriseCache.invalidate("schools:");
      enterpriseCache.invalidate("gis:");
      res.json(school);
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      throw err;
    }
  });

  app.delete(api.schoolRegistry.delete.path, isAdmin, writeLimiter, async (req, res) => {
    const id = parsePositiveIntId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid school ID" });
    await storage.deleteSchoolRegistry(id);
    enterpriseCache.invalidate("schools:");
    enterpriseCache.invalidate("gis:");
    res.status(204).send();
  });

  app.post(api.schoolRegistry.merge.path, isAdmin, writeLimiter, async (req, res) => {
    try {
      const duplicateId = parsePositiveIntId(req.params.id);
      if (!duplicateId) return res.status(400).json({ message: "Invalid school ID" });
      const input = api.schoolRegistry.merge.input.parse(req.body);
      await storage.mergeSchoolRegistry(duplicateId, input.targetId);
      enterpriseCache.invalidate("schools:");
      enterpriseCache.invalidate("gis:");
      res.json({ success: true, message: `Successfully merged school ${duplicateId} into ${input.targetId}` });
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      res.status(500).json({ message: err instanceof Error ? err.message : "Internal Server Error" });
    }
  });

  // Barangay Registry Routes
  app.get("/api/barangay-registry", async (req, res) => {
    try {
      const list = await enterpriseCache.getOrSet("barangays:all", 300, async () => {
        const db = getDb();
        return db.select().from(barangayRegistry);
      });
      res.json(list);
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch barangay registry" });
    }
  });

  app.post("/api/barangay-registry", isAdmin, writeLimiter, async (req, res) => {
    try {
      const parsed = barangayCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid barangay data" });
      }
      const db = getDb();
      const [result] = await db.insert(barangayRegistry).values(parsed.data);
      const [newBarangay] = await db.select().from(barangayRegistry).where(eq(barangayRegistry.id, (result as any).insertId));
      enterpriseCache.invalidate("barangays:");
      res.status(201).json(newBarangay);
    } catch (err) {
      res.status(500).json({ message: "Failed to create barangay" });
    }
  });

  app.post("/api/barangay-registry/:id/geocode", isAdmin, writeLimiter, async (req, res) => {
    const id = parsePositiveIntId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid barangay ID" });
    const db = getDb();
    const [barangay] = await db.select().from(barangayRegistry)
      .where(and(eq(barangayRegistry.id, id), eq(barangayRegistry.isActive, true))).limit(1);
    if (!barangay) return res.status(404).json({ message: "Barangay not found in the active directory." });
    if (hasCoordinates(barangay)) return res.json(barangay);

    const coordinates = await geocodeBarangay(barangay);
    if (!coordinates) return res.status(404).json({ message: "No verified coordinates found for this barangay." });
    await db.update(barangayRegistry).set({ ...coordinates, updatedAt: new Date() })
      .where(and(eq(barangayRegistry.id, id), eq(barangayRegistry.isActive, true),
        or(isNull(barangayRegistry.latitude), isNull(barangayRegistry.longitude))));
    enterpriseCache.invalidate("barangays:");
    const [updated] = await db.select().from(barangayRegistry).where(eq(barangayRegistry.id, id)).limit(1);
    if (!updated) return res.status(404).json({ message: "Barangay not found." });
    return res.json(updated);
  });

  app.patch("/api/barangay-registry/:id", isAdmin, writeLimiter, async (req, res) => {
    try {
      const id = parsePositiveIntId(req.params.id);
      if (!id) return res.status(400).json({ message: "Invalid barangay ID" });
      const parsed = barangayPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid barangay update data" });
      }
      if (Object.keys(parsed.data).length === 0) {
        return res.status(400).json({ message: "No valid fields provided for update" });
      }
      const db = getDb();
      await db.update(barangayRegistry).set({ ...parsed.data, updatedAt: new Date() }).where(eq(barangayRegistry.id, id));
      const [updated] = await db.select().from(barangayRegistry).where(eq(barangayRegistry.id, id));
      if (!updated) return res.status(404).json({ message: "Barangay not found" });
      enterpriseCache.invalidate("barangays:");
      res.json(updated);
    } catch (err) {
      res.status(500).json({ message: "Failed to update barangay" });
    }
  });

  app.delete("/api/barangay-registry/:id", isAdmin, writeLimiter, async (req, res) => {
    try {
      const id = parsePositiveIntId(req.params.id);
      if (!id) return res.status(400).json({ message: "Invalid barangay ID" });
      const db = getDb();
      await db.delete(barangayRegistry).where(eq(barangayRegistry.id, id));
      enterpriseCache.invalidate("barangays:");
      res.status(204).send();
    } catch (err) {
      res.status(500).json({ message: "Failed to delete barangay" });
    }
  });

  app.post(api.schoolRegistry.bulkMerge.path, isAdmin, writeLimiter, async (req, res) => {
    try {
      const input = api.schoolRegistry.bulkMerge.input.parse(req.body);
      let mergedCount = 0;
      for (const pair of input.pairs) {
        if (pair.duplicateId !== pair.targetId) {
          try {
            await storage.mergeSchoolRegistry(pair.duplicateId, pair.targetId);
            mergedCount++;
          } catch (mergeErr) {
            console.error(`Failed to merge ${pair.duplicateId} into ${pair.targetId}:`, mergeErr);
            // Continue with other pairs even if one fails
          }
        }
      }
      enterpriseCache.invalidate("schools:");
      enterpriseCache.invalidate("gis:");
      res.json({ success: true, message: `Successfully merged ${mergedCount} schools`, mergedCount });
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      res.status(500).json({ message: err instanceof Error ? err.message : "Internal Server Error" });
    }
  });

  app.post(api.schoolRegistry.batchDelete.path, isAdmin, writeLimiter, async (req, res) => {
    try {
      const input = api.schoolRegistry.batchDelete.input.parse(req.body);
      const result = await storage.batchDeleteSchoolRegistry(input.ids);
      enterpriseCache.invalidate("schools:");
      enterpriseCache.invalidate("gis:");
      const message = result.skippedCount > 0
        ? `Deleted ${result.deletedCount} schools. Skipped ${result.skippedCount} schools because they are actively mapped to students.`
        : `Successfully deleted ${result.deletedCount} schools.`;

      res.json({
        success: true,
        deletedCount: result.deletedCount,
        skippedCount: result.skippedCount,
        message,
      });
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ success: false, deletedCount: 0, skippedCount: 0, message: err.errors[0].message });
      if (err instanceof Error) return res.status(500).json({ success: false, deletedCount: 0, skippedCount: 0, message: err.message });
      throw err;
    }
  });

  // ── Location Mismatch Validation ──────────────────────────────────────
  app.post("/api/schoolRegistry/validate-locations", isAdmin, writeLimiter, async (req, res) => {
    try {
      const { schoolIds } = req.body || {};
      const allSchools = await storage.listSchoolRegistry();
      const db = getDb();

      // Filter to requested IDs or all schools with coordinates
      let targetSchools = allSchools.filter(s =>
        s.latitude !== null && s.longitude !== null && s.isActive
      );
      if (Array.isArray(schoolIds) && schoolIds.length > 0) {
        const idSet = new Set(schoolIds.map(Number));
        targetSchools = targetSchools.filter(s => idSet.has(s.id));
      }

      // Build student origins map from processed students
      const processedRows = await db.select({
        schoolRegistryId: studentsProcessed.schoolRegistryId,
        municipality: studentsProcessed.municipality,
        province: studentsProcessed.province,
      }).from(studentsProcessed);

      const schoolStudents = new Map<number, { municipality: string; province: string }[]>();
      for (const row of processedRows) {
        if (!row.schoolRegistryId) continue;
        if (!row.municipality && !row.province) continue;
        const students = schoolStudents.get(row.schoolRegistryId) || [];
        students.push({ municipality: row.municipality || "", province: row.province || "" });
        schoolStudents.set(row.schoolRegistryId, students);
      }

      const studentOriginsMap = new Map<number, string>();
      for (const [schoolId, students] of Array.from(schoolStudents.entries())) {
        const mCount = new Map<string, number>();
        for (const s of students) {
          if (s.municipality) mCount.set(s.municipality, (mCount.get(s.municipality) || 0) + 1);
        }
        const topMunicipality = Array.from(mCount.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
        const pCount = new Map<string, number>();
        for (const s of students) {
          if (s.province) pCount.set(s.province, (pCount.get(s.province) || 0) + 1);
        }
        const topProvince = Array.from(pCount.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
        const origin = [topMunicipality, topProvince].filter(Boolean).join(", ");
        if (origin) studentOriginsMap.set(schoolId, origin);
      }

      // Validate each school
      const results = targetSchools.map(school => {
        const studentOrigin = studentOriginsMap.get(school.id);
        const mismatch = detectLocationMismatch(
          school.schoolName,
          school.province || "",
          school.municipality || "",
          studentOrigin,
        );
        const hints = extractLocationHintsFromName(school.schoolName);
        const ambiguous = isAmbiguousSchoolName(school.schoolName);

        return {
          schoolId: school.id,
          schoolName: school.schoolName,
          currentMunicipality: school.municipality,
          currentProvince: school.province,
          latitude: school.latitude,
          longitude: school.longitude,
          studentOrigin: studentOrigin || null,
          locationHints: hints.map(h => h.place),
          isAmbiguous: ambiguous,
          ...mismatch,
        };
      });

      // Only return results with issues
      const issues = results.filter(r => r.hasMismatch || r.isAmbiguous);

      res.json({
        total: targetSchools.length,
        issueCount: issues.length,
        results: issues,
      });
    } catch (err) {
      console.error("[validate-locations] error:", err);
      res.status(500).json({ message: err instanceof Error ? err.message : "Validation failed" });
    }
  });

  // V2 High-Performance Import Engine Routes
  app.get("/api/integrations/last-batch", isAdmin, async (req, res) => {
    try {
      const db = getDb();
      const records = await db.select().from(systemSettings).where(eq(systemSettings.key, "last_batch_memory"));
      if (records.length > 0 && records[0].value) {
        return res.json(JSON.parse(records[0].value));
      }

      const totalStudents = await db.select().from(studentsProcessed);
      res.json({
        batchId: "BATCH-INITIAL",
        totalRecords: totalStudents.length,
        fetchedAt: new Date().toISOString(),
        status: "applied",
        appliedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to fetch last batch info" });
    }
  });

  app.post("/api/integrations/apply-batch", isAdmin, writeLimiter, async (req, res) => {
    try {
      const db = getDb();
      const now = new Date().toISOString();

      const records = await db.select().from(systemSettings).where(eq(systemSettings.key, "last_batch_memory"));
      let memory = records.length > 0 && records[0].value ? JSON.parse(records[0].value) : {};

      memory.status = "applied";
      memory.appliedAt = now;

      const existing = await db.select().from(systemSettings).where(eq(systemSettings.key, "last_batch_memory"));
      if (existing.length > 0) {
        await db.update(systemSettings).set({ value: JSON.stringify(memory) }).where(eq(systemSettings.key, "last_batch_memory"));
      } else {
        await db.insert(systemSettings).values({ key: "last_batch_memory", value: JSON.stringify(memory) });
      }

      await db.update(studentsProcessed)
        .set({ mappingStatus: "mapped", syncedAt: new Date() })
        .where(eq(studentsProcessed.mappingStatus, "needs_review"));

      await db.insert(mappingLogs).values({
        action: "Batch Applied to Live Feed",
        matchedRule: "Manual Batch Approval",
        notes: `Applied batch ${memory.batchId || 'N/A'} (${memory.totalRecords || 0} records) to Live Mapping.`,
      });

      enterpriseCache.invalidate("gis:");
      res.json({ success: true, message: `Batch ${memory.batchId || ''} committed to Live GIS Mapping!`, memory });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message || "Failed to apply batch" });
    }
  });

  app.post("/api/integrations/sync-google-sheets", isAdmin, uploadLimiter, async (req, res) => {
    try {
      const { sheetsUrl, sheetsToken, syncMode = "live" } = req.body;
      if (!sheetsUrl) return res.status(400).json({ success: false, message: "URL is required" });

      const payload = {
        sourceType: "googleSheets" as const,
        url: sheetsUrl as string,
        method: "GET" as const,
        authMode: (sheetsToken ? "bearer" : "none") as "bearer" | "none",
        authToken: sheetsToken,
      };

      const result = await previewIntegrationSource(payload);

      // Auto-map Google Sheet columns (supports both standard headers and Trimex's 25-column enrollment sheet format)
      const mappedRecords = result.records.map((r: any) => {
        const keys = Object.keys(r);
        const getExactOrIncludes = (exactList: string[], includesList: string[] = []) => {
          const exactKey = keys.find((k) => exactList.includes(k.trim().toLowerCase().replace(/\s*:\s*$/, "")));
          if (exactKey && r[exactKey] !== undefined && String(r[exactKey]).trim() !== "") {
            return String(r[exactKey]).trim();
          }
          const incKey = keys.find((k) => {
            const norm = k.trim().toLowerCase();
            return includesList.some((p) => norm.includes(p));
          });
          return incKey && r[incKey] !== undefined && String(r[incKey]).trim() !== ""
            ? String(r[incKey]).trim()
            : undefined;
        };

        const orNo = getExactOrIncludes(["or no", "or number", "or #"], []);
        const voucher = getExactOrIncludes(["vouchers", "voucher"], []);
        const col11Brgy = r["__EMPTY"] !== undefined ? String(r["__EMPTY"]).trim() : "";
        const col12Strand = r["__EMPTY_1"] !== undefined ? String(r["__EMPTY_1"]).trim() : "";

        // Detect Iskolar ni Kap / Barangay Scholar from explicit column OR Trimex OR No (/INK, INK/)
        const explicitScholar = getExactOrIncludes(
          ["scholarship", "iskolar", "scholar", "iskolar ni kap", "barangay scholar"],
          ["scholarship", "iskolar"]
        );
        const isInkFromOr = orNo ? /\bINK\b/i.test(orNo) : false;
        const derivedScholarship = explicitScholar || (isInkFromOr ? (col11Brgy || "INK") : undefined) || (voucher && /iskolar|konskolar/i.test(voucher) ? voucher : undefined);

        const addressVal = getExactOrIncludes(["address", "home address"], ["address"]);
        const explicitBarangay = getExactOrIncludes(["barangay", "brgy"], ["barangay", "brgy"]);
        const explicitStrand = getExactOrIncludes(["strand", "track"], ["strand"]);

        return {
          enrollmentStatus: getExactOrIncludes(["fcabr", "status", "admission status", "enrollment status"], ["status"]),
          studentNumber: getExactOrIncludes(["student #", "student number", "student no", "student id", "student_number", "lrn"], ["student #", "student no", "student number", "student id"]),
          fullName: getExactOrIncludes(["full name", "fullname", "student name", "name"], ["full name", "student name"]),
          previousSchool: getExactOrIncludes(["previous school", "last school", "feeder school", "school name"], ["previous school", "last school", "feeder"]),
          program: getExactOrIncludes(["program", "course", "degree"], ["program", "course"]),
          scholarship: derivedScholarship,
          municipality: getExactOrIncludes(["municipality", "city", "town"], ["municipality"]) || addressVal,
          province: getExactOrIncludes(["province"], ["province"]),
          barangay: explicitBarangay || (col11Brgy && !/konskolar/i.test(col11Brgy) ? col11Brgy : undefined),
          address: addressVal,
          strand: explicitStrand || col12Strand || undefined,
          schedule: getExactOrIncludes(["schedule", "sched"], ["schedule"]),
          contactNumber: getExactOrIncludes(["contact no", "contact number", "contact", "phone", "mobile"], ["contact no", "contact number", "mobile"]),
          requirements: getExactOrIncludes(["requirements", "req"], ["requirements"]),
          importSource: "Google Sheets Auto-Sync",
        };
      });

      startImportSession(mappedRecords.length);
      const syncJob = enterpriseQueue.enqueue("IMPORT_STUDENTS", { records: mappedRecords });

      // Save batch memory
      const db = getDb();
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const randomId = Math.floor(Math.random() * 8999 + 1000);
      const batchMemory = {
        batchId: `BATCH-${dateStr}-${randomId}`,
        totalRecords: mappedRecords.length,
        fetchedAt: new Date().toISOString(),
        status: syncMode === "staging" ? "staged" : "applied",
        appliedAt: syncMode === "live" ? new Date().toISOString() : null,
      };

      const existingMemory = await db.select().from(systemSettings).where(eq(systemSettings.key, "last_batch_memory"));
      if (existingMemory.length > 0) {
        await db.update(systemSettings).set({ value: JSON.stringify(batchMemory) }).where(eq(systemSettings.key, "last_batch_memory"));
      } else {
        await db.insert(systemSettings).values({ key: "last_batch_memory", value: JSON.stringify(batchMemory) });
      }

      res.json({
        success: true,
        jobId: syncJob.id,
        message: syncMode === "staging"
          ? `Staged batch of ${mappedRecords.length} records. Review or click Apply to commit.`
          : `Auto-sync started for ${mappedRecords.length} records. Live mapping active.`,
        batchMemory
      });
    } catch (err: any) {
      console.error("Auto-sync error:", err);
      const msg = err?.message || "Failed to sync";
      const isClientError = /google sheet|spreadsheet id|invalid url|public or shared|returned 40[0134]/i.test(msg);
      res.status(isClientError ? 400 : 500).json({ success: false, message: msg });
    }
  });

  app.post("/api/imports/start", isAdmin, uploadLimiter, async (req, res) => {
    const { totalRecords } = req.body;
    if (!totalRecords) return res.status(400).json({ message: "totalRecords is required" });

    const db = getDb();
    // Clear old staging data before starting a new import session
    await db.delete(studentImports);

    startImportSession(totalRecords);
    res.json({ success: true, message: "Import session started" });
  });

  app.post("/api/imports/batch", isAdmin, uploadLimiter, async (req, res) => {
    const { records } = req.body;
    if (!records || !Array.isArray(records)) return res.status(400).json({ message: "records array is required" });

    // Offload batch processing to the concurrent background job queue
    const job = enterpriseQueue.enqueue("IMPORT_STUDENTS", { records });

    res.json({ success: true, jobId: job.id, message: "Batch queued for background processing" });
  });

  app.get("/api/imports/progress", isAdmin, (req, res) => {
    res.json(getImportProgress());
  });

  app.get("/api/imports/staging", isAdmin, async (req, res) => {
    const db = getDb();
    const [stagingRows, unmappedProcessed] = await Promise.all([
      db.select().from(studentImports),
      db.select().from(studentsProcessed).where(
        and(
          ne(studentsProcessed.enrollmentStatus, "Archived"),
          or(
            isNull(studentsProcessed.schoolRegistryId),
            eq(studentsProcessed.mappingStatus, "needs_review"),
          ),
        ),
      ),
    ]);

    const syntheticFromProcessed = unmappedProcessed
      .filter((s) => !s.schoolRegistryId && s.lastSchoolName && s.lastSchoolName !== "Unknown")
      .map((s) => ({
        id: -s.id,
        studentNumber: s.studentNumber,
        fullName: s.fullName || "Unknown",
        previousSchool: s.previousSchool || s.lastSchoolName,
        program: s.course,
        scholarship: s.iskolarNiKap,
        municipality: [s.barangay, s.municipality, s.province].filter(Boolean).join(", ") || "Laguna",
        importSource: s.importedSource || "Google Sheets Auto-Sync",
        importStatus: "Unmatched",
        importedAt: s.syncedAt,
      }));

    res.json([...stagingRows, ...syntheticFromProcessed]);
  });

  app.get("/api/settings", async (req, res) => {
    const db = getDb();
    const records = await db.select().from(systemSettings);
    const callerIsAdmin = Boolean(req.isAuthenticated && req.isAuthenticated() && (req.user as any)?.role === "admin");
    // Mask sensitive integration tokens/secrets for non-admin or unauthenticated callers
    const settingsMap = records.reduce((acc: Record<string, string>, curr: any) => {
      if (!callerIsAdmin && SENSITIVE_SETTING_KEY_PATTERN.test(curr.key)) {
        return acc;
      }
      acc[curr.key] = curr.value;
      return acc;
    }, {});
    res.json(settingsMap);
  });

  app.post("/api/settings", isAdmin, writeLimiter, async (req, res) => {
    const parsed = settingsUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid settings payload" });
    }
    const db = getDb();

    const updates = parsed.data;
    for (const [key, value] of Object.entries(updates)) {
      const existing = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
      if (existing.length > 0) {
        await db.update(systemSettings).set({ value }).where(eq(systemSettings.key, key));
      } else {
        await db.insert(systemSettings).values({ key, value });
      }
    }
    res.json({ success: true, message: "Settings saved successfully" });
  });

  // Departments and Programs API
  app.get("/api/departments", async (req, res) => {
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    const records = await enterpriseCache.getOrSet("departments:all", 300, async () => {
      const db = getDb();
      return db.select().from(departments);
    });
    res.json(records);
  });

  app.post("/api/departments", isAdmin, writeLimiter, async (req, res) => {
    try {
      const parsed = departmentUpsertSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid department data" });
      }
      const { id, code, name, color, targetValue } = parsed.data;
      const db = getDb();

      if (id) {
        await db.update(departments)
          .set({ code, name, color, targetValue: targetValue || 0, updatedAt: new Date() })
          .where(eq(departments.id, id));
        const updated = await db.select().from(departments).where(eq(departments.id, id));
        enterpriseCache.invalidate("departments:");
        enterpriseCache.invalidate("programs:");
        res.json(updated[0]);
      } else {
        const existing = await db.select().from(departments).where(eq(departments.code, code)).limit(1);
        if (existing.length > 0) {
          await db.update(departments)
            .set({ name, color, targetValue: targetValue || 0, updatedAt: new Date() })
            .where(eq(departments.id, existing[0].id));
          const updated = await db.select().from(departments).where(eq(departments.id, existing[0].id));
          enterpriseCache.invalidate("departments:");
          enterpriseCache.invalidate("programs:");
          res.json(updated[0]);
        } else {
          const [result] = await db.insert(departments)
            .values({ code, name, color, targetValue: targetValue || 0, updatedAt: new Date() });
          const inserted = await db.select().from(departments).where(eq(departments.id, result.insertId));
          enterpriseCache.invalidate("departments:");
          enterpriseCache.invalidate("programs:");
          res.json(inserted[0]);
        }
      }
    } catch (error: any) {
      if (error.code === '23505' || error.code === 'ER_DUP_ENTRY') {
        console.warn(`[POST /api/departments] Duplicate code attempt: ${req.body.code}`);
        return res.status(400).json({ message: "A department with this code already exists." });
      }
      console.error("[POST /api/departments] error:", error);
      res.status(500).json({ message: "Failed to save department" });
    }
  });

  app.delete("/api/departments/:id", isAdmin, writeLimiter, async (req, res) => {
    try {
      const deptId = parsePositiveIntId(req.params.id);
      if (!deptId) return res.status(400).json({ message: "Invalid department ID" });
      const db = getDb();
      // Also delete associated programs
      await db.delete(programs).where(eq(programs.departmentId, deptId));
      await db.delete(departments).where(eq(departments.id, deptId));
      enterpriseCache.invalidate("departments:");
      enterpriseCache.invalidate("programs:");
      res.json({ success: true });
    } catch (error: any) {
      console.error("[DELETE /api/departments/:id] error:", error);
      res.status(500).json({ message: "Failed to delete department" });
    }
  });

  app.get("/api/programs", async (req, res) => {
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    const formatted = await enterpriseCache.getOrSet("programs:all", 300, async () => {
      const db = getDb();
      const dbPrograms = await db.select().from(programs);
      const deptRecords = await db.select().from(departments);
      const deptMap = new Map(deptRecords.map(d => [d.id, d]));

      return dbPrograms.map(p => {
        const dept = deptMap.get(p.departmentId);
        return {
          ...p,
          college: dept?.code || "Unknown",
          collegeName: dept?.name || "Unknown",
          department: dept?.code || "Unknown",
          departmentName: dept?.name || "Unknown",
          program: p.name,
          departmentColor: dept?.color || "#e5e7eb"
        };
      });
    });
    res.json(formatted);
  });

  app.post("/api/programs", isAdmin, writeLimiter, async (req, res) => {
    try {
      const parsed = programUpsertSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid program data" });
      }
      const { id, departmentId, code, name, track, level, color, targetValue } = parsed.data;
      const db = getDb();

      if (id) {
        await db.update(programs)
          .set({ departmentId, code, name, track, level, color, targetValue: targetValue || 0, updatedAt: new Date() })
          .where(eq(programs.id, id));
        const updated = await db.select().from(programs).where(eq(programs.id, id));
        await refreshCatalog();
        res.json(updated[0]);
      } else {
        const existing = await db.select().from(programs).where(eq(programs.code, code)).limit(1);
        if (existing.length > 0) {
          await db.update(programs)
            .set({ departmentId, name, track, level, color, targetValue: targetValue || 0, updatedAt: new Date() })
            .where(eq(programs.id, existing[0].id));
          const updated = await db.select().from(programs).where(eq(programs.id, existing[0].id));
          await refreshCatalog();
          res.json(updated[0]);
        } else {
          const [result] = await db.insert(programs)
            .values({ departmentId, code, name, track, level: level || "Bachelor", color, targetValue: targetValue || 0, updatedAt: new Date() });
          const inserted = await db.select().from(programs).where(eq(programs.id, result.insertId));
          await refreshCatalog();
          res.json(inserted[0]);
        }
      }
    } catch (error: any) {
      if (error.code === '23505' || error.code === 'ER_DUP_ENTRY') {
        console.warn(`[POST /api/programs] Duplicate code attempt: ${req.body.code}`);
        return res.status(400).json({ message: "A program with this code already exists." });
      }
      console.error("[POST /api/programs] error:", error);
      res.status(500).json({ message: "Failed to save program" });
    }
  });

  app.delete("/api/programs/:id", isAdmin, writeLimiter, async (req, res) => {
    try {
      const progId = parsePositiveIntId(req.params.id);
      if (!progId) return res.status(400).json({ message: "Invalid program ID" });
      const db = getDb();
      await db.delete(programs).where(eq(programs.id, progId));
      await refreshCatalog();
      res.json({ success: true });
    } catch (error: any) {
      console.error("[DELETE /api/programs/:id] error:", error);
      res.status(500).json({ message: "Failed to delete program" });
    }
  });

  app.post("/api/imports/match-resolution", isAdmin, writeLimiter, async (req, res) => {
    const db = getDb();

    const { importedName, officialSchoolId, createAlias } = req.body;
    if (!importedName || !officialSchoolId) return res.status(400).json({ message: "importedName and officialSchoolId required" });

    // 1. Save History (Self-Learning)
    const existingHistory = await db.select().from(schoolMatchHistory).where(eq(schoolMatchHistory.importedName, importedName)).limit(1);
    if (existingHistory.length > 0) {
      await db.update(schoolMatchHistory).set({
        occurrences: existingHistory[0].occurrences + 1,
        officialSchoolId,
      }).where(eq(schoolMatchHistory.id, existingHistory[0].id));
    } else {
      await db.insert(schoolMatchHistory).values({
        importedName,
        officialSchoolId,
        resolvedBy: "Admin"
      });
    }

    // 2. Save Alias if requested
    if (createAlias) {
      const normalized = normalizeSchoolName(importedName);
      const existingAlias = await db.select().from(schoolAliases).where(eq(schoolAliases.normalizedAlias, normalized)).limit(1);
      if (existingAlias.length === 0) {
        await db.insert(schoolAliases).values({
          schoolRegistryId: officialSchoolId,
          aliasName: importedName,
          normalizedAlias: normalized
        });
      }
    }

    // 3. Update pending imports AND live unmapped processed students
    await db.update(studentImports).set({
      importStatus: "Matched",
      matchedSchoolId: officialSchoolId,
      matchRule: "manual",
      matchConfidence: 100
    }).where(and(eq(studentImports.previousSchool, importedName), eq(studentImports.importStatus, "Unmatched")));

    const [targetSchool] = await db.select().from(schoolRegistry).where(eq(schoolRegistry.id, officialSchoolId)).limit(1);
    const nextMappingStatus = targetSchool && hasCoordinates(targetSchool) ? "mapped" : "needs_review";

    await db.update(studentsProcessed).set({
      schoolRegistryId: officialSchoolId,
      mappingStatus: nextMappingStatus,
    }).where(
      or(
        eq(studentsProcessed.lastSchoolName, importedName),
        eq(studentsProcessed.previousSchool, importedName),
      ),
    );

    enterpriseCache.invalidate("gis:");
    enterpriseCache.invalidate("schools:");

    res.json({ success: true, message: "Match resolution saved" });
  });

  // ---------------------------------------------------------------------------
  // Advanced Large-Scale Unmapped Smart Mapping Generator (Chunked + Anti-Mis-Map)
  // ---------------------------------------------------------------------------
  app.post("/api/admin/unmapped/generate-plan", isAdmin, async (req, res) => {
    try {
      const includeGoogleFallback = Boolean(req.body?.includeGoogleFallback);
      const db = getDb();

      const [allProcessed, pendingImports, allSchools, allAliases] = await Promise.all([
        db.select().from(studentsProcessed).where(ne(studentsProcessed.enrollmentStatus, "Archived")),
        db.select().from(studentImports).where(eq(studentImports.importStatus, "Unmatched")),
        storage.listSchoolRegistry(),
        db.select().from(schoolAliases),
      ]);

      const activeSchools = allSchools.filter((s) => isSchoolDirectoryEntry(s) && s.isActive);
      const schoolById = new Map(activeSchools.map((s) => [s.id, s]));
      const schoolsWithCoords = activeSchools.filter((s) => hasCoordinates(s));
      const registryMatcher = new SchoolMatchingEngine(schoolsWithCoords, allAliases);

      const unmappedProcessed = allProcessed.filter((row) => {
        if (!row.schoolRegistryId) return true;
        if (row.mappingStatus === "needs_review" || row.mappingStatus === "pending") return true;
        const linked = schoolById.get(row.schoolRegistryId);
        return !linked || !hasCoordinates(linked);
      });

      interface RawUnmappedBucket {
        groupKey: string;
        rawSchoolName: string;
        linkedSchoolId?: number;
        processedIds: number[];
        importIds: number[];
        muniCounts: Map<string, number>;
        provCounts: Map<string, number>;
        typeCounts: Map<string, number>;
        shsStrandCount: number;
        sampleStudents: Array<{ studentNumber: string; fullName: string; course: string; locality: string }>;
      }

      const buckets = new Map<string, RawUnmappedBucket>();

      const addToBucket = (opts: {
        rawName: string;
        linkedSchoolId?: number | null;
        processedId?: number;
        importId?: number;
        studentNumber: string;
        fullName: string;
        course?: string | null;
        municipality?: string | null;
        province?: string | null;
        barangay?: string | null;
        studentType?: string | null;
        strand?: string | null;
      }) => {
        const cleanDisplay = (opts.rawName || "").trim();
        if (!cleanDisplay || cleanDisplay.toLowerCase() === "unknown") return;

        const normKey = normalizeSchoolName(cleanDisplay) || cleanDisplay.toLowerCase();
        const groupKey = opts.linkedSchoolId ? `LINKED-${opts.linkedSchoolId}-${normKey}` : `RAW-${normKey}`;

        let bucket = buckets.get(groupKey);
        if (!bucket) {
          bucket = {
            groupKey,
            rawSchoolName: cleanDisplay,
            linkedSchoolId: opts.linkedSchoolId || undefined,
            processedIds: [],
            importIds: [],
            muniCounts: new Map(),
            provCounts: new Map(),
            typeCounts: new Map(),
            shsStrandCount: 0,
            sampleStudents: [],
          };
          buckets.set(groupKey, bucket);
        }

        if (opts.processedId !== undefined) bucket.processedIds.push(opts.processedId);
        if (opts.importId !== undefined) bucket.importIds.push(opts.importId);

        const muni = (opts.municipality || "").trim();
        if (muni && muni.toLowerCase() !== "laguna" && muni.toLowerCase() !== "unknown") {
          bucket.muniCounts.set(muni, (bucket.muniCounts.get(muni) || 0) + 1);
        }
        const prov = (opts.province || "").trim();
        if (prov && prov.toLowerCase() !== "unknown") {
          bucket.provCounts.set(prov, (bucket.provCounts.get(prov) || 0) + 1);
        }
        const stType = (opts.studentType || opts.strand || "").trim();
        if (stType) {
          bucket.typeCounts.set(stType, (bucket.typeCounts.get(stType) || 0) + 1);
        }
        if (opts.strand && /\b(stem|abm|humss|humms|gas|tvl|ict|he)\b/i.test(opts.strand)) {
          bucket.shsStrandCount += 1;
        }
        if (bucket.sampleStudents.length < 5) {
          bucket.sampleStudents.push({
            studentNumber: opts.studentNumber || "—",
            fullName: opts.fullName || "Unknown",
            course: opts.course || "—",
            locality: [opts.barangay, opts.municipality, opts.province].filter(Boolean).join(", ") || "Unspecified",
          });
        }
      };

      for (const s of unmappedProcessed) {
        const linked = s.schoolRegistryId ? schoolById.get(s.schoolRegistryId) : undefined;
        addToBucket({
          rawName: linked?.schoolName || s.previousSchool || s.lastSchoolName,
          linkedSchoolId: s.schoolRegistryId,
          processedId: s.id,
          studentNumber: s.studentNumber,
          fullName: s.fullName,
          course: s.course,
          municipality: s.municipality,
          province: s.province,
          barangay: s.barangay,
          studentType: s.admissionType,
          strand: s.strand,
        });
      }

      for (const imp of pendingImports) {
        if (!imp.previousSchool) continue;
        addToBucket({
          rawName: imp.previousSchool,
          importId: imp.id,
          studentNumber: imp.studentNumber,
          fullName: imp.fullName,
          course: imp.program,
          municipality: imp.municipality,
          barangay: imp.barangay,
          studentType: imp.admissionType,
          strand: imp.strand,
        });
      }

      const sortedBuckets = Array.from(buckets.values()).sort(
        (a, b) => b.processedIds.length + b.importIds.length - (a.processedIds.length + a.importIds.length),
      );

      const topKeys = (map: Map<string, number>, limit = 3): string[] =>
        Array.from(map.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit)
          .map(([k]) => k);

      const groups: any[] = [];
      let googleCallsUsed = 0;

      // Process in non-blocking chunks of 50 groups so massive datasets never stall the Node event loop
      const CHUNK_SIZE = 50;
      for (let i = 0; i < sortedBuckets.length; i += CHUNK_SIZE) {
        const slice = sortedBuckets.slice(i, i + CHUNK_SIZE);
        if (i > 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }

        for (const bucket of slice) {
          const studentCount = bucket.processedIds.length + bucket.importIds.length;
          const consensusMunicipalities = topKeys(bucket.muniCounts, 3);
          const consensusProvinces = topKeys(bucket.provCounts, 3);
          const dominantStudentType = topKeys(bucket.typeCounts, 1)[0] || "Freshman";
          const consensusLocality =
            [consensusMunicipalities[0], consensusProvinces[0]].filter(Boolean).join(", ") || "Laguna / Unspecified";

          let status: "ready_high" | "ambiguous_review" | "suggested_review" | "unresolved" = "unresolved";
          let ambiguityReason: string | undefined;
          let proposal: any = null;
          const alternatives: any[] = [];

          // Case 0: Already linked to an existing school that NOW has coordinates
          const linkedSchool = bucket.linkedSchoolId ? schoolById.get(bucket.linkedSchoolId) : undefined;
          if (linkedSchool && hasCoordinates(linkedSchool)) {
            status = "ready_high";
            proposal = {
              existingSchoolId: linkedSchool.id,
              schoolId: linkedSchool.schoolId || undefined,
              schoolName: linkedSchool.schoolName,
              schoolType: linkedSchool.schoolType || "Public Senior High School",
              sector: linkedSchool.sector || "Public",
              barangay: linkedSchool.barangay || "",
              municipality: linkedSchool.municipality || "Laguna",
              province: linkedSchool.province || "Laguna",
              address: linkedSchool.address || [linkedSchool.municipality, linkedSchool.province].filter(Boolean).join(", "),
              latitude: linkedSchool.latitude!,
              longitude: linkedSchool.longitude!,
              source: "Registry / Alias",
              confidence: 99,
            };
          } else {
            // Tier 1: Existing School Registry & Aliases
            const regMatch = await registryMatcher.matchAsync(bucket.rawSchoolName, {
              municipality: consensusMunicipalities[0],
              province: consensusProvinces[0],
            });

            if (regMatch.status === "matched" && regMatch.school && hasCoordinates(regMatch.school)) {
              const s = regMatch.school;
              const conf = regMatch.confidence ?? 92;
              // Guard against homonym collisions across municipalities in existing registry
              const sameNameOthers = schoolsWithCoords.filter(
                (other) =>
                  other.id !== s.id &&
                  normalizeSchoolName(other.schoolName) === normalizeSchoolName(s.schoolName) &&
                  normalizeMunicipality(other.municipality) !== normalizeMunicipality(s.municipality),
              );

              proposal = {
                existingSchoolId: s.id,
                schoolId: s.schoolId || undefined,
                schoolName: s.schoolName,
                schoolType: s.schoolType || "Public Senior High School",
                sector: s.sector || "Public",
                barangay: s.barangay || "",
                municipality: s.municipality || "Laguna",
                province: s.province || "Laguna",
                address: s.address || [s.municipality, s.province].filter(Boolean).join(", "),
                latitude: s.latitude!,
                longitude: s.longitude!,
                source: "Registry / Alias",
                confidence: conf,
              };

              if (sameNameOthers.length > 0 && conf < 98) {
                status = "ambiguous_review";
                ambiguityReason = `Multiple registry entries match "${s.schoolName}" in different municipalities.`;
                for (const alt of sameNameOthers.slice(0, 3)) {
                  alternatives.push({
                    existingSchoolId: alt.id,
                    schoolId: alt.schoolId || undefined,
                    schoolName: alt.schoolName,
                    schoolType: alt.schoolType || "Public Senior High School",
                    sector: alt.sector || "Public",
                    barangay: alt.barangay || "",
                    municipality: alt.municipality || "Laguna",
                    province: alt.province || "Laguna",
                    address: alt.address || "",
                    latitude: alt.latitude!,
                    longitude: alt.longitude!,
                    source: "Registry / Alias",
                    confidence: 85,
                  });
                }
              } else {
                status = conf >= 92 ? "ready_high" : "suggested_review";
              }
            } else if (regMatch.suggestions && regMatch.suggestions.length > 0) {
              for (const sug of regMatch.suggestions.filter(hasCoordinates).slice(0, 3)) {
                alternatives.push({
                  existingSchoolId: sug.id,
                  schoolId: sug.schoolId || undefined,
                  schoolName: sug.schoolName,
                  schoolType: sug.schoolType || "Public Senior High School",
                  sector: sug.sector || "Public",
                  barangay: sug.barangay || "",
                  municipality: sug.municipality || "Laguna",
                  province: sug.province || "Laguna",
                  address: sug.address || "",
                  latitude: sug.latitude!,
                  longitude: sug.longitude!,
                  source: "Registry / Alias",
                  confidence: regMatch.confidence ?? 78,
                });
              }
            }

            // Tier 2: 25,562-School CAIR PH Unified Coordinates Dataset (Multi-Signal + Homonym Guard)
            if (status !== "ready_high") {
              const cairAnalysis = analyzeCairCandidates(bucket.rawSchoolName, {
                municipality: consensusMunicipalities[0],
                province: consensusProvinces[0],
                address: consensusLocality,
                studentType: dominantStudentType,
                consensusMunicipalities,
                consensusProvinces,
                hasShsStrand: bucket.shsStrandCount > 0,
              });

              if (cairAnalysis.best) {
                const cairProposal = {
                  existingSchoolId: linkedSchool?.id,
                  ...cairAnalysis.best,
                  source: "CAIR PH Dataset" as const,
                };

                if (!proposal || cairProposal.confidence > proposal.confidence || cairAnalysis.status === "ready_high") {
                  if (proposal) alternatives.unshift(proposal);
                  proposal = cairProposal;
                  status = cairAnalysis.status;
                  ambiguityReason = cairAnalysis.ambiguityReason;
                } else {
                  alternatives.push(cairProposal);
                }

                for (const alt of cairAnalysis.alternatives) {
                  if (alternatives.length < 5) {
                    alternatives.push({
                      ...alt,
                      source: "CAIR PH Dataset" as const,
                    });
                  }
                }
              } else if (!proposal && alternatives.length > 0) {
                proposal = alternatives.shift();
                status = "suggested_review";
              }
            }

            // Tier 3: Optional Google Maps Geocoding Fallback (only when requested, capped to protect quota)
            if (status === "unresolved" && includeGoogleFallback && googleCallsUsed < 35) {
              googleCallsUsed += 1;
              const geo = await geocodeSchoolPreview(bucket.rawSchoolName, consensusMunicipalities[0]);
              if (geo && Number.isFinite(geo.latitude) && Number.isFinite(geo.longitude)) {
                status = "suggested_review";
                proposal = {
                  existingSchoolId: linkedSchool?.id,
                  schoolName: bucket.rawSchoolName,
                  schoolType: /\b(college|university|institute)\b/i.test(bucket.rawSchoolName)
                    ? "Higher Education / College"
                    : "Public Senior High School",
                  sector: "Public",
                  barangay: "",
                  municipality: consensusMunicipalities[0] || "Laguna",
                  province: consensusProvinces[0] || "Laguna",
                  address: geo.displayName,
                  latitude: geo.latitude,
                  longitude: geo.longitude,
                  source: "Google Maps",
                  confidence: 86,
                };
              }
            }
          }

          groups.push({
            groupKey: bucket.groupKey,
            rawSchoolName: bucket.rawSchoolName,
            studentCount,
            processedIds: bucket.processedIds,
            importIds: bucket.importIds,
            sampleStudents: bucket.sampleStudents,
            consensusLocality,
            dominantStudentType,
            status,
            ambiguityReason,
            proposal,
            alternatives: alternatives.slice(0, 5),
          });
        }
      }

      const totalStudents = allProcessed.length;
      const totalUnmappedStudents = groups.reduce((acc, g) => acc + g.studentCount, 0);
      const readyHighGroups = groups.filter((g) => g.status === "ready_high").length;
      const readyHighStudents = groups
        .filter((g) => g.status === "ready_high")
        .reduce((acc, g) => acc + g.studentCount, 0);
      const reviewGroups = groups.filter(
        (g) => g.status === "ambiguous_review" || g.status === "suggested_review",
      ).length;
      const reviewStudents = groups
        .filter((g) => g.status === "ambiguous_review" || g.status === "suggested_review")
        .reduce((acc, g) => acc + g.studentCount, 0);
      const unresolvedGroups = groups.filter((g) => g.status === "unresolved").length;
      const unresolvedStudents = groups
        .filter((g) => g.status === "unresolved")
        .reduce((acc, g) => acc + g.studentCount, 0);

      const currentlyMapped = Math.max(0, totalStudents - unmappedProcessed.length);
      const projectedMappedPercent =
        totalStudents === 0
          ? 100
          : Math.min(100, Math.round(((currentlyMapped + readyHighStudents) / totalStudents) * 100));

      res.json({
        summary: {
          totalStudents,
          totalUnmappedStudents,
          totalGroups: groups.length,
          readyHighGroups,
          readyHighStudents,
          reviewGroups,
          reviewStudents,
          unresolvedGroups,
          unresolvedStudents,
          projectedMappedPercent,
        },
        groups,
      });
    } catch (err: any) {
      console.error("[unmapped/generate-plan] error:", err);
      res.status(500).json({ message: err?.message || "Failed to generate smart mapping plan" });
    }
  });

  app.post("/api/admin/unmapped/apply-plan", isAdmin, writeLimiter, async (req, res) => {
    try {
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      if (items.length === 0) {
        return res.status(400).json({ message: "No mapping items provided" });
      }

      const db = getDb();
      let existingSchools = await storage.listSchoolRegistry();
      let resolvedGroups = 0;
      let resolvedStudents = 0;
      let schoolsCreated = 0;

      const ID_BATCH_SIZE = 500;

      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        if (idx > 0 && idx % 25 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }

        const rawSchoolName = String(item?.rawSchoolName || "").trim();
        if (!rawSchoolName) continue;

        let targetSchool: (typeof existingSchools)[number] | undefined = undefined;

        if (item.existingSchoolId) {
          targetSchool = existingSchools.find((s) => s.id === Number(item.existingSchoolId));
          // If the existing school lacked coordinates and the proposal supplied valid ones, enrich it
          if (
            targetSchool &&
            !hasCoordinates(targetSchool) &&
            item.school &&
            Number.isFinite(Number(item.school.latitude)) &&
            Number.isFinite(Number(item.school.longitude))
          ) {
            targetSchool = await storage.updateSchoolRegistry(targetSchool.id, {
              latitude: Number(item.school.latitude),
              longitude: Number(item.school.longitude),
              municipality: item.school.municipality || targetSchool.municipality,
              province: item.school.province || targetSchool.province,
              barangay: item.school.barangay || targetSchool.barangay,
              source: item.school.source || "CAIR PH Unified Coordinates",
              isActive: true,
            });
          }
        }

        if (!targetSchool && item.school) {
          const lat = Number(item.school.latitude);
          const lng = Number(item.school.longitude);
          // Coordinate & PH-bounds sanity guard
          if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
            continue;
          }

          const schoolName = String(item.school.schoolName || rawSchoolName).trim();
          const normTarget = normalizeSchoolName(schoolName);
          const muniTarget = normalizeMunicipality(item.school.municipality || "");

          // Deduplicate against already-created or existing schools
          targetSchool = existingSchools.find(
            (s) =>
              !s.deletedAt &&
              ((item.school.schoolId && s.schoolId === item.school.schoolId) ||
                (normalizeSchoolName(s.schoolName) === normTarget &&
                  normalizeMunicipality(s.municipality) === muniTarget)),
          );

          if (!targetSchool) {
            targetSchool = await storage.createSchoolRegistry({
              schoolId: item.school.schoolId || null,
              schoolName,
              normalizedSchoolName: normTarget,
              schoolType: item.school.schoolType || "Public Senior High School",
              sector: item.school.sector || "Public",
              barangay: item.school.barangay || null,
              municipality: item.school.municipality || "Laguna",
              province: item.school.province || "Laguna",
              address: item.school.address || null,
              latitude: lat,
              longitude: lng,
              source: item.school.source || "CAIR PH Unified Coordinates",
              isActive: true,
            });
            existingSchools.push(targetSchool);
            schoolsCreated += 1;
          }
        }

        if (!targetSchool || !hasCoordinates(targetSchool)) continue;

        // Self-learning alias + match history
        const rawNorm = normalizeSchoolName(rawSchoolName);
        if (rawNorm) {
          const existingAlias = await db
            .select()
            .from(schoolAliases)
            .where(eq(schoolAliases.normalizedAlias, rawNorm))
            .limit(1);
          if (existingAlias.length === 0 && rawNorm !== normalizeSchoolName(targetSchool.schoolName)) {
            await db
              .insert(schoolAliases)
              .values({
                schoolRegistryId: targetSchool.id,
                aliasName: rawSchoolName,
                normalizedAlias: rawNorm,
              })
              .catch(() => { });
          }
        }

        const existingHist = await db
          .select()
          .from(schoolMatchHistory)
          .where(eq(schoolMatchHistory.importedName, rawSchoolName))
          .limit(1);
        if (existingHist.length > 0) {
          await db
            .update(schoolMatchHistory)
            .set({
              occurrences: existingHist[0].occurrences + 1,
              officialSchoolId: targetSchool.id,
            })
            .where(eq(schoolMatchHistory.id, existingHist[0].id));
        } else {
          await db
            .insert(schoolMatchHistory)
            .values({
              importedName: rawSchoolName,
              officialSchoolId: targetSchool.id,
              resolvedBy: "Smart Mapper",
            })
            .catch(() => { });
        }

        // Chunked batch updates on students_processed (500 IDs per batch)
        const processedIds: number[] = Array.isArray(item.processedIds)
          ? item.processedIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
          : [];

        if (processedIds.length > 0) {
          for (let b = 0; b < processedIds.length; b += ID_BATCH_SIZE) {
            const idChunk = processedIds.slice(b, b + ID_BATCH_SIZE);
            await db
              .update(studentsProcessed)
              .set({
                schoolRegistryId: targetSchool.id,
                lastSchoolType: targetSchool.schoolType || null,
                mappingStatus: "mapped",
              })
              .where(inArray(studentsProcessed.id, idChunk));
          }
          resolvedStudents += processedIds.length;
        } else {
          await db
            .update(studentsProcessed)
            .set({
              schoolRegistryId: targetSchool.id,
              lastSchoolType: targetSchool.schoolType || null,
              mappingStatus: "mapped",
            })
            .where(
              and(
                isNull(studentsProcessed.schoolRegistryId),
                or(
                  eq(studentsProcessed.lastSchoolName, rawSchoolName),
                  eq(studentsProcessed.previousSchool, rawSchoolName),
                ),
              ),
            );
        }

        // Also resolve matching staging rows if any
        await db
          .update(studentImports)
          .set({
            importStatus: "Matched",
            matchedSchoolId: targetSchool.id,
            matchRule: "smart-mapper",
            matchConfidence: 100,
          })
          .where(
            and(
              eq(studentImports.previousSchool, rawSchoolName),
              eq(studentImports.importStatus, "Unmatched"),
            ),
          );

        resolvedGroups += 1;
      }

      enterpriseCache.invalidate("gis:");
      enterpriseCache.invalidate("schools:");
      await logAuditEvent(
        {
          action: "UPDATE",
          targetResource: "students_processed",
          details: `Smart Mapper resolved ${resolvedGroups} school groups (${resolvedStudents} students, ${schoolsCreated} new schools)`,
        },
        req,
      );

      res.json({
        success: true,
        resolvedGroups,
        resolvedStudents,
        schoolsCreated,
      });
    } catch (err: any) {
      console.error("[unmapped/apply-plan] error:", err);
      res.status(500).json({ message: err?.message || "Failed to apply smart mapping plan" });
    }
  });

  app.post("/api/imports/apply", isAdmin, uploadLimiter, async (req, res) => {
    const db = getDb();

    // Apply records that are Matched or Unmatched
    const matchedRecords = await db.select().from(studentImports)
      .where(inArray(studentImports.importStatus, ["Matched", "Unmatched"]));

    for (const record of matchedRecords) {
      await db.insert(studentsProcessed).values({
        studentNumber: record.studentNumber,
        fullName: record.fullName,
        course: record.program,
        strand: record.strand,
        admissionType: record.admissionType || "Freshman",
        lastSchoolName: record.previousSchool || "Unknown",
        lastSchoolType: "Unknown",
        schoolRegistryId: record.matchedSchoolId,
        municipality: record.municipality || "Laguna",
        province: "Laguna",
        enrollmentStatus: record.enrollmentStatus === "OE" ? "Officially Enrolled" :
          record.enrollmentStatus === "NOE" ? "Not Officially Enrolled" :
            (record.enrollmentStatus || "For Verification"),
        importedSource: record.importSource,
        mappingStatus: "verified",
      });

      await db.update(studentImports).set({ importStatus: "Applied" }).where(eq(studentImports.id, record.id));
    }

    enterpriseCache.invalidate("gis:");
    res.json({ success: true, appliedCount: matchedRecords.length });
  });

  app.get("/api/settings/diagnostics", isAdmin, async (req, res) => {
    const db = getDb();

    const registryCount = await db.select({ value: count() }).from(schoolRegistry).where(and(
      isNull(schoolRegistry.deletedAt),
      or(isNull(schoolRegistry.schoolType), ne(schoolRegistry.schoolType, "Barangay")),
    ));
    const aliasCount = await db.select({ value: count() }).from(schoolAliases);

    const matchedCount = await db.select({ value: count() }).from(studentImports).where(eq(studentImports.importStatus, "Matched"));
    const unmatchedCount = await db.select({ value: count() }).from(studentImports).where(eq(studentImports.importStatus, "Unmatched"));
    const appliedCount = await db.select({ value: count() }).from(studentImports).where(eq(studentImports.importStatus, "Applied"));
    const [confidence] = await db.select({ value: avg(studentImports.matchConfidence) })
      .from(studentImports)
      .where(inArray(studentImports.importStatus, ["Matched", "Applied"]));

    const totalProcessed = matchedCount[0].value + unmatchedCount[0].value + appliedCount[0].value;
    const successRate = totalProcessed === 0 ? 0 : Math.round(((matchedCount[0].value + appliedCount[0].value) / totalProcessed) * 100);

    res.json({
      schoolRegistryCount: registryCount[0].value,
      aliasCount: aliasCount[0].value,
      matchedRecords: matchedCount[0].value,
      unmatchedRecords: unmatchedCount[0].value,
      appliedRecords: appliedCount[0].value,
      importSuccessRate: successRate,
      averageConfidence: confidence.value == null ? null : Math.round(Number(confidence.value)),
      systemHealth: "Database reachable",
      locationProviders: {
        localDirectory: registryCount[0].value > 0,
        googleGeocodingConfigured: Boolean(process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY),
      },
    });
  });

  app.get("/api/imports/logs", isAdmin, async (req, res) => {
    const logs = await getImportLogs(100);
    res.json(logs);
  });

  app.post(api.integrations.preview.path, isAdmin, uploadLimiter, async (req, res) => {
    try {
      const input = api.integrations.preview.input.parse(req.body);
      const preview = await previewIntegrationSource(input);
      res.json(preview);
    } catch (err) {
      console.error("[previewIntegrationSource] error:", err);
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      if (err instanceof Error) return res.status(400).json({ message: err.message });
      throw err;
    }
  });

  app.post(api.geocode.school.path, isAdmin, writeLimiter, async (req, res) => {
    try {
      const parsed = api.geocode.school.input.safeParse(req.body);
      if (!parsed.success) {
        const message =
          parsed.error.errors[0]?.message ||
          "School name is required";
        return res.status(400).json({ success: false as const, message });
      }

      const { name, municipality } = parsed.data;

      const result = await geocodeSchoolPreview(name, municipality);
      if (!result) {
        return res.status(404).json({
          success: false as const,
          message: "No coordinates found for this school.",
        });
      }

      return res.json({
        success: true as const,
        ...result,
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        const message = err.errors[0]?.message || "School name is required";
        return res.status(400).json({ success: false as const, message });
      }
      if (err instanceof Error) {
        console.error("[geocode] unexpected error:", err.message);
        return res.status(500).json({
          success: false as const,
          message: "Geolocation service error. Try again or enter coordinates manually.",
        });
      }
      throw err;
    }
  });

  app.get(api.geocode.suggest.path, async (req, res) => {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) {
      return res.json({ registry: [] });
    }

    const exactLocal = await lookupSchoolInRegistry(q);
    const registryMatches = await searchSchools(q, 8);
    const registry = exactLocal
      ? [exactLocal.school, ...registryMatches.filter((school) => school.id !== exactLocal.school.id)]
      : registryMatches;

    res.json({ registry });
  });

  app.get(api.mapping.queue.path, async (_req, res) => {
    const queue = await getMappingQueue();
    res.json(queue);
  });

  app.post(api.mapping.verify.path, isAdmin, writeLimiter, async (req, res) => {
    try {
      const input = api.mapping.verify.input.parse(req.body);
      const school = await verifySchoolMapping(input);
      enterpriseCache.invalidate("schools:");
      enterpriseCache.invalidate("gis:");
      res.json(school);
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      if (err instanceof Error) return res.status(404).json({ message: err.message });
      throw err;
    }
  });

  app.post(api.gis.studentsSync.path, isAdmin, uploadLimiter, async (req, res) => {
    try {
      const input = api.gis.studentsSync.input.parse(req.body);
      const result = await syncStudents(input.records, input.source);
      enterpriseCache.invalidate("gis:");
      res.json(result);
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      if (err instanceof Error) return res.status(400).json({ message: err.message });
      throw err;
    }
  });

  app.get(api.gis.processedStudents.path, async (_req, res) => {
    const rows = await getProcessedStudents();
    res.json(rows);
  });

  app.post(api.gis.batchDeleteStudents.path, isAdmin, writeLimiter, async (req, res) => {
    try {
      const input = api.gis.batchDeleteStudents.input.parse(req.body);
      const result = await storage.batchDeleteProcessedStudents(input.ids);
      await recomputeSchoolStudentCounts();
      enterpriseCache.invalidate("gis:");
      await logAuditEvent({ action: "DELETE", targetResource: "students_processed", details: `Batch deleted ${result.deletedCount} students` }, req);
      res.json({
        success: true,
        deletedCount: result.deletedCount,
        skippedCount: 0,
        message: `Successfully deleted ${result.deletedCount} students.`
      });
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ success: false, deletedCount: 0, skippedCount: 0, message: err.errors[0].message });
      if (err instanceof Error) return res.status(500).json({ success: false, deletedCount: 0, skippedCount: 0, message: err.message });
      throw err;
    }
  });

  app.patch(api.gis.updateProcessedStudent.path, isAdmin, writeLimiter, async (req, res) => {
    try {
      const id = parsePositiveIntId(req.params.id);
      if (!id) return res.status(400).json({ message: "Invalid student ID" });
      const input = api.gis.updateProcessedStudent.input.parse(req.body);
      const updated = await updateProcessedStudent(id, input);
      enterpriseCache.invalidate("gis:");
      res.json(updated);
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      if (err instanceof Error) return res.status(404).json({ message: err.message });
      throw err;
    }
  });

  app.post(api.gis.batchUpdateStudentStatus.path, isAdmin, writeLimiter, async (req, res) => {
    try {
      const input = api.gis.batchUpdateStudentStatus.input.parse(req.body);
      const result = await batchUpdateProcessedStudentStatus(input.ids, input.enrollmentStatus);
      enterpriseCache.invalidate("gis:");
      const action = input.enrollmentStatus === "Archived" ? "archived" : "updated";
      res.json({
        success: true,
        deletedCount: result.updatedCount,
        skippedCount: 0,
        message: `Successfully ${action} ${result.updatedCount} students.`,
      });
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ success: false, deletedCount: 0, skippedCount: 0, message: err.errors[0].message });
      if (err instanceof Error) return res.status(500).json({ success: false, deletedCount: 0, skippedCount: 0, message: err.message });
      throw err;
    }
  });

  app.get(api.gis.mapData.path, async (req, res) => {
    try {
      const input = api.gis.mapData.input.parse({
        scholarships: req.query.scholarships,
        programs: req.query.programs
      });

      const toArray = (val?: string | string[]) => {
        if (!val) return undefined;
        return Array.isArray(val) ? val : [val];
      };

      const scholArr = toArray(input.scholarships);
      const progArr = toArray(input.programs);
      const cacheKey = `gis:map:${JSON.stringify(scholArr || [])}:${JSON.stringify(progArr || [])}`;
      const mapData = await enterpriseCache.getOrSet(cacheKey, 60, () =>
        getGisMapData(scholArr, progArr),
      );
      res.json(mapData);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid filter parameters", errors: err.errors });
        return;
      }
      res.status(500).json({ message: "Failed to fetch map data" });
    }
  });

  app.get(api.gis.overview.path, async (_req, res) => {
    const stats = await enterpriseCache.getOrSet("gis:overview", 60, () => getGisOverviewStats());
    res.json(stats);
  });

  app.get(api.gis.importLogs.path, async (_req, res) => {
    const logs = await getImportLogs();
    res.json(logs);
  });

  app.post(api.gis.batchDeleteImports.path, isAdmin, writeLimiter, async (req, res) => {
    try {
      const input = api.gis.batchDeleteImports.input.parse(req.body);
      const result = await storage.batchDeleteImports(input.ids);
      res.json({
        success: true,
        deletedCount: result.deletedCount,
        skippedCount: 0,
        message: `Successfully deleted ${result.deletedCount} import logs and associated data.`
      });
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ success: false, deletedCount: 0, skippedCount: 0, message: err.errors[0].message });
      if (err instanceof Error) return res.status(500).json({ success: false, deletedCount: 0, skippedCount: 0, message: err.message });
      throw err;
    }
  });

  // Student routes
  app.post("/api/students/processed/archive-all", isAdmin, writeLimiter, async (req, res) => {
    try {
      const db = getDb();
      // Update all students that are not currently archived or have null statuses
      await db.update(studentsProcessed)
        .set({
          enrollmentStatus: "Archived",
          archivedAt: new Date()
        })
        .where(
          or(
            not(eq(studentsProcessed.enrollmentStatus, "Archived")),
            isNull(studentsProcessed.enrollmentStatus)
          )
        );

      // Clear the staging area so new imports start fresh
      await db.delete(studentImports);
      enterpriseCache.invalidate("gis:");
      await logAuditEvent({ action: "UPDATE", targetResource: "students_processed", details: "Archived all active student records and cleared import staging" }, req);

      res.json({ success: true, message: "Successfully archived all current student records." });
    } catch (err) {
      console.error("Archive error:", err);
      res.status(500).json({ success: false, message: "Failed to archive student data." });
    }
  });

  app.post("/api/admin/verify-password", isAdmin, authLimiter, async (req, res) => {
    if (!req.user) return res.status(401).json({ success: false, message: "Unauthorized" });
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!password) return res.status(400).json({ success: false, message: "Password is required" });

    try {
      const db = getDb();
      const [user] = await db.select().from(users).where(eq(users.id, req.user.id)).limit(1);

      if (!user) return res.status(401).json({ success: false, message: "User not found" });

      const isValid = await comparePasswords(password, user.password);
      if (isValid) {
        return res.json({ success: true });
      } else {
        return res.status(401).json({ success: false, message: "Incorrect password" });
      }
    } catch (err) {
      console.error("Verify password error:", err);
      return res.status(500).json({ success: false, message: "Verification failed" });
    }
  });

  app.get("/api/students", isAdmin, async (req, res) => {
    const studentsList = await storage.getStudents();
    res.json(studentsList);
  });

  app.get(api.students.getByNumber.path, publicApiLimiter, async (req, res) => {
    const rawNum = Array.isArray(req.params.studentNumber) ? req.params.studentNumber[0] : req.params.studentNumber;
    const studentNumber = (rawNum || "").trim();
    if (!studentNumber) return res.status(400).json({ message: "Student number is required." });

    const db = getDb();
    // Verify student exists in official processed Trimex student records
    const [official] = await db
      .select()
      .from(studentsProcessed)
      .where(eq(studentsProcessed.studentNumber, studentNumber))
      .limit(1);

    if (!official) {
      return res.status(404).json({
        message: "Student number not found in official Trimex student records. Non-students can use the Non-Student / Public tab.",
      });
    }

    let student = await storage.getStudentByNumber(studentNumber);
    if (!student) {
      // Auto-provision referral profile for verified official Trimex student
      const referralCode = `TRX-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
      student = await storage.createStudent({
        studentNumber: official.studentNumber,
        name: official.fullName,
        referralCode,
      });
    }

    res.json({
      ...student,
      verified: true,
      course: official.course,
      enrollmentStatus: official.enrollmentStatus,
    });
  });

  app.get(api.students.getByCode.path, publicApiLimiter, async (req, res) => {
    const rawCode = Array.isArray(req.params.referralCode) ? req.params.referralCode[0] : req.params.referralCode;
    const referralCode = (rawCode || "").trim();
    const student = await storage.getStudentByCode(referralCode);
    if (!student) return res.status(404).json({ message: "Referral code not found" });
    res.json(student);
  });

  app.post(api.students.register.path, publicApiLimiter, async (req, res) => {
    try {
      const input = api.students.register.input.parse(req.body);
      const studentNumber = input.studentNumber.trim();
      const db = getDb();

      // Enforce that only verified Trimex students in `students_processed` can register in the Student Portal
      const [official] = await db
        .select()
        .from(studentsProcessed)
        .where(eq(studentsProcessed.studentNumber, studentNumber))
        .limit(1);

      if (!official) {
        return res.status(403).json({
          message: "Student number is not in official Trimex student records. Please use the Non-Student / Public tab instead.",
        });
      }

      const existing = await storage.getStudentByNumber(studentNumber);
      if (existing) {
        return res.status(200).json({ ...existing, verified: true });
      }

      const referralCode = input.referralCode?.trim() || `TRX-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
      const student = await storage.createStudent({
        studentNumber: official.studentNumber,
        name: official.fullName,
        referralCode,
      });
      res.status(201).json({ ...student, verified: true });
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      throw err;
    }
  });

  // Student Referral routes (server-side owner scoping / MySQL RLS equivalent)
  app.get(api.referrals.list.path, publicApiLimiter, async (req, res) => {
    const callerIsAdmin = Boolean(req.isAuthenticated && req.isAuthenticated() && (req.user as any)?.role === "admin");
    if (callerIsAdmin) {
      const referralsList = await storage.getReferrals();
      return res.json(referralsList);
    }

    // For non-admin student portal callers, enforce strict owner-only scoping
    const rawReferrerId = typeof req.query.referrerId === "string" ? parsePositiveIntId(req.query.referrerId) : null;
    const studentNumber = typeof req.query.studentNumber === "string" ? req.query.studentNumber.trim() : "";

    if (rawReferrerId) {
      const ownReferrals = await storage.getReferralsByStudent(rawReferrerId);
      return res.json(ownReferrals);
    }

    if (studentNumber) {
      const student = await storage.getStudentByNumber(studentNumber);
      if (!student) return res.status(404).json({ message: "Student not found" });
      const ownReferrals = await storage.getReferralsByStudent(student.id);
      return res.json(ownReferrals);
    }

    return res.status(401).json({ message: "Authentication or student identifier required to view referrals." });
  });

  app.get("/api/test", (_req, res) => {
    res.json({ status: "ok", message: "Backend is running" });
  });

  app.post(api.referrals.create.path, publicApiLimiter, async (req, res) => {
    try {
      const input = api.referrals.create.input.parse(req.body);
      const referral = await storage.createReferral(input);
      res.status(201).json(referral);
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      throw err;
    }
  });

  app.patch(api.referrals.update.path, isAdmin, writeLimiter, async (req, res) => {
    try {
      const id = parsePositiveIntId(req.params.id);
      if (!id) return res.status(400).json({ message: "Invalid referral ID" });
      const input = api.referrals.update.input.parse(req.body);
      const referral = await storage.updateReferral(id, input);
      if (!referral) return res.status(404).json({ message: 'Referral not found' });
      res.json(referral);
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      throw err;
    }
  });

  app.delete(api.referrals.delete.path, isAdmin, writeLimiter, async (req, res) => {
    const id = parsePositiveIntId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid referral ID" });
    await storage.deleteReferral(id);
    res.status(204).send();
  });

  // Separate Non-Student Public Referrals API (isolated in `public_referrals` table)
  app.post("/api/public-referrals", publicApiLimiter, async (req, res) => {
    try {
      const parsed = insertPublicReferralSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid public referral data" });
      }
      const db = getDb();
      const [result] = await db.insert(publicReferrals).values(parsed.data);
      const [created] = await db
        .select()
        .from(publicReferrals)
        .where(eq(publicReferrals.id, (result as any).insertId))
        .limit(1);
      res.status(201).json(created);
    } catch (err) {
      console.error("[POST /api/public-referrals] error:", err);
      res.status(500).json({ message: "Failed to submit public referral" });
    }
  });

  app.get("/api/public-referrals", isAdmin, async (_req, res) => {
    try {
      const db = getDb();
      const rows = await db
        .select()
        .from(publicReferrals)
        .where(isNull(publicReferrals.deletedAt))
        .orderBy(desc(publicReferrals.createdAt));
      res.json(rows);
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch public referrals" });
    }
  });

  app.patch("/api/public-referrals/:id", isAdmin, writeLimiter, async (req, res) => {
    try {
      const id = parsePositiveIntId(req.params.id);
      if (!id) return res.status(400).json({ message: "Invalid public referral ID" });
      const parsed = publicReferralPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid update payload" });
      }
      const db = getDb();
      await db.update(publicReferrals).set(parsed.data).where(eq(publicReferrals.id, id));
      const [updated] = await db.select().from(publicReferrals).where(eq(publicReferrals.id, id)).limit(1);
      if (!updated) return res.status(404).json({ message: "Public referral not found" });
      res.json(updated);
    } catch (err) {
      res.status(500).json({ message: "Failed to update public referral" });
    }
  });

  app.delete("/api/public-referrals/:id", isAdmin, writeLimiter, async (req, res) => {
    try {
      const id = parsePositiveIntId(req.params.id);
      if (!id) return res.status(400).json({ message: "Invalid public referral ID" });
      const db = getDb();
      await db.delete(publicReferrals).where(eq(publicReferrals.id, id));
      res.status(204).send();
    } catch (err) {
      res.status(500).json({ message: "Failed to delete public referral" });
    }
  });

  return httpServer;
}

export async function seedDatabase() {
  const db = getDb();
  await db.delete(mappingLogs);
  await db.delete(schoolAliases);
  await db.delete(studentsProcessed);
  await db.delete(studentsRaw);
  await db.delete(imports);
  await db.delete(schoolsTable);

  const testSchools = [
    { schoolName: "Trimex Colleges", latitude: 14.339063, longitude: 121.085351, municipality: "Biñan", province: "Laguna" },
    { schoolName: "Laguna Senior High School", latitude: 14.2782, longitude: 121.4163, municipality: "Santa Cruz", province: "Laguna" },
    { schoolName: "Biñan City Senior High School - San Antonio Campus", latitude: 14.3227, longitude: 121.0793, municipality: "Biñan", province: "Laguna" },
    { schoolName: "Calamba City Senior High School", latitude: 14.2117, longitude: 121.1653, municipality: "Calamba", province: "Laguna" },
    { schoolName: "Pagsanjan Stand-Alone Senior High School", latitude: 14.2738, longitude: 121.4558, municipality: "Pagsanjan", province: "Laguna" },
  ];

  for (const school of testSchools) {
    await storage.createSchoolRegistry({
      ...school,
      schoolType: school.schoolName.includes("Colleges") ? "College" : "Senior High School",
      // altitude: null,

      isActive: true,
      source: "5-School Test Dataset",
    });
  }

  const seededSchools = await storage.listSchoolRegistry();
  const schoolByName = new Map(seededSchools.map((school) => [school.schoolName, school]));
  const [importResult] = await db.insert(imports).values({
    source: "5-school-test-dataset",
    status: "completed",
    importedCount: 5,
    failedCount: 0,
    completedAt: new Date(),
    notes: "Reliable 5-school / 5-student map test dataset",
  });
  const importRow = await db.select().from(imports).where(eq(imports.id, importResult.insertId)).limit(1).then(r => r[0]);

  const testStudents = [
    {
      studentNumber: "26-0001",
      fullName: "Juan Dela Cruz",
      course: "BSIT MWD",
      lastSchoolName: "Trimex Colleges",
      lastSchoolType: "College",
      studentType: "Freshman",
      municipality: "Biñan",
      province: "Laguna",
      enrollmentStatus: "Active",
    },
    {
      studentNumber: "26-0002",
      fullName: "Maria Santos",
      course: "BSBA FM",
      lastSchoolName: "Laguna Senior High School",
      lastSchoolType: "Senior High School",
      studentType: "Freshman",
      municipality: "Santa Cruz",
      province: "Laguna",
      enrollmentStatus: "Active",
    },
    {
      studentNumber: "26-0003",
      fullName: "Carlo Reyes",
      course: "BSCPE",
      lastSchoolName: "Biñan City Senior High School - San Antonio Campus",
      lastSchoolType: "Senior High School",
      studentType: "Freshman",
      municipality: "Biñan",
      province: "Laguna",
      enrollmentStatus: "Active",
    },
    {
      studentNumber: "26-0004",
      fullName: "Angela Cruz",
      course: "BTVTE FSM",
      lastSchoolName: "Calamba City Senior High School",
      lastSchoolType: "Senior High School",
      studentType: "Freshman",
      municipality: "Calamba",
      province: "Laguna",
      enrollmentStatus: "Active",
    },
    {
      studentNumber: "26-0005",
      fullName: "Mark Garcia",
      course: "BSA",
      lastSchoolName: "Pagsanjan Stand-Alone Senior High School",
      lastSchoolType: "Senior High School",
      studentType: "Freshman",
      municipality: "Pagsanjan",
      province: "Laguna",
      enrollmentStatus: "Active",
    },
  ];

  for (const student of testStudents) {
    const [rawResult] = await db.insert(studentsRaw).values({
      importId: importRow.id,
      studentNumber: student.studentNumber,
      fullName: student.fullName,
      course: student.course,
      lastSchoolName: student.lastSchoolName,
      lastSchoolType: student.lastSchoolType,
      studentType: student.studentType,
      municipality: student.municipality,
      rawPayload: JSON.stringify(student),
    });
    const raw = await db.select().from(studentsRaw).where(eq(studentsRaw.id, rawResult.insertId)).limit(1).then(r => r[0]);

    await db.insert(studentsProcessed).values({
      rawId: raw.id,
      studentNumber: student.studentNumber,
      fullName: student.fullName,
      course: student.course,
      admissionType: "Freshman",
      lastSchoolName: student.lastSchoolName,
      lastSchoolType: student.lastSchoolType,
      schoolRegistryId: schoolByName.get(student.lastSchoolName)?.id ?? null,
      municipality: student.municipality,
      province: student.province,
      enrollmentStatus: student.enrollmentStatus,
      importedSource: "API",
      mappingStatus: "verified",
    });
  }

  await recomputeSchoolStudentCounts();
}
