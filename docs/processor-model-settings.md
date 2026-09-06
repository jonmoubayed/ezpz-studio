# Processor model settings

Open a processor’s **Extraction settings → Model settings**. The controls depend on the selected model:

| Control | Behavior |
| --- | --- |
| Reasoning effort | Uses the supported effort levels for OpenAI and Claude, and thinking levels for Gemini 3. Leaving it unset uses the provider default. |
| Output token limit | Caps the generated tokens, including reasoning. The existing app default is 4096; each model still enforces its own maximum. |
| Thinking token budget | Available for Gemini 2.5 and supported older Claude models. Claude budgets must be smaller than the total output limit. Gemini accepts -1 for automatic thinking. |
| Temperature / Top P | Shown for configurations that support sampling. Claude uses one sampling control at a time; thinking configurations omit sampling parameters. |
| Response verbosity | Available for GPT-5 models. Controls response length separately from reasoning effort. |
| Output format | JSON object or strict JSON schema for OpenAI and Gemini. |
| System instructions | Overrides the default system prompt, separately from the extraction instructions. |

Settings are stored in the processor version’s `prompt` object. They survive saves, reloads, previews, and evaluation snapshots. **Reset model settings** removes the overrides when saving the next version. Earlier versions remain unchanged. Switching models resets model-specific controls and retains the output limit and system instructions. Numeric ranges and reasoning options are validated before the UI sends a configuration or an adapter calls its provider.

The public demo stores these settings locally and continues to use simulated extraction results.

Capabilities are defined in `backend/model_settings.py`. `python3 scripts/export-model-suggestions.py` exports the same rules to the frontend. Unknown model families expose basic controls; they do not assume support for unverified effort levels.

Provider references: [OpenAI reasoning](https://developers.openai.com/api/docs/guides/latest-model), [OpenAI Chat Completions controls](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort), and [Gemini generateContent thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking?hl=en).
