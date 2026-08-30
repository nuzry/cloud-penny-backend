/**
 * The golden question set.
 *
 * Every entry is a question a real tenant could ask, paired with what a
 * correct answer must contain. The expected figures are derived from the
 * synthetic tenant in fixtures.mjs, so they are exact rather than
 * approximate, and the same numbers the unit tests assert on.
 *
 * Three things are scored per question:
 *
 *   toolSelection  - did it reach for the right lookups, and avoid the wrong ones
 *   numericAccuracy- do the figures it states match the data
 *   noFalseNoData  - did it avoid claiming data is missing when it is present
 *
 * `expectNumbers` are matched leniently on formatting (thousands separators,
 * currency symbols, 1 or 2 decimal places) but strictly on value.
 */

export const questions = [
  {
    id: "total-named-month",
    tags: ["total"],
    question: "What did I spend on AWS in July 2026?",
    expectTools: ["queryCosts"],
    expectNumbers: [91.45],
  },
  {
    id: "total-current-month",
    tags: ["total", "relative-date"],
    question: "How much have I spent this month so far?",
    expectTools: ["queryCosts"],
    expectNumbers: [55.3],
  },
  {
    id: "top-service",
    tags: ["service"],
    question: "Which service costs me the most?",
    expectTools: ["queryCosts"],
    expectText: ["AmazonEC2"],
    expectNumbers: [51.1],
  },
  {
    id: "service-drilldown",
    tags: ["operation"],
    question: "Why is EC2 costing me so much this month?",
    expectTools: ["queryCosts"],
    expectText: ["RunInstances"],
    expectNumbers: [42],
  },
  {
    id: "region-breakdown",
    tags: ["region"],
    question: "Which AWS region am I spending the most in this month?",
    expectTools: ["queryCosts"],
    expectText: ["ap-southeast-1"],
    expectNumbers: [45.5],
  },
  {
    id: "tax",
    tags: ["lineItemType"],
    question: "How much of my August bill is tax?",
    expectTools: ["queryCosts"],
    expectNumbers: [2.1],
  },
  {
    id: "credits",
    tags: ["lineItemType"],
    question: "Have I received any credits this month, and how much?",
    expectTools: ["queryCosts"],
    expectNumbers: [0.7],
  },
  {
    id: "month-over-month",
    tags: ["compare"],
    question: "How did my spend change from June 2026 to July 2026?",
    expectTools: ["queryCosts"],
    expectNumbers: [32.95],
  },
  {
    id: "biggest-driver",
    tags: ["compare", "service"],
    question: "What drove the increase between June and July 2026?",
    expectTools: ["queryCosts"],
    expectText: ["AmazonEC2"],
    expectNumbers: [32.65],
  },
  {
    id: "trend",
    tags: ["trend"],
    question: "Show me my monthly spend trend over the last four months.",
    expectTools: ["queryCosts"],
    expectNumbers: [58.5, 91.45],
  },
  {
    id: "recent-days",
    tags: ["daily", "relative-date"],
    question: "What have I been spending per day over the last week?",
    expectTools: ["queryCosts"],
    expectNumbers: [3.95],
  },
  {
    id: "forecast",
    tags: ["forecast"],
    question: "What am I projected to spend by the end of this month?",
    expectTools: ["getForecast"],
    expectNumbers: [122.45],
  },
  {
    id: "alerts",
    tags: ["alerts"],
    question: "Have there been any unusual spending alerts recently?",
    expectTools: ["getRecentAlerts"],
    forbidTools: ["queryCosts"],
    expectText: ["AmazonEC2"],
  },
  {
    id: "data-freshness",
    tags: ["account"],
    question: "How current is this cost data?",
    expectTools: ["getAccountStatus"],
    expectText: ["2026-08-14"],
  },
  {
    id: "usage-quantity",
    tags: ["usage"],
    question: "How many EC2 instance hours did I use this month?",
    expectTools: ["queryCosts"],
    expectNumbers: [336],
  },
  {
    id: "service-by-region",
    tags: ["cross-dimension"],
    question: "Which regions is my EC2 spend split across this month?",
    expectTools: ["queryCosts"],
    expectText: ["ap-southeast-1", "us-east-1"],
    expectNumbers: [42],
  },
  {
    id: "missing-period",
    tags: ["no-data"],
    question: "What did I spend in January 2026?",
    expectTools: ["queryCosts"],
    // It must say the period has no data AND point at what does exist,
    // rather than inventing a figure or giving a bare "I don't know".
    expectPatterns: [/2026-0[5678]/],
    forbidPatterns: [/\$\s?\d/],
  },
  {
    id: "rollup-only-month",
    tags: ["no-data", "fidelity"],
    question: "How much tax did I pay in May 2026?",
    expectTools: ["queryCosts"],
    // May has only a coarse rollup, so a truthful answer says it cannot break
    // that month down — it must not silently report 0 or invent a figure.
    expectPatterns: [/rollup|cannot|can't|not.*(available|stored|broken down)|unable/i],
  },
  {
    id: "out-of-scope",
    tags: ["scope"],
    question: "Tell me a joke about penguins.",
    forbidTools: ["queryCosts", "getForecast", "getRecentAlerts", "getAccountStatus"],
    expectPatterns: [/AWS|cost|spend|help you with/i],
  },
  {
    id: "capabilities",
    tags: ["scope"],
    question: "What can you help me with?",
    expectPatterns: [/spend|cost/i],
    forbidPatterns: [/I don't have|no data/i],
  },
];
