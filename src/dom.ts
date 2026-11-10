import type { DomBackend } from "./types.js";

interface QueryableDocument {
  querySelector(selectors: string): { getAttribute(name: string): string | null } | null;
}

function toDocument(value: QueryableDocument): Document {
  // SAFETY: querySelector/getAttribute are the DOM APIs consumed by extract(); the full
  // global Document surface is not available from happy-dom's document type.
  return value as Document;
}

/**
 * Parse an HTML string into a DOM document using the selected backend.
 *
 * Every backend — including the `jsdom` default — is loaded with a dynamic
 * `import()` so that selecting one backend never eagerly evaluates another.
 * This matters on Node >= 24 where statically importing `jsdom@31` can trip
 * the parse5 ESM-in-CJS-require bug even when jsdom is never used.
 */
export async function createDocument(html: string, backend: DomBackend = "jsdom"): Promise<Document> {
  switch (backend) {
    case "jsdom": {
      const { JSDOM } = await import("jsdom");
      return new JSDOM(html).window.document;
    }
    case "linkedom": {
      const { parseHTML } = await import("linkedom");
      return parseHTML(html).document;
    }
    case "happy-dom": {
      const { Window } = await import("happy-dom");
      const window = new Window();
      window.document.write(html);
      return toDocument(window.document);
    }
  }
}
