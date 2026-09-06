import rules from "./model-settings-catalog.json" with { type: "json" };

export type ModelSettings = {
  reasoning_effort?: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  thinking_budget?: number;
  verbosity?: string;
  structured_outputs?: boolean;
  system?: string;
};
export const settingKeys = ["reasoning_effort", "max_tokens", "temperature", "top_p", "thinking_budget", "verbosity", "structured_outputs", "system"] as const;
type Capabilities = {
  efforts: string[]; sampling: boolean; verbosity: boolean; strict: boolean;
  adaptive: boolean; budget_min?: number; budget_max?: number;
};
export function modelCapabilities(provider: string, model: string): Capabilities {
  if (provider === "google") provider = "gemini";
  const rule = rules.find(rule => rule.provider === provider && rule.prefixes.some(prefix => model.toLowerCase().startsWith(prefix)));
  return { efforts: [], sampling: provider !== "local", verbosity: false, strict: ["openai", "gemini"].includes(provider), adaptive: false, ...rule };
}
export function readModelSettings(prompt: Record<string, unknown> = {}): ModelSettings {
  return Object.fromEntries(settingKeys.filter(key => prompt[key] !== undefined).map(key => [key, prompt[key]]));
}
export function settingsAfterModelChange(settings: ModelSettings = {}): ModelSettings {
  // Token limit and system instructions are portable; model-specific controls reset.
  return Object.fromEntries(["max_tokens", "system"].filter(key => settings[key as keyof ModelSettings] !== undefined).map(key => [key, settings[key as keyof ModelSettings]]));
}
export function modelSettingsError(provider: string, model: string, settings: ModelSettings = {}): string {
  const caps = modelCapabilities(provider, model);
  for (const [key, min, max, integer] of [["max_tokens", 1, 1000000, true], ["temperature", 0, provider === "anthropic" ? 1 : 2, false], ["top_p", 0, 1, false]] as const) {
    const value = settings[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))) return `${key === "max_tokens" ? "Output token limit" : key === "top_p" ? "Top P" : "Temperature"} must be ${integer ? "a whole number " : ""}between ${min} and ${max}.`;
  }
  if (settings.reasoning_effort !== undefined && !caps.efforts.includes(settings.reasoning_effort)) return "Choose a reasoning effort supported by this model.";
  if (settings.verbosity !== undefined && (!caps.verbosity || !["low", "medium", "high"].includes(settings.verbosity))) return "Choose a verbosity supported by this model.";
  const budget = settings.thinking_budget;
  if (budget !== undefined) {
    const dynamic = ["google", "gemini"].includes(provider) && budget === -1;
    if (caps.budget_min === undefined || !Number.isInteger(budget) || (!dynamic && (budget < caps.budget_min || budget > caps.budget_max!))) return "Thinking token budget is outside this model’s supported range.";
    if (provider === "anthropic" && budget >= (settings.max_tokens ?? 4096)) return "Thinking token budget must be smaller than the output token limit.";
  }
  return "";
}
export function settingsPrompt(config: { provider: string; model: string; prompt: string; modelSettings?: ModelSettings }, base: Record<string, unknown> = {}) {
  const error = modelSettingsError(config.provider, config.model, config.modelSettings);
  if (error) throw new Error(error);
  const prompt = { ...base };
  // Undefined means an older client; an empty object explicitly resets the controls.
  if (config.modelSettings !== undefined) for (const key of settingKeys) delete prompt[key];
  return { ...prompt, ...readModelSettings(config.modelSettings), extraction: config.prompt };
}
