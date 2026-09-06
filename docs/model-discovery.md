# Model discovery

In the standalone studio's extraction settings, choose a provider and select an available model, or type a custom model ID. Opening a provider automatically checks its model catalog. **Check for new models** repeats the check without changing the selected model or any saved processor version.

The backend uses `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY`. OpenAI-compatible endpoints prefer `OPENAI_COMPATIBLE_API_KEY`, with `OPENAI_API_KEY` as a fallback. Ollama discovery does not send a hosted provider key. These checks only list models; they do not run inference or download model weights.

The catalog follows provider pagination, removes duplicate IDs, and puts recently created models first where the provider supplies creation dates. Provider errors and missing credentials return an explicitly labeled built-in list. A failed refresh keeps the picker’s last successful suggestions. Availability still depends on the provider account and the endpoint's capabilities.

The public demo shows the bundled suggestions and disables live checks. It never calls a provider.

The built-in list was verified on September 6, 2026 against the official [OpenAI model catalog](https://developers.openai.com/api/docs/models), [Claude model catalog](https://platform.claude.com/docs/en/models/overview), and [Gemini model catalog](https://ai.google.dev/gemini-api/docs/models). Pricing is separate metadata: model-list APIs generally do not supply rates, and unrecognized models retain unknown pricing. Only exact IDs and dated snapshots inherit a registered rate.

To update offline suggestions, edit `BUILTIN_MODEL_IDS` and `BUILTIN_CATALOG_UPDATED_AT` in `backend/model_catalog.py`, then run:

```sh
python3 scripts/export-model-suggestions.py
python3 scripts/export-model-suggestions.py --check
```

The export is offline. It does not read credentials or contact providers. Both backend adapter metadata and the frontend suggestions use this catalog. Live discovery can expose new models before the offline list is updated.

Configure reasoning effort, output limits, and other controls in [processor model settings](processor-model-settings.md).
