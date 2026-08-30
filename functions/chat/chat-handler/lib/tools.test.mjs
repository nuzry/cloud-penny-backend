import { describe, it, expect } from "vitest";
import { createTools } from "./tools.mjs";
import { buildManifest } from "./manifest.mjs";
import { createFixtureRepository, buildFixtureData, TODAY } from "../../../../evals/chat/fixtures.mjs";

async function setup(data) {
  const repo = createFixtureRepository(data);
  const manifest = await buildManifest(repo, "tenant-fixture");
  return { repo, manifest, tools: createTools({ repo, today: TODAY, manifest }) };
}

describe("tool registry", () => {
  it("exposes one capability line per tool, which is what the prompt is built from", async () => {
    const { tools } = await setup();

    expect(tools.definitions.map((d) => d.function.name)).toEqual([
      "queryCosts",
      "getForecast",
      "getRecentAlerts",
      "getAccountStatus",
    ]);
    expect(tools.capabilityLines).toHaveLength(tools.definitions.length);
  });

  it("returns a correctable result for an unknown tool instead of throwing", async () => {
    const { tools } = await setup();
    const res = await tools.dispatch("tenant-fixture", "getSpendByService", {});

    expect(res.error).toMatch(/no tool called/);
    expect(res.hint).toContain("queryCosts");
  });

  it("hands a bad argument back to the model with the valid options", async () => {
    const { tools } = await setup();
    const res = await tools.dispatch("tenant-fixture", "queryCosts", { groupBy: ["instanceType"] });

    expect(res.invalidArguments).toBe(true);
    expect(res.hint).toContain("lineItemType");
  });

  it("does not let a repository failure escape as an exception", async () => {
    const { tools, repo } = await setup();
    repo.listDays = async () => {
      throw new Error("DynamoDB unavailable");
    };

    const res = await tools.dispatch("tenant-fixture", "queryCosts", {});
    expect(res.error).toMatch(/failed unexpectedly/);
  });
});

describe("getForecast", () => {
  it("projects month-end from the days that have data", async () => {
    const { tools } = await setup();
    const res = await tools.dispatch("tenant-fixture", "getForecast", { month: "2026-08" });

    expect(res.spendSoFar).toBeCloseTo(55.3, 6);
    expect(res.daysElapsed).toBe(14);
    expect(res.daysInMonth).toBe(31);
    expect(res.forecast).toBeCloseTo(122.45, 6);
    expect(res.source).toBe("daily snapshots");
  });

  it("defaults to the current month", async () => {
    const { tools } = await setup();
    const res = await tools.dispatch("tenant-fixture", "getForecast", {});
    expect(res.month).toBe("2026-08");
  });

  it("falls back to the monthly rollup when no daily items exist", async () => {
    const { tools } = await setup();
    const res = await tools.dispatch("tenant-fixture", "getForecast", { month: "2026-05" });

    expect(res.source).toBe("monthly rollup");
    expect(res.forecast).toBeCloseTo(40, 5);
  });

  it("reports no data for a month that was never ingested", async () => {
    const { tools } = await setup();
    const res = await tools.dispatch("tenant-fixture", "getForecast", { month: "2026-01" });
    expect(res.noData).toBe(true);
  });

  it("rejects a malformed month", async () => {
    const { tools } = await setup();
    const res = await tools.dispatch("tenant-fixture", "getForecast", { month: "last month" });
    expect(res.invalidArguments).toBe(true);
  });
});

describe("getRecentAlerts", () => {
  it("returns alerts newest first with the limit applied", async () => {
    const { tools } = await setup();
    const res = await tools.dispatch("tenant-fixture", "getRecentAlerts", { limit: 1 });

    expect(res.alerts).toHaveLength(1);
    expect(res.alerts[0].status).toBe("OPEN");
  });

  it("says plainly when there are none, rather than returning an empty object", async () => {
    const data = buildFixtureData();
    data.alerts = [];
    const { tools } = await setup(data);

    const res = await tools.dispatch("tenant-fixture", "getRecentAlerts", {});
    expect(res.alerts).toEqual([]);
    expect(res.note).toMatch(/No cost anomaly alerts/);
  });
});

describe("getAccountStatus", () => {
  it("reports connection, freshness and quota", async () => {
    const { tools } = await setup();
    const res = await tools.dispatch("tenant-fixture", "getAccountStatus", {});

    expect(res.connected).toBe(true);
    expect(res.monthsStored).toEqual(["2026-05", "2026-06", "2026-07", "2026-08"]);
    expect(res.latestDateWithData).toBe("2026-08-14");
    expect(res.dailyRefreshesRemaining).toBe(1);
  });

  it("never puts the AWS account number into the model's context", async () => {
    const { tools } = await setup();
    const res = await tools.dispatch("tenant-fixture", "getAccountStatus", {});

    expect(res.awsAccountConnected).toBe(true);
    expect(JSON.stringify(res)).not.toContain("123456789012");
  });
});
