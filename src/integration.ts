import type { AstroIntegration } from "astro";
import type {
  AstroBuildDoneHookInput,
  AstroBuildStartHookInput,
  IntegrationDefaults,
  IntegrationInput,
  IntegrationOptions,
} from "./types.js";
import { buildDoneHook, speculativePreRender } from "./hook.js";
import { computeGlobalKey, readVersions } from "./cache.js";

const defaults: IntegrationDefaults = {
  width: 1200,
  height: 630,
  format: "png",
  quality: 100,
  verbose: false,
  drawDebugBorder: false,
  domBackend: "linkedom",
};

export function astroTakumi({ options, render }: IntegrationInput): AstroIntegration {
  const optionsWithDefaults: IntegrationOptions = { ...defaults, ...options };
  const globalKey = computeGlobalKey({ render, options: optionsWithDefaults, versions: readVersions() });
  let speculative: Promise<void> | undefined;

  return {
    name: "astro-takumi",
    hooks: {
      "astro:build:start": ({ logger }: AstroBuildStartHookInput) => {
        if (optionsWithDefaults.speculative === true && optionsWithDefaults.cache !== false) {
          speculative = speculativePreRender({ logger, options: optionsWithDefaults, render, globalKey });
        }
      },
      "astro:build:done": async (entry: AstroBuildDoneHookInput) => {
        // SAFETY: AstroBuildDoneHookInput has exactOptionalPropertyTypes. We use 'any' to
        // conditionally add 'speculative' without triggering TS2352 overlap errors.
        const input: any = {
          ...entry,
          options: optionsWithDefaults,
          render,
          globalKey,
        };
        if (speculative !== undefined) {
          input.speculative = speculative;
        }
        return buildDoneHook(input);
      },
    },
  };
}
