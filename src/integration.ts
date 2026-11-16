import type { AstroIntegration } from "astro";
import type {
  AstroBuildDoneHookInput,
  AstroBuildStartHookInput,
  IntegrationDefaults,
  IntegrationInput,
  IntegrationOptions,
} from "./types.js";
import { buildDoneHook, speculativePreRender, type BuildDoneHookInput } from "./hook.js";
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

  // Skip speculative pre-render if the render function source depends on `dir`,
  // as the speculative pass uses a dummy URL which would produce a different cache key/result.
  const requiresDir = /\bdir\b/.test(render.toString());

  return {
    name: "astro-takumi",
    hooks: {
      "astro:build:start": ({ logger }: AstroBuildStartHookInput) => {
        if (optionsWithDefaults.speculative === true && optionsWithDefaults.cache !== false && !requiresDir) {
          const p = speculativePreRender({ logger, options: optionsWithDefaults, render, globalKey });
          // Attach rejection handler immediately to prevent unhandled promise rejection
          p.catch(() => { /* ignore unhandled speculative rejection */ });
          speculative = p;
        }
      },
      "astro:build:done": async (entry: AstroBuildDoneHookInput) => {
        const input: BuildDoneHookInput = {
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
