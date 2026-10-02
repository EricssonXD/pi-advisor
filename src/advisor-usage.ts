export interface AdvisorUsageRecord {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	provider: string;
	model: string;
	/** Estimated USD from Pi's model pricing; absent when no catalog price is known. */
	costUsd?: number;
}

export type AdvisorUsageInput = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

export type AdvisorPricing = Pick<AdvisorUsageInput, "input" | "output" | "cacheRead" | "cacheWrite">;

export function recordAdvisorUsage(
	usage: AdvisorUsageInput | undefined,
	provider: string,
	model: string,
	pricing: AdvisorPricing,
): AdvisorUsageRecord | undefined {
	if (!usage) return undefined;
	const hasPricing = usage.cost.total > 0 || Object.values(pricing).some((rate) => rate > 0);
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		provider,
		model,
		...(hasPricing ? { costUsd: usage.cost.total } : {}),
	};
}

export interface AdvisorUsageTotals {
	calls: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cacheUnknownCalls: number;
	costUsd: number;
	pricedCalls: number;
}

function validCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function aggregateAdvisorUsage(entries: Array<{ type?: string; customType?: string; data?: unknown }>): AdvisorUsageTotals {
	const totals: AdvisorUsageTotals = {
		calls: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cacheUnknownCalls: 0,
		costUsd: 0,
		pricedCalls: 0,
	};

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== "advisor-usage" || !entry.data || typeof entry.data !== "object") continue;
		const usage = entry.data as Partial<AdvisorUsageRecord>;
		const inputTokens = validCount(usage.inputTokens);
		const outputTokens = validCount(usage.outputTokens);
		if (inputTokens === undefined || outputTokens === undefined) continue;

		totals.calls++;
		totals.inputTokens += inputTokens;
		totals.outputTokens += outputTokens;
		const cacheReadTokens = validCount(usage.cacheReadTokens);
		const cacheWriteTokens = validCount(usage.cacheWriteTokens);
		totals.cacheReadTokens += cacheReadTokens ?? 0;
		totals.cacheWriteTokens += cacheWriteTokens ?? 0;
		if (cacheReadTokens === undefined || cacheWriteTokens === undefined) totals.cacheUnknownCalls++;
		const costUsd = validCount(usage.costUsd);
		if (costUsd !== undefined) {
			totals.costUsd += costUsd;
			totals.pricedCalls++;
		}
	}

	return totals;
}
