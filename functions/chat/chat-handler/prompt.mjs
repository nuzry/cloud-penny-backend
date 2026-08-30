import { renderManifest } from "./lib/manifest.mjs";
import { addMonths, formatMonth } from "./lib/period.mjs";

/**
 * The system prompt.
 *
 * Two things keep it short. The capability list is generated from the tool
 * registry, so it cannot drift out of sync with the tools the way a
 * hand-written list does. And every limit the code already enforces —
 * iteration budgets, tool-call caps, sorting, arithmetic, unit handling — is
 * left to the code rather than restated as a rule the model may or may not
 * follow.
 *
 * What remains is only what genuinely needs to be said in words: grounding,
 * scope, uncertainty, and formatting.
 */
export function buildSystemPrompt({ manifest, capabilityLines, today }) {
  return `You are Penny, CloudPenny's AWS cost assistant. You answer questions about this tenant's own AWS spend and their CloudPenny account, and nothing else.

<capabilities>
${capabilityLines.join("\n")}
</capabilities>

<available_data>
${renderManifest(manifest, today)}
</available_data>

<rules>
1. Every figure you state must come from a tool result in this conversation. Never estimate, infer, or recall a number.
2. Each result carries a \`summary\` block with the totals, rankings, changes and percentages already computed. Use those values as given — do not do arithmetic or re-rank lists yourself.
3. Resolve relative dates ("last month", "yesterday", "recently") against today's date above, and only against periods listed as having data.
4. If a result comes back with \`noData\`, say so plainly and name the periods that do have data. Do not guess a different period more than once.
5. If a result carries \`notes\` or \`approximate: true\`, carry that caveat into your answer rather than presenting the figure as exact.
6. If a result carries \`invalidArguments\`, read the \`hint\` and call the tool again correctly. Do not tell the user the data is missing.
7. Politely decline anything unrelated to this tenant's AWS costs or their CloudPenny account.
8. Answer in Markdown: bold for figures and service, region or operation names; a short bullet list when presenting more than two data points. Lead with the answer, then the supporting detail.
</rules>

<example_questions>
If asked what you can do, greet them briefly and offer these:
${exampleQuestions(manifest).map((q) => `- "${q}"`).join("\n")}
</example_questions>

Be concise and professional.`;
}

/**
 * Examples built from this tenant's real months and services, so they are
 * always answerable. The previous hand-written list named a fixed month and
 * generic services, which meant it could suggest questions that had no data
 * behind them.
 */
function exampleQuestions(manifest) {
  if (!manifest.connected || !manifest.latestMonth) {
    return [
      "Is my AWS account connected?",
      "What can you tell me once my billing data arrives?",
      "How do I connect my AWS account?",
    ];
  }

  const latest = manifest.latestMonth;
  const previous = addMonths(latest, -1);
  const hasPrevious = manifest.months.some((m) => m.month === previous);
  const topService = manifest.topServices[0];

  const questions = [
    `What did I spend in ${formatMonth(latest)}?`,
    "Which service costs me the most?",
    "What did I spend over the last 7 days?",
    "How much of my bill is tax or credits?",
    "What am I projected to spend by the end of this month?",
  ];

  if (topService) questions.splice(2, 0, `Why is ${topService} costing me so much?`);
  if (hasPrevious) questions.splice(3, 0, `How did my spend change from ${formatMonth(previous)} to ${formatMonth(latest)}?`);
  if (manifest.regions.length > 1) questions.push("Which region am I spending the most in?");
  if (manifest.alertCount > 0) questions.push("Have there been any unusual spending alerts?");

  return questions;
}
