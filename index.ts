/**
 * Advisor Extension
 *
 * Registers an LLM-callable tool named `advisor` that allows the executor model
 * to consult a stronger "advisor" model for strategic guidance on complex decisions.
 *
 * Design follows the advisor tool pattern: the executor keeps doing the work and
 * only calls the advisor when it needs strategic guidance — not for syntax-level
 * questions or routine implementation steps.
 *
 * The advisor:
 * - Sees a curated transcript plus the executor's current system prompt
 * - Returns strategic guidance (plan, correction, or stop signal)
 * - Cannot call tools — only provides text advice
 * - Is invoked at the executor's discretion
 *
 * Commands:
 * - /advisor on [provider/model] — Enable advisor, opening the model picker when omitted
 * - /advisor model [search]    — Change the advisor model with a searchable picker
 * - /advisor off                 — Disable advisor tool (persists to config)
 * - /advisor config [key=value]  — Show/edit advisor configuration
 * - /advisor usage               — Show current session token/cost totals
 * - /advisor                     — Show status
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { type Message, type TextContent, type ThinkingContent, type ThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir, keyHint, type ExtensionAPI, type ExtensionCommandContext, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { buildAdvisorMessages } from "./src/advisor-messages.ts";
import { aggregateAdvisorUsage, recordAdvisorUsage, type AdvisorUsageRecord } from "./src/advisor-usage.ts";
import {
	buildExecutorSignals,
	detectStage,
	shouldNudge,
	summarizeToolResult,
	type AdvisorStage,
	type AdvisorStageInfo,
	type RunToolEvent,
} from "./src/advisor-signals.ts";
import { Container, fuzzyFilter, Input, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface AdvisorConfig {
	enabled: boolean;
	provider: string;
	model: string;
	maxUsesPerRun: number;
	maxTokens: number;
	reasoning: ThinkingLevel;
	maxContextMessages: number;
}

interface AdvisorDetails {
	usage?: AdvisorUsageRecord;
	callNumber: number;
	stage?: AdvisorStage;
	error?: string;
	message?: string;
}

// Optional pi-usage v1 structural contract: never import a tracker installation.
type UsageResult<T> = { ok: true; value: T } | { ok: false; code: string };
type UsageContext = Readonly<{
	version: 1; generation: string; ledgerId: string;
	sessionId: string; rootSessionId: string; workflowId: string | null; source: string;
	toolCallId: string | null; rootToolCallId: string | null; parentToolCallId: string | null;
}>;
type UsageTokens = Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite" | "reasoning" | "cacheWrite1h" | "providerTotal", number | null>>;
type UsageInput = {
	id: string; attemptId: string; eventTime: number; provider: string | null; api: string | null; model: string | null;
	representation: "detailed"; tokens: UsageTokens;
	price: { amount: number | null; evidence: "catalog-estimate" | "unknown"; catalogVersion?: string };
	callCount: number; durationMs: number; outcome: "success" | "error" | "aborted";
};
type UsageCompletion = { id: string; endedAt: number; usageId?: string; outcome?: "no-usage" | "error" | "interrupted" };
type UsageService = {
	version: 1; generation: string; capabilities: { context: boolean; reporting: boolean };
	captureContext(options: { source: string; toolCallId: string; rootToolCallId: string }): UsageResult<UsageContext>;
	beginAttempt(input: { context: UsageContext; id: string; startedAt: number }): Promise<UsageResult<unknown>>;
	finishAttempt(input: { context: UsageContext; completion: UsageCompletion; usage?: UsageInput }): Promise<UsageResult<unknown>>;
};
type AdvisorTracking = { service: UsageService; context: UsageContext; attempt: { id: string; startedAt: number } };

function captureAdvisorTracking(pi: ExtensionAPI, toolCallId: string): AdvisorTracking | undefined {
	let service: UsageService | undefined;
	let accepting = true;
	try {
		pi.events.emit("pi-usage:v1:discover", { version: 1, reply: (result: UsageResult<UsageService>) => {
			if (!accepting || !result?.ok) return;
			const value = result.value;
			if (value?.version === 1 && value.capabilities?.context && value.capabilities?.reporting &&
				typeof value.captureContext === "function" && typeof value.beginAttempt === "function" && typeof value.finishAttempt === "function") service = value;
		} });
	} catch { /* Discovery is optional and synchronous. */ }
	finally { accepting = false; }
	if (!service) return undefined;
	try {
		const captured = service.captureContext({ source: "pi-advisor", toolCallId, rootToolCallId: toolCallId });
		if (!captured.ok) return undefined;
		return { service, context: Object.freeze({ ...captured.value }), attempt: { id: `advisor:${randomUUID()}`, startedAt: Date.now() } };
	} catch { return undefined; }
}

async function finishAdvisorTracking(
	pi: ExtensionAPI, tracking: AdvisorTracking | undefined,
	response?: { provider?: string; api?: string; model?: string; responseModel?: string; stopReason?: string; errorMessage?: string; usage?: UsageTokens & { totalTokens?: number; cost?: { total?: number } } },
	failed = false,
): Promise<void> {
	if (!tracking) return;
	const { service, context, attempt } = tracking;
	const endedAt = Math.max(Date.now(), attempt.startedAt);
	let usage: UsageInput | undefined;
	try {
		if (response?.usage) {
			const native = response.usage;
			const outcome = response.stopReason === "aborted" ? "aborted" : response.stopReason === "error" || response.errorMessage ? "error" : "success";
			const tokens: UsageTokens = {};
			for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "cacheWrite1h", "providerTotal"] as const) tokens[key] = native[key] ?? null;
			tokens.providerTotal = native.totalTokens ?? native.providerTotal ?? null;
			// SDK error placeholders do not establish zero-cost/token evidence.
			const allZero = [native.input, native.output, native.cacheRead, native.cacheWrite].every(n => n === 0) && (tokens.providerTotal == null || tokens.providerTotal === 0);
			const amount = native.cost?.total;
			usage = {
				id: `usage:${attempt.id}`, attemptId: attempt.id, eventTime: endedAt,
				provider: response.provider ?? null, api: response.api ?? null, model: response.responseModel ?? response.model ?? null,
				representation: "detailed", tokens: outcome !== "success" && allZero ? {} : tokens,
				price: typeof amount === "number" && Number.isFinite(amount) && amount > 0
					? { amount, evidence: "catalog-estimate", catalogVersion: "pi-capture-v1" } : { amount: null, evidence: "unknown" },
				callCount: 1, durationMs: endedAt - attempt.startedAt, outcome,
			};
		}
		const completion: UsageCompletion = usage
			? { id: attempt.id, endedAt, usageId: usage.id }
			: { id: attempt.id, endedAt, outcome: response?.stopReason === "aborted" ? "interrupted" : failed || response?.stopReason === "error" || response?.errorMessage ? "error" : "no-usage" };
		if (usage) {
			// Journal before the API ack; include the attempt even if begin failed. Replay
			// and the API use exactly these IDs, so recovery never adds a second charge.
			try { pi.appendEntry("pi-usage.record", { version: 1, context, attempt, usage, completion }); } catch { /* Still try durable reporting. */ }
		}
		await service.finishAttempt({ context, completion, ...(usage ? { usage } : {}) });
	} catch { /* Telemetry cannot replace advice; the marker/attempt retains recovery evidence. */ }
}

const DEFAULT_CONFIG: AdvisorConfig = {
	enabled: false,
	provider: "anthropic",
	model: "claude-fable-5",
	maxUsesPerRun: 3,
	// Adaptive-thinking models count thinking tokens against the output cap;
	// 8k left too little room for the actual advice at reasoning=high.
	maxTokens: 16384,
	reasoning: "high",
	maxContextMessages: 18,
};

const MAX_SYSTEM_PROMPT_CHARS = 12000;
const RECENT_TOOL_SUMMARY_COUNT = 8;

const VALID_REASONING_LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];

const ADVISOR_SYSTEM_PROMPT = `You are a senior engineering advisor. The executor model is doing the work; you observe the transcript and provide strategic guidance when consulted.

Your role:
- You see a curated subset of the executor's context: a truncated transcript, tool activity summaries (not full outputs), and its system prompt
- If the evidence is too thin to judge, say so — never fill gaps with guesses
- You cannot call tools or produce user-facing output
- Your advice directly shapes the executor's next actions

What you provide depends on the stage:
1. PLAN — when the executor is still exploring: shortest viable approach, main risk to avoid, first concrete steps (here the verdict judges the exploration direction so far)
2. CORRECTION — when trajectory is weak: what to stop doing, why, and the corrected path
3. VERIFICATION — when implementation appears done: missing evidence, unmet requirements, or explicit sign-off

Output format:
- Lead with a one-sentence verdict: "On track", "Course-correct", or "Not done yet"
- Follow with numbered action items (max 5) the executor should take next
- If the transcript lacks the evidence to settle a point, make your FIRST action item the exact command or file read that would settle it (e.g. "run npm test and re-consult"), instead of guessing
- Reference specific files, commands, or error signals from the transcript
- If you disagree with evidence the executor gathered, state the conflict explicitly — don't silently override

Keep it short. The executor will read your advice and immediately act on it.`;

function configPath(): string {
	return join(getAgentDir(), "advisor.json");
}

function loadConfig(): AdvisorConfig {
	const path = configPath();
	if (!existsSync(path)) return { ...DEFAULT_CONFIG };
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		return {
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
			provider: typeof raw.provider === "string" ? raw.provider : DEFAULT_CONFIG.provider,
			model: typeof raw.model === "string" ? raw.model : DEFAULT_CONFIG.model,
			maxUsesPerRun: typeof raw.maxUsesPerRun === "number" ? raw.maxUsesPerRun : DEFAULT_CONFIG.maxUsesPerRun,
			maxTokens: typeof raw.maxTokens === "number" ? raw.maxTokens : DEFAULT_CONFIG.maxTokens,
			reasoning: VALID_REASONING_LEVELS.includes(raw.reasoning) ? raw.reasoning : DEFAULT_CONFIG.reasoning,
			maxContextMessages: typeof raw.maxContextMessages === "number" ? raw.maxContextMessages : DEFAULT_CONFIG.maxContextMessages,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

function saveConfig(config: AdvisorConfig): void {
	const path = configPath();
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatCost(costUsd: number): string {
	return `$${costUsd.toFixed(costUsd < 0.01 ? 6 : 4)}`;
}

function formatUsage(usage: AdvisorUsageRecord): string {
	const cache = usage.cacheReadTokens || usage.cacheWriteTokens
		? ` cache ${formatTokens(usage.cacheReadTokens)} read/${formatTokens(usage.cacheWriteTokens)} write`
		: "";
	const cost = usage.costUsd === undefined ? "cost unavailable" : `${formatCost(usage.costUsd)} est.`;
	return `↑${formatTokens(usage.inputTokens)} ↓${formatTokens(usage.outputTokens)}${cache} ${cost} ${usage.provider}/${usage.model}`;
}

async function chooseAdvisorModel(
	ctx: ExtensionCommandContext,
	currentProvider: string,
	currentModel: string,
	initialSearch = "",
): Promise<{ provider: string; model: string } | undefined> {
	const models = ctx.modelRegistry.getAvailable().slice().sort((a, b) => {
		const aIsCurrent = a.provider === currentProvider && a.id === currentModel;
		const bIsCurrent = b.provider === currentProvider && b.id === currentModel;
		return Number(bIsCurrent) - Number(aIsCurrent) || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
	});
	if (models.length === 0) {
		ctx.ui.notify("No models available for configured providers. Use /login to add providers.", "warning");
		return undefined;
	}
	if (ctx.mode !== "tui") {
		ctx.ui.notify("The advisor model picker requires TUI mode; use /advisor on provider/model instead.", "warning");
		return undefined;
	}

	return ctx.ui.custom((tui, theme, keybindings, done) => {
		const root = new Container();
		const search = new Input();
		const listContainer = new Container();
		let list: SelectList;

		root.addChild(new Text(theme.fg("accent", theme.bold("Select Advisor Model"))));
		root.addChild(new Text(theme.fg("warning", "Only models from configured providers are shown. Use /login to add providers.")));
		root.addChild(search);
		root.addChild(listContainer);
		root.addChild(new Spacer(1));
		root.addChild(new Text(theme.fg("dim", "↑↓ navigate · type to search · enter select · esc cancel")));

		const updateList = () => {
			const query = search.getValue().trim();
			const filtered = query ? fuzzyFilter(models, query, (model) => `${model.id} ${model.provider} ${model.name}`) : models;
			const items = filtered.map((model) => ({
				value: `${model.provider}\0${model.id}`,
				label: `${model.provider === currentProvider && model.id === currentModel ? "✓ " : ""}${model.id} [${model.provider}]`,
				description: model.name,
			}));
			list = new SelectList(items, 10, {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			list.setSelectedIndex(query ? 0 : Math.max(0, filtered.findIndex((model) => model.provider === currentProvider && model.id === currentModel)));
			list.onSelect = (item) => {
				const selected = filtered.find((model) => `${model.provider}\0${model.id}` === item.value);
				if (selected) done({ provider: selected.provider, model: selected.id });
			};
			list.onCancel = () => done(undefined);
			listContainer.clear();
			listContainer.addChild(list);
		};
		updateList();
		if (initialSearch) {
			search.setValue(initialSearch);
			updateList();
		}

		return {
			get focused() { return search.focused; },
			set focused(value: boolean) { search.focused = value; },
			render(width: number) { return root.render(width); },
			invalidate() { root.invalidate(); },
			handleInput(data: string) {
				if (keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down") || keybindings.matches(data, "tui.select.confirm") || keybindings.matches(data, "tui.select.cancel")) {
					list.handleInput(data);
				} else {
					search.handleInput(data);
					updateList();
				}
				tui.requestRender();
			},
		};
	}, { overlay: false });
}

const STAGE_LABELS: Record<AdvisorStage, string> = {
	"initial": "initial",
	"recovery": "recovery",
	"final-check": "final check",
};

function stageLabel(stage: AdvisorStage): string {
	return STAGE_LABELS[stage];
}

const STAGE_DIRECTIVES: Record<AdvisorStage, string> = {
	"initial": "Executor is still exploring. Provide: (1) the shortest viable approach, (2) the main risk to avoid, (3) 2-3 concrete first steps.",
	"recovery": "Executor hit friction or is off-track. Provide: (1) what went wrong, (2) what to stop doing, (3) corrected path forward.",
	"final-check": "Implementation appears done. Verify: (1) re-read the original user request at the top of the transcript — are all of ITS requirements met, including explicit constraints? (2) is verification evidence sufficient? (3) any missing edge cases? Give explicit sign-off or list what's missing.",
};

function stageDirective(stage: AdvisorStage): string {
	return STAGE_DIRECTIVES[stage];
}

function squeezeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function buildActiveToolsSummary(pi: ExtensionAPI): string {
	const activeToolNames = new Set(pi.getActiveTools().filter((name) => name !== "advisor"));
	const activeTools = pi
		.getAllTools()
		.filter((tool) => activeToolNames.has(tool.name))
		.sort((a, b) => a.name.localeCompare(b.name));

	if (activeTools.length === 0) return "- No active tools recorded";

	return activeTools
		.map((tool) => `- ${tool.name}: ${squeezeWhitespace(tool.description).slice(0, 160)}`)
		.join("\n");
}

function buildRecentToolActivity(events: RunToolEvent[]): string {
	if (events.length === 0) return "";
	return events
		.slice(-RECENT_TOOL_SUMMARY_COUNT)
		.map((event) => `- ${event.summary}`)
		.join("\n");
}

// Stage specifics live in the final context message next to the freshest
// evidence (see buildAdvisorMessages); the system prompt stays stage-agnostic.
function buildAdvisorPrompt(executorSystemPrompt: string, activeToolsSummary: string): string {
	const trimmedSystemPrompt = executorSystemPrompt.trim();
	const boundedSystemPrompt = trimmedSystemPrompt.length > MAX_SYSTEM_PROMPT_CHARS
		? `${trimmedSystemPrompt.slice(0, MAX_SYSTEM_PROMPT_CHARS).trimEnd()}\n[executor system prompt truncated for advisor context]`
		: trimmedSystemPrompt;

	return `${ADVISOR_SYSTEM_PROMPT}

Executor system prompt:
<<<SYSTEM_PROMPT
${boundedSystemPrompt}
SYSTEM_PROMPT>>>

Active tools available to the executor:
${activeToolsSummary}`;
}

function buildPreview(text: string, lines: number): { preview: string; truncated: boolean } {
	const split = text.split("\n");
	if (split.length <= lines) return { preview: text, truncated: false };
	return { preview: `${split.slice(0, lines).join("\n")}\n…`, truncated: true };
}

export default function advisorExtension(pi: ExtensionAPI) {
	let config = loadConfig();
	let usesThisRun = 0;
	let runToolEvents: RunToolEvent[] = [];

	pi.on("agent_start", async (_, ctx) => {
		usesThisRun = 0;
		runToolEvents = [];
		ctx.ui.setStatus("advisor-nudge", undefined);
	});

	// tool_result carries the tool input and typed details directly, so no
	// tool_execution_start/end bookkeeping is needed.
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === "advisor") return;
		runToolEvents.push(summarizeToolResult(event));

		const hint = shouldNudge(runToolEvents, usesThisRun, config.enabled, config.maxUsesPerRun);
		ctx.ui.setStatus("advisor-nudge", hint ?? undefined);
	});

	pi.on("session_start", async () => {
		config = loadConfig();
		updateToolRegistration();
	});

	function updateToolRegistration() {
		const activeTools = pi.getActiveTools();
		if (config.enabled) {
			if (!activeTools.includes("advisor")) {
				pi.setActiveTools([...activeTools, "advisor"]);
			}
			return;
		}
		if (activeTools.includes("advisor")) {
			pi.setActiveTools(activeTools.filter((tool) => tool !== "advisor"));
		}
	}

	pi.registerTool({
		name: "advisor",
		label: "Consult advisor",
		description: `Consult a stronger model for strategic guidance. Returns a verdict (On track / Course-correct / Not done yet) plus numbered action items.
The advisor sees the conversation transcript, your system prompt, and recent tool activity. It cannot call tools.`,
		promptSnippet: "advisor({ stage? }): consult stronger model for strategic guidance → verdict + action items",
		promptGuidelines: [
			"Call advisor({ stage: 'initial' }) for non-trivial tasks after 2-3 reads, before committing to an approach",
			"Call advisor({ stage: 'recovery' }) when stuck, confused, or after a failed attempt",
			"Call advisor({ stage: 'final-check' }) after implementation + verification, before declaring complete",
			"Call advisor() with no args to auto-detect the stage",
			"Do not call advisor for syntax questions, API lookups, routine steps, tasks completable in <5 tool calls, or when your current plan is working",
			"You remain executor: advisor only advises. Execute returned action items unless evidence contradicts — then state the conflict explicitly instead of silently ignoring",
		],
		parameters: Type.Object({
			stage: Type.Optional(Type.Union([Type.Literal("initial"), Type.Literal("recovery"), Type.Literal("final-check")])),
		}),

		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			config = loadConfig();
			try { ctx.ui.setStatus("advisor-nudge", undefined); } catch { /* UI telemetry is optional. */ }

			if (usesThisRun >= config.maxUsesPerRun) {
				return {
					content: [{ type: "text", text: `Advisor usage limit reached (${config.maxUsesPerRun} per run). Continue without advisor guidance.` }],
					details: { error: "max_uses_exceeded", callNumber: usesThisRun } as AdvisorDetails,
				};
			}

			const model = ctx.modelRegistry.find(config.provider, config.model);
			if (!model) {
				return {
					content: [{ type: "text", text: `Advisor model ${config.provider}/${config.model} not found. Continue without advice.` }],
					details: { error: "model_not_found", callNumber: usesThisRun } as AdvisorDetails,
				};
			}

			const stageInfo: AdvisorStageInfo = params.stage
				? { stage: params.stage, reason: "Executor explicitly signaled this stage." }
				: detectStage(runToolEvents, usesThisRun + 1);
			const recentToolActivity = buildRecentToolActivity(runToolEvents);
			const branch = ctx.sessionManager.getBranch();
			const signals = buildExecutorSignals(runToolEvents);
			const advisorMessages = buildAdvisorMessages(
				branch,
				{ ...stageInfo, directive: stageDirective(stageInfo.stage) },
				recentToolActivity,
				config.maxContextMessages,
				signals,
			);
			if (advisorMessages.length === 0) {
				return {
					content: [{ type: "text", text: "No conversation context available for advisor. Continue without advice." }],
					details: { error: "no_context", callNumber: usesThisRun, stage: stageInfo.stage } as AdvisorDetails,
				};
			}

			// Only count uses once all preconditions passed and a real model call is about to happen.
			usesThisRun++;

			const executorSystemPrompt = ctx.getSystemPrompt();
			const advisorPrompt = buildAdvisorPrompt(executorSystemPrompt, buildActiveToolsSummary(pi));
			// Snapshot ownership before any async SDK work; a later consumed request
			// must not take ownership of this consultation.
			const tracking = captureAdvisorTracking(pi, toolCallId);
			if (tracking) {
				try { await tracking.service.beginAttempt({ context: tracking.context, ...tracking.attempt }); } catch { /* Advice still proceeds. */ }
			}
			let responseReceived = false;

			try {
				// Codex response chaining is connection-scoped. Reusing the executor's
				// session ID lets the nested advisor call inherit a stale previous_response_id.
				const sessionId = model.api === "openai-codex-responses"
					? undefined
					: ctx.sessionManager.getSessionId();
				const response = await ctx.modelRegistry.complete(
					model,
					{
						systemPrompt: advisorPrompt,
						// Safe cast: assistant entries are spread from real AssistantMessages
						// (text-only content), synthetic entries are well-formed UserMessages.
						messages: advisorMessages as Message[],
					},
					{
						maxTokens: config.maxTokens,
						signal,
						reasoning: config.reasoning,
						// Session-affine cache routing is safe for providers other than Codex.
						sessionId,
					},
				);

				responseReceived = true;
				await finishAdvisorTracking(pi, tracking, response);

				const textBlocks = response.content.filter((b): b is TextContent => b.type === "text");
				const thinkingBlocks = response.content.filter((b): b is ThinkingContent => b.type === "thinking");
				const adviceText = textBlocks.map((b) => b.text).join("\n").trim();
				const thinkingText = thinkingBlocks.map((b) => b.thinking).join("\n").trim();

				// If no text but thinking exists, use thinking as fallback
				const finalText = adviceText || (thinkingText ? `(thinking)\n${thinkingText}` : "");

				let usage: AdvisorUsageRecord | undefined;
				try {
					usage = recordAdvisorUsage(response.usage, config.provider, config.model, model.cost);
					if (usage) pi.appendEntry("advisor-usage", usage);
				} catch { /* Preserve useful advice even when legacy metrics storage fails. */ }

				// Detect silent failures: empty content with no error thrown
				if (!finalText && !response.errorMessage) {
					return {
						content: [{ type: "text", text: `(Advisor returned empty response — model: ${config.provider}/${config.model}, stop: ${response.stopReason}). Check that the model supports this API format.` }],
						details: { usage, callNumber: usesThisRun, stage: stageInfo.stage, error: "empty_response" } as AdvisorDetails,
					};
				}

				return {
					content: [{ type: "text", text: finalText || response.errorMessage || "(Advisor returned empty response)" }],
					details: { usage, callNumber: usesThisRun, stage: stageInfo.stage, error: response.errorMessage ? "model_error" : undefined } as AdvisorDetails,
				};
			} catch (err) {
				if (!responseReceived) await finishAdvisorTracking(pi, tracking, undefined, true);
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Advisor call failed: ${msg}. Continue without advice.` }],
					details: { error: "execution_failed", message: msg, callNumber: usesThisRun, stage: stageInfo.stage } as AdvisorDetails,
				};
			}
		},

		renderCall() {
			return new Container();
		},

		renderResult(result, options: ToolRenderResultOptions, theme, _context) {
			const details = result.details as AdvisorDetails | undefined;
			const text = result.content[0]?.type === "text" ? result.content[0].text : "(no advice)";

			if (options.isPartial) {
				return new Text(theme.fg("muted", "Advisor…"), 0, 0);
			}

			if (details?.error) {
				const container = new Container();
				container.addChild(new Text(theme.fg("error", "Advisor unavailable: ") + theme.fg("dim", text), 0, 0));
				if (details.usage) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", formatUsage(details.usage)), 0, 0));
				}
				return container;
			}

			const container = new Container();
			let header = theme.fg("toolTitle", theme.bold("Advisor"));
			if (details?.stage) header += " " + theme.fg("muted", stageLabel(details.stage));
			if (details?.callNumber) header += theme.fg("dim", ` #${details.callNumber}/${config.maxUsesPerRun}`);
			container.addChild(new Text(header, 0, 0));
			container.addChild(new Spacer(1));

			if (options.expanded) {
				container.addChild(new Text(text, 0, 0));
			} else {
				const preview = buildPreview(text, 6);
				container.addChild(new Text(preview.preview, 0, 0));
				if (preview.truncated) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", keyHint("app.tools.expand", "to expand")), 0, 0));
				}
			}

			if (details?.usage) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", formatUsage(details.usage)), 0, 0));
			}

			return container;
		},
	});

	pi.registerCommand("advisor", {
		description: "Manage advisor tool: on, model, off, config, ask, usage",
		getArgumentCompletions: (prefix) => {
			const subcommands = ["on", "off", "config", "ask", "usage", "model"];
			const trimmed = prefix.trim();
			if (!trimmed.includes(" ")) {
				const matches = subcommands.filter((s) => s.startsWith(trimmed));
				return matches.length > 0 ? matches.map((s) => ({ value: s, label: s })) : null;
			}

			const parts = trimmed.split(/\s+/);
			if (parts[0] === "config" && parts.length <= 2) {
				const keys = ["provider=", "model=", "maxUsesPerRun=", "maxTokens=", "reasoning=", "maxContextMessages="];
				const lastPart = parts[parts.length - 1] ?? "";
				const matches = keys.filter((k) => k.startsWith(lastPart));
				return matches.length > 0 ? matches.map((k) => ({ value: `config ${k}`, label: k })) : null;
			}

			return null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0]?.toLowerCase() || "";
			const rest = parts.slice(1).join(" ");

			switch (subcommand) {
				case "on": {
					let provider = config.provider;
					let modelId = config.model;
					if (rest) {
						// Split on the first slash only: model IDs may contain slashes (e.g. OpenRouter).
						const slash = rest.indexOf("/");
						if (slash <= 0 || slash === rest.length - 1) {
							ctx.ui.notify("Invalid format. Use: /advisor on provider/model (e.g., anthropic/claude-fable-5)", "warning");
							return;
						}
						provider = rest.slice(0, slash);
						modelId = rest.slice(slash + 1);
					} else if (ctx.mode === "tui") {
						const selected = await chooseAdvisorModel(ctx, provider, modelId);
						if (!selected) return;
						provider = selected.provider;
						modelId = selected.model;
					}

					const model = ctx.modelRegistry.find(provider, modelId);
					if (!model) {
						ctx.ui.notify(`Model ${provider}/${modelId} not found`, "error");
						return;
					}

					config.provider = provider;
					config.model = modelId;
					config.enabled = true;
					saveConfig(config);
					updateToolRegistration();
					ctx.ui.notify(`Advisor enabled: ${config.provider}/${config.model}`, "info");
					break;
				}

				case "model": {
					const selected = await chooseAdvisorModel(ctx, config.provider, config.model, rest);
					if (!selected) return;
					config.provider = selected.provider;
					config.model = selected.model;
					saveConfig(config);
					ctx.ui.notify(`Advisor model set: ${config.provider}/${config.model}`, "info");
					break;
				}

				case "off": {
					config.enabled = false;
					saveConfig(config);
					updateToolRegistration();
					ctx.ui.notify("Advisor disabled", "info");
					break;
				}

				case "usage": {
					const totals = aggregateAdvisorUsage(ctx.sessionManager.getBranch());
					if (totals.calls === 0) {
						ctx.ui.notify("No advisor usage recorded in this session branch.", "info");
						return;
					}
					const cost = totals.pricedCalls === totals.calls
						? `${formatCost(totals.costUsd)} estimated`
						: totals.pricedCalls > 0
							? `${formatCost(totals.costUsd)} estimated (${totals.pricedCalls}/${totals.calls} calls had pricing data)`
							: "unavailable";
					ctx.ui.notify([
						"Advisor usage (current session branch)",
						`  Calls:      ${totals.calls}`,
						`  Input:      ${formatTokens(totals.inputTokens)} tokens`,
						`  Output:     ${formatTokens(totals.outputTokens)} tokens`,
						`  Cache read: ${formatTokens(totals.cacheReadTokens)} tokens`,
						`  Cache write: ${formatTokens(totals.cacheWriteTokens)} tokens`,
						...(totals.cacheUnknownCalls > 0 ? [`  Cache counts missing for ${totals.cacheUnknownCalls} older calls`] : []),
						`  Cost:       ${cost}`,
					].join("\n"), "info");
					break;
				}

				case "config": {
					if (!rest) {
						const status = config.enabled ? ctx.ui.theme.fg("success", "enabled") : ctx.ui.theme.fg("dim", "disabled");
						const lines = [
							"Advisor Configuration",
							"",
							`  Status:       ${status}`,
							`  Provider:     ${config.provider}`,
							`  Model:        ${config.model}`,
							`  Max uses/run: ${config.maxUsesPerRun}`,
							`  Max tokens:   ${config.maxTokens}`,
							`  Reasoning:    ${config.reasoning}`,
							`  Context msgs: ${config.maxContextMessages}`,
							"",
							"Usage:",
							"  /advisor on [provider/model]  Enable advisor or choose its model",
							"  /advisor model [search]       Change advisor model",
							"  /advisor off                  Disable advisor",
							"  /advisor config key=value     Set config value",
							"  /advisor ask                  Trigger consultation",
							"  /advisor usage               Show session token and cost totals",
							"",
							"Config keys: provider, model, maxUsesPerRun, maxTokens, reasoning, maxContextMessages",
							`Reasoning levels: ${VALID_REASONING_LEVELS.join(", ")}`,
						];
						ctx.ui.notify(lines.join("\n"), "info");
						return;
					}

					const match = rest.match(/^(\w+)=(.+)$/);
					if (!match) {
						ctx.ui.notify("Invalid format. Use: /advisor config key=value", "warning");
						return;
					}

					const [, key, value] = match;
					switch (key) {
						case "provider":
							config.provider = value;
							break;
						case "model":
							config.model = value;
							break;
						case "maxUsesPerRun": {
							const num = Number.parseInt(value, 10);
							if (Number.isNaN(num) || num < 1) {
								ctx.ui.notify("maxUsesPerRun must be a positive integer", "warning");
								return;
							}
							config.maxUsesPerRun = num;
							break;
						}
						case "maxTokens": {
							const num = Number.parseInt(value, 10);
							if (Number.isNaN(num) || num < 100) {
								ctx.ui.notify("maxTokens must be at least 100", "warning");
								return;
							}
							config.maxTokens = num;
							break;
						}
						case "reasoning": {
							if (!VALID_REASONING_LEVELS.includes(value as ThinkingLevel)) {
								ctx.ui.notify("reasoning must be one of: minimal, low, medium, high, xhigh", "warning");
								return;
							}
							config.reasoning = value as ThinkingLevel;
							break;
						}
						case "maxContextMessages": {
							const num = Number.parseInt(value, 10);
							if (Number.isNaN(num) || num < 4) {
								ctx.ui.notify("maxContextMessages must be at least 4", "warning");
								return;
							}
							config.maxContextMessages = num;
							break;
						}
						default:
							ctx.ui.notify("Unknown config key. Valid keys: provider, model, maxUsesPerRun, maxTokens, reasoning, maxContextMessages", "warning");
							return;
					}

					saveConfig(config);
					ctx.ui.notify(`Set ${key}=${value}`, "info");
					break;
				}

				case "ask": {
					if (!config.enabled) {
						ctx.ui.notify("Advisor is disabled. Use /advisor on to enable.", "warning");
						return;
					}
					const prompt = "Consult the advisor now using the current stage and recent evidence before proceeding.";
					if (ctx.isIdle()) {
						pi.sendUserMessage(prompt);
					} else {
						pi.sendUserMessage(prompt, { deliverAs: "steer" });
					}
					break;
				}

				default: {
					const status = config.enabled ? ctx.ui.theme.fg("success", "enabled") : ctx.ui.theme.fg("dim", "disabled");
					const lines = [
						`Advisor: ${status}`,
						`Model:     ${config.provider}/${config.model}`,
						`Reasoning: ${config.reasoning}`,
						"",
						"Commands:",
						"  /advisor on [provider/model]  Enable advisor (opens picker if omitted)",
						"  /advisor model [search]       Change advisor model",
						"  /advisor off                  Disable advisor",
						"  /advisor config               Show full configuration",
						"  /advisor ask                  Trigger consultation",
						"  /advisor usage               Show session token and cost totals",
					];
					ctx.ui.notify(lines.join("\n"), "info");
				}
			}
		},
	});
}
