import { and, eq } from "drizzle-orm";
import { barangayRegistry, systemSettings } from "@shared/schema";
import { cleanBarangayText, canonicalBarangayName } from "@shared/scholarBarangayResolver";
import { normalizeMunicipality } from "@shared/schoolRegistry";
import { getDb } from "./db";
import directory from "./data/laguna-barangay-points.json";

const syncKey = "__laguna_barangay_directory_psgc_2026_q3";

export async function syncLagunaBarangayDirectory(): Promise<void> {
  const db = getDb();
  const [version] = await db.select({ value: systemSettings.value }).from(systemSettings)
    .where(eq(systemSettings.key, syncKey)).limit(1);
  if (version?.value === directory.release) return;

  await db.transaction(async tx => {
    await tx.insert(systemSettings).values({
      key: syncKey,
      value: "",
      description: "Laguna barangay directory and representative boundary points",
    }).onDuplicateKeyUpdate({ set: { key: syncKey } });
    const [version] = await tx.select({ value: systemSettings.value }).from(systemSettings)
      .where(eq(systemSettings.key, syncKey)).limit(1);
    if (version.value === directory.release) return;

    const existing = await tx.select().from(barangayRegistry)
      .where(eq(barangayRegistry.province, "Laguna"));
    const rowsByKey = new Map(existing.map(row => [
      `${normalizeMunicipality(row.municipality)}|${canonicalBarangayName(row.barangayName, row.municipality)}`,
      row,
    ]));

    for (const entry of directory.barangays) {
      const normalizedName = cleanBarangayText(entry.barangayName);
      const row = rowsByKey.get(`${normalizeMunicipality(entry.municipality)}|${normalizedName}`);
      const values = {
        barangayName: entry.barangayName,
        normalizedName,
        municipality: entry.municipality,
        latitude: entry.latitude,
        longitude: entry.longitude,
        updatedAt: new Date(),
      };
      if (row) {
        await tx.update(barangayRegistry).set(values).where(eq(barangayRegistry.id, row.id));
      } else {
        await tx.insert(barangayRegistry).values({ province: "Laguna", ...values });
      }
    }

    await tx.update(barangayRegistry).set({ isActive: false, updatedAt: new Date() }).where(and(
      eq(barangayRegistry.province, "Laguna"),
      eq(barangayRegistry.municipality, "Laguna"),
      eq(barangayRegistry.barangayName, "Unmapped / Special Cases"),
    ));
    await tx.update(systemSettings).set({ value: directory.release, updatedAt: new Date() })
      .where(eq(systemSettings.key, syncKey));
  });
}
