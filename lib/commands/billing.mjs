// Your Rokku plan and credits, read-only. Buying and subscribing happen in the App.
import {request, print, when} from "../core.mjs";

const credits = micro => (micro / 1_000_000).toFixed(2);

export const commands = {
  billing: {
    usage: "rokku billing [--raw]                          your plan, credits left and what used them this period (read-only)",
    async run(config, positional, flags) {
      const billing = await request(config, "GET /v1/billing");
      if (flags.raw) return print(billing);
      const {credits: c} = billing;
      const sub = billing.subscription;
      const term = sub ? ` (${sub.status}${sub.current_period_end ? `, ${sub.cancel_at_period_end ? "ends" : "renews"} ${when(sub.current_period_end)}` : ""})` :
        billing.one_month ? ` (until ${when(billing.one_month.expires_at)})` : "";
      const lines = [`Plan: ${billing.plan}${term}`];
      if (c) {
        lines.push(`Credits left: ${credits(c.balance_micro_credits)}` +
          (c.monthly ? ` (monthly ${credits(c.monthly.remaining_micro_credits)} of ${credits(c.monthly.granted_micro_credits)}, renews ${when(c.monthly.resets_at)})` : ""));
        if (c.debt_micro_credits) lines.push(`Owed: ${credits(c.debt_micro_credits)}`);
        if (c.gifted?.remaining_micro_credits) lines.push(`Gifted: ${credits(c.gifted.remaining_micro_credits)}${c.gifted.next_expires_at ? `, next expiry ${when(c.gifted.next_expires_at)}` : ""}`);
        if (c.purchased?.remaining_micro_credits) lines.push(`Purchased: ${credits(c.purchased.remaining_micro_credits)}`);
        if (c.usage) {
          const parts = Object.entries(c.usage.charged_micro_credits ?? {}).filter(([, micro]) => micro).map(([kind, micro]) => `${kind.replace("_", " ")} ${credits(micro)}`);
          lines.push(`Used since ${when(c.usage.period_start)}: ${credits(c.usage.total_charged_micro_credits ?? 0)}${parts.length ? ` (${parts.join(", ")})` : ""}`);
        }
      }
      lines.push("Plans and credits are bought in the Rokku app.");
      return print(lines.join("\n"));
    },
  },
};
