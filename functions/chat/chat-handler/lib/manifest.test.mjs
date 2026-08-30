import { describe, it, expect } from "vitest";
import { buildManifest, renderManifest } from "./manifest.mjs";
import { createFixtureRepository, buildFixtureData, TODAY } from "../../../../evals/chat/fixtures.mjs";

describe("data availability manifest", () => {
  it("reports exactly which periods hold data", async () => {
    const manifest = await buildManifest(createFixtureRepository(), "tenant-fixture");

    expect(manifest.connected).toBe(true);
    expect(manifest.months.map((m) => m.month)).toEqual(["2026-05", "2026-06", "2026-07", "2026-08"]);
    expect(manifest.earliestMonth).toBe("2026-05");
    expect(manifest.latestMonth).toBe("2026-08");
    expect(manifest.latestDateWithData).toBe("2026-08-14");
    expect(manifest.topServices[0]).toBe("AmazonEC2");
    expect(manifest.alertCount).toBe(2);
  });

  it("issues its three reads without pulling the heavy per-row items", async () => {
    const repo = createFixtureRepository();
    await buildManifest(repo, "tenant-fixture");

    expect(repo.calls.map((c) => c.op).sort()).toEqual(["countAlerts", "getTenant", "listMonths"]);
  });

  it("returns null for a tenant that does not exist", async () => {
    const repo = createFixtureRepository();
    repo.getTenant = async () => null;

    expect(await buildManifest(repo, "nobody")).toBeNull();
  });

  it("survives an alerts table failure rather than failing the whole request", async () => {
    const repo = createFixtureRepository();
    repo.countAlerts = async () => {
      throw new Error("table unavailable");
    };

    const manifest = await buildManifest(repo, "tenant-fixture");
    expect(manifest.alertCount).toBe(0);
  });

  describe("rendering", () => {
    it("lists the months and forbids querying anything else", async () => {
      const manifest = await buildManifest(createFixtureRepository(), "tenant-fixture");
      const text = renderManifest(manifest, TODAY);

      expect(text).toContain("Today's date (UTC): 2026-08-15");
      expect(text).toContain("2026-05, 2026-06, 2026-07, 2026-08");
      expect(text).toContain("Most recent day with data: 2026-08-14");
      expect(text).toMatch(/Never query a month that is not listed/);
    });

    it("tells the model not to call tools at all when AWS is not connected", async () => {
      const data = buildFixtureData();
      data.tenant.connectionStatus = "NOT_CONNECTED";
      const manifest = await buildManifest(createFixtureRepository(data), "tenant-fixture");

      const text = renderManifest(manifest, TODAY);
      expect(text).toContain("NOT CONNECTED");
      expect(text).toMatch(/Do not call cost tools/);
      expect(text).not.toContain("Months with cost data");
    });

    it("distinguishes connected-but-no-data-yet from not connected", async () => {
      const data = buildFixtureData();
      data.monthRollups = {};
      data.daysByMonth = {};
      const manifest = await buildManifest(createFixtureRepository(data), "tenant-fixture");

      const text = renderManifest(manifest, TODAY);
      expect(text).toContain("connected");
      expect(text).toMatch(/no billing export has been processed/);
    });
  });
});
