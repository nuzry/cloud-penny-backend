import { describe, it, expect } from "vitest";
import { queryCosts } from "./queryCosts.mjs";
import { ValidationError } from "./errors.mjs";
import { createFixtureRepository, buildFixtureData, TODAY } from "../../../../evals/chat/fixtures.mjs";

const run = (repo, spec) => queryCosts(repo, "tenant-fixture", spec, { today: TODAY });

describe("queryCosts", () => {
  describe("totals", () => {
    it("returns the period total with no grouping, defaulting to the current month", async () => {
      const repo = createFixtureRepository();
      const res = await run(repo, {});

      expect(res.period.label).toBe("August 2026");
      expect(res.summary.total).toBeCloseTo(55.3, 6);
      expect(res.summary.periodTotal).toBeCloseTo(55.3, 6);
      expect(res.summary.daysWithData).toBe(14);
    });

    it("answers from the exact aggregate maps without loading the per-row items", async () => {
      const repo = createFixtureRepository();
      await run(repo, { period: { month: "2026-07" }, groupBy: ["service"] });

      const reads = repo.calls.filter((c) => c.op === "listDays");
      expect(reads).toHaveLength(1);
      expect(reads[0].includeItems).toBe(false);
    });
  });

  describe("grouping", () => {
    it("ranks services highest first and names the top one in the summary", async () => {
      const res = await run(createFixtureRepository(), {
        period: { month: "2026-08" },
        groupBy: ["service"],
      });

      expect(res.rows.map((r) => r.service)).toEqual(["AmazonEC2", "AmazonS3", "AWSDataTransfer"]);
      expect(res.rows[0].cost).toBeCloseTo(51.1, 6);
      expect(res.summary.top.service).toBe("AmazonEC2");
      expect(res.summary.top.share).toBeCloseTo(92.4, 1);
    });

    it("breaks costs down by line item type — tax and credits included", async () => {
      const res = await run(createFixtureRepository(), {
        period: { month: "2026-08" },
        groupBy: ["lineItemType"],
      });

      const byType = Object.fromEntries(res.rows.map((r) => [r.lineItemType, r.cost]));
      expect(byType.Usage).toBeCloseTo(53.9, 6);
      expect(byType.Tax).toBeCloseTo(2.1, 6);
      expect(byType.Credit).toBeCloseTo(-0.7, 6);
    });

    it("labels region-less line items rather than grouping them under an empty string", async () => {
      const res = await run(createFixtureRepository(), {
        period: { month: "2026-08" },
        groupBy: ["region"],
      });

      expect(res.rows.map((r) => r.region)).toContain("(unattributed)");
      expect(res.rows.find((r) => r.region === "ap-southeast-1").cost).toBeCloseTo(45.5, 6);
    });

    it("supports a two-dimension breakdown such as service by region", async () => {
      const res = await run(createFixtureRepository(), {
        period: { month: "2026-08" },
        groupBy: ["service", "region"],
        limit: 50,
      });

      const ec2InAp = res.rows.find((r) => r.service === "AmazonEC2" && r.region === "ap-southeast-1");
      expect(ec2InAp.cost).toBeCloseTo(42, 6);
      expect(res.summary.groupCount).toBe(6);
    });

    it("drills into a single service's operations", async () => {
      const repo = createFixtureRepository();
      const res = await run(repo, {
        period: { month: "2026-08" },
        groupBy: ["operation"],
        filter: { service: "AmazonEC2" },
      });

      expect(res.rows[0]).toMatchObject({ operation: "RunInstances" });
      expect(res.rows[0].cost).toBeCloseTo(42, 6);
      expect(res.summary.total).toBeCloseTo(51.1, 6);
      // The unfiltered period total stays available, so "EC2 is X of your Y" is answerable.
      expect(res.summary.periodTotal).toBeCloseTo(55.3, 6);
      expect(repo.calls.find((c) => c.op === "listDays").includeItems).toBe(true);
    });

    it("produces a month-by-month trend", async () => {
      const res = await run(createFixtureRepository(), {
        period: { startMonth: "2026-06", endMonth: "2026-08" },
        groupBy: ["month"],
      });

      const byMonth = Object.fromEntries(res.rows.map((r) => [r.month, r.cost]));
      expect(byMonth["2026-06"]).toBeCloseTo(58.5, 6);
      expect(byMonth["2026-07"]).toBeCloseTo(91.45, 6);
      expect(byMonth["2026-08"]).toBeCloseTo(55.3, 6);
    });

    it("produces a day-by-day breakdown for a recent window", async () => {
      const res = await run(createFixtureRepository(), {
        period: { lastNDays: 7 },
        groupBy: ["day"],
        limit: 10,
      });

      // TODAY is 2026-08-15 but data stops at 2026-08-14, so six days land.
      expect(res.rows).toHaveLength(6);
      expect(res.rows.every((r) => r.cost === 3.95)).toBe(true);
    });
  });

  describe("comparison", () => {
    it("computes period-over-period change without the model doing arithmetic", async () => {
      const res = await run(createFixtureRepository(), {
        period: { month: "2026-07" },
        compareTo: { month: "2026-06" },
      });

      expect(res.summary.total).toBeCloseTo(91.45, 6);
      expect(res.summary.compare.previousTotal).toBeCloseTo(58.5, 6);
      expect(res.summary.compare.change).toBeCloseTo(32.95, 6);
      expect(res.summary.compare.changePercent).toBeCloseTo(56.32, 1);
    });

    it("identifies the biggest increase and decrease across all groups", async () => {
      const res = await run(createFixtureRepository(), {
        period: { month: "2026-07" },
        compareTo: { month: "2026-06" },
        groupBy: ["service"],
        sort: "change",
      });

      expect(res.summary.compare.biggestIncrease.service).toBe("AmazonEC2");
      expect(res.summary.compare.biggestIncrease.change).toBeCloseTo(32.65, 6);
      expect(res.rows[0].service).toBe("AmazonEC2");
      // Nothing shrank between these two months.
      expect(res.summary.compare.biggestDecrease).toBeNull();
    });

    it("reports a group that vanished entirely rather than dropping it", async () => {
      const data = buildFixtureData();
      // Remove S3 from every August day so it exists in July but not August.
      for (const day of data.daysByMonth["2026-08"]) {
        day.items = day.items.filter((r) => r.service !== "AmazonS3");
        delete day.services.AmazonS3;
      }
      const res = await run(createFixtureRepository(data), {
        period: { month: "2026-08" },
        compareTo: { month: "2026-07" },
        groupBy: ["service"],
        sort: "change",
      });

      const s3 = res.rows.find((r) => r.service === "AmazonS3");
      expect(s3.cost).toBe(0);
      expect(s3.previous).toBeCloseTo(6.2, 6);
      expect(s3.change).toBeCloseTo(-6.2, 6);
    });

    it("reports percentage change as null rather than 0 when growing from nothing", async () => {
      const res = await run(createFixtureRepository(), {
        period: { month: "2026-07" },
        compareTo: { month: "2026-03" },
      });

      expect(res.summary.compare.previousTotal).toBe(0);
      expect(res.summary.compare.changePercent).toBeNull();
    });
  });

  describe("usage", () => {
    it("refuses to sum usage across services, and says why", async () => {
      await expect(run(createFixtureRepository(), { metric: "usage" })).rejects.toThrow(ValidationError);
      await expect(run(createFixtureRepository(), { metric: "usage" })).rejects.toThrow(/units differ per service/);
    });

    it("returns usage quantities for one service, flagged as unitless", async () => {
      const res = await run(createFixtureRepository(), {
        period: { month: "2026-08" },
        metric: "usage",
        filter: { service: "AmazonEC2" },
        groupBy: ["operation"],
      });

      const run_ = res.rows.find((r) => r.operation === "RunInstances");
      expect(run_.usageAmount).toBeCloseTo(336, 6);
      expect(res.notes.join(" ")).toMatch(/unit name is not retained/);
    });
  });

  describe("honesty about fidelity", () => {
    it("flags results affected by the aggregated tail", async () => {
      const data = buildFixtureData();
      for (const day of data.daysByMonth["2026-08"]) {
        day.items.push({
          service: "AmazonEC2",
          operation: "Other (aggregated)",
          region: "",
          lineItemType: "Usage",
          usageAmount: 0,
          cost: 0.4,
        });
      }

      const res = await run(createFixtureRepository(data), {
        period: { month: "2026-08" },
        groupBy: ["operation"],
        filter: { service: "AmazonEC2" },
      });

      expect(res.summary.approximate).toBe(true);
      expect(res.notes.join(" ")).toMatch(/aggregated tail/);
    });

    it("does not flag approximation when grouping by a dimension the tail cannot distort", async () => {
      const res = await run(createFixtureRepository(), {
        period: { month: "2026-08" },
        groupBy: ["service"],
      });

      expect(res.summary.approximate).toBe(false);
      expect(res.notes).toBeUndefined();
    });

    it("still counts a rollup-only month in the total, but says it could not break it down", async () => {
      const res = await run(createFixtureRepository(), {
        period: { month: "2026-05" },
        groupBy: ["lineItemType"],
      });

      expect(res.summary.periodTotal).toBeCloseTo(40, 6);
      expect(res.rows).toHaveLength(0);
      expect(res.summary.approximate).toBe(true);
      expect(res.notes.join(" ")).toMatch(/coarse monthly rollup/);
    });

    it("answers a rollup-only month at the level the rollup does support", async () => {
      const res = await run(createFixtureRepository(), {
        period: { month: "2026-05" },
        groupBy: ["service"],
      });

      expect(res.rows[0]).toMatchObject({ service: "AmazonEC2" });
      expect(res.rows[0].cost).toBeCloseTo(30, 6);
    });
  });

  describe("no data", () => {
    it("names the months that do exist instead of dead-ending", async () => {
      const res = await run(createFixtureRepository(), { period: { month: "2026-03" } });

      expect(res.noData).toBe(true);
      expect(res.availableMonths).toEqual(["2026-05", "2026-06", "2026-07", "2026-08"]);
      expect(res.hint).toMatch(/do not guess/i);
    });
  });

  describe("validation", () => {
    it("rejects an unknown dimension and lists the valid ones", async () => {
      await expect(run(createFixtureRepository(), { groupBy: ["instanceType"] })).rejects.toMatchObject({
        name: "ValidationError",
        hint: expect.stringContaining("lineItemType"),
      });
    });

    it("rejects sort:change without a comparison period", async () => {
      await expect(run(createFixtureRepository(), { sort: "change" })).rejects.toThrow(/requires compareTo/);
    });

    it("rejects a malformed month with an example of the right shape", async () => {
      await expect(run(createFixtureRepository(), { period: { month: "August 2026" } })).rejects.toMatchObject({
        hint: expect.stringContaining("2026-08"),
      });
    });

    it("rejects a period longer than the maximum window", async () => {
      await expect(
        run(createFixtureRepository(), { period: { startDate: "2020-01-01", endDate: "2026-08-01" } }),
      ).rejects.toThrow(/maximum/);
    });
  });
});
