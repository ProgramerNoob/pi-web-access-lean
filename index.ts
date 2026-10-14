// pi-web-access-lean: one provider-facing facade over the full pi-web-access runtime.
// Detailed operation schemas stay local and are disclosed only through `help`.
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import webAccess from "pi-web-access/index.ts";
import { extractPDFToMarkdown, loadPDFConfig } from "pi-web-access/pdf-extract.ts";
import { Type } from "typebox";
const COLLAPSED_DISPLAY_SERVICE = Symbol.for(
  "@local/pi-collapsed-tools.display-service.v1",
);

type CollapsedDisplayTool = { name: string };
type CollapsedDisplayService = {
  readonly version: 1;
  decorate<T extends CollapsedDisplayTool>(tool: T): T;
};

function decorateWithCollapsedDisplay<T extends CollapsedDisplayTool>(tool: T): T {
  const services = globalThis as unknown as Record<PropertyKey, unknown>;
  const candidate = services[COLLAPSED_DISPLAY_SERVICE];
  if (!candidate || typeof candidate !== "object") return tool;
  const service = candidate as Partial<CollapsedDisplayService>;
  return service.version === 1 && typeof service.decorate === "function"
    ? service.decorate(tool)
    : tool;
}

type CapturedTool = ToolDefinition<any, any, any>;
type UpstreamExtension = (pi: ExtensionAPI) => void;

const ROUTES = {
  search: { toolName: "web_search", inputName: "query" },
  check: { toolName: "source_check", inputName: "claim" },
  fetch: { toolName: "fetch_content", inputName: "url" },
  get: { toolName: "get_search_content", inputName: "responseId" },
} as const;

type Operation = keyof typeof ROUTES;
type FacadeOperation = Operation | "help";

const FACADE_PARAMETERS = Type.Object({
  op: Type.Unsafe<FacadeOperation>({
    type: "string",
    enum: ["search", "check", "fetch", "get", "help"],
  }),
  input: Type.Optional(Type.String({
    description: "Main query, claim, URL, local PDF path, or responseId; use a JSON object string for advanced parameters",
  })),
});

// Upstream 0.31+ hides its tools behind `web_enable` and toggles the active tool set,
// which changes the tool list mid-session and breaks prompt caching. The facade is
// always active, so drop the loader and never let upstream change active tools.
const UPSTREAM_LOADER = "web_enable";

function capturePi(
  pi: ExtensionAPI,
  tools: Map<string, CapturedTool>,
): ExtensionAPI {
  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") {
        return (tool: CapturedTool) => {
          if (tool.name !== UPSTREAM_LOADER) tools.set(tool.name, tool);
        };
      }
      if (property === "setActiveTools") return () => undefined;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function parseInput(input: string, inputName: string): Record<string, unknown> {
  if (!input.trimStart().startsWith("{")) return { [inputName]: input };

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`web_access input is invalid JSON: ${reason}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("web_access advanced input must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

// Upstream result hints name its hidden retrieval tool, e.g.
// get_search_content({ responseId: "id", urlIndex: 0 }); point them at the facade.
// Only exact upstream hint forms are rewritten so fetched page text stays intact.
const RETRIEVAL_TOOL = ROUTES.get.toolName;
const GET_CALL = 'web_access op "get"';
const RETRIEVAL_CALL = new RegExp(`\\b${RETRIEVAL_TOOL}\\(\\{([^{}]*)\\}\\)`, "g");
const HINT_ARG = /^\s*(responseId|urlIndex|queryIndex|offset|limit):\s*("[\w-]*"|\d+)\s*$/;
const RETRIEVAL_PHRASES: Array<[RegExp, string]> = [
  [new RegExp(`\\bEnable ${RETRIEVAL_TOOL} to retrieve\\b`, "g"), `Enable ${GET_CALL} to retrieve`],
  [new RegExp(`\\buse ${RETRIEVAL_TOOL} findText or offset\\b`, "g"), `use ${GET_CALL} with findText or offset`],
  [new RegExp(`\\buse \`${RETRIEVAL_TOOL}\` with\\b`, "g"), `use ${GET_CALL} with`],
  [new RegExp(`\\bretrieval with ${RETRIEVAL_TOOL}\\b`, "g"), `retrieval with ${GET_CALL}`],
];

function facadeGetCall(match: string, body: string): string {
  const args: Record<string, unknown> = {};
  for (const part of body.split(",")) {
    const pair = part.match(HINT_ARG);
    if (!pair) return match;
    args[pair[1]] = JSON.parse(pair[2]);
  }
  return `web_access({ op: "get", input: '${JSON.stringify(args)}' })`;
}

function rewriteRetrievalHints(text: string): string {
  let rewritten = text.replace(RETRIEVAL_CALL, facadeGetCall);
  for (const [pattern, replacement] of RETRIEVAL_PHRASES) {
    rewritten = rewritten.replace(pattern, replacement);
  }
  return rewritten;
}

function withFacadeHints<T>(result: T): T {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return result;
  return {
    ...result,
    content: content.map((entry) =>
      entry?.type === "text" && typeof entry.text === "string"
        ? { ...entry, text: rewriteRetrievalHints(entry.text) }
        : entry),
  };
}

function helpResult(
  operation: string,
  tools: Map<string, CapturedTool>,
) {
  const route = ROUTES[operation as Operation];
  if (!route) {
    return {
      content: [{
        type: "text" as const,
        text: "Operations: search(query), check(claim), fetch(URL or local PDF), get(responseId). For advanced parameters, call help with input set to one operation name.",
      }],
      details: { operation: "help" },
    };
  }

  const tool = tools.get(route.toolName);
  if (!tool) throw new Error(`web_access could not find upstream tool: ${route.toolName}`);
  const text = [
    `${operation} routes to ${route.toolName}`,
    tool.description,
    "Advanced input must be a JSON object string matching this schema:",
    JSON.stringify(tool.parameters, null, 2),
  ].filter(Boolean).join("\n\n");
  return {
    content: [{ type: "text" as const, text }],
    details: { operation, toolName: route.toolName },
  };
}
interface LocalPDFInfo {
  absolutePath: string;
  sizeBytes: number;
}

function resolveLocalPDF(input: string): LocalPDFInfo | null {
  const trimmed = input.trim();
  const isLocal =
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith(".\\") ||
    trimmed.startsWith("..\\") ||
    trimmed.startsWith("file://") ||
    trimmed.startsWith("file:") ||
    trimmed.startsWith("\\\\") ||
    /^[a-zA-Z]:[\\/]/.test(trimmed);
  if (!isLocal) return null;

  let filePath = trimmed;
  if (trimmed.startsWith("file:")) {
    try {
      filePath = fileURLToPath(trimmed);
    } catch {
      return null;
    }
  }

  if (extname(filePath).toLowerCase() !== ".pdf") return null;

  const absolutePath = resolve(filePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }
  const stat = statSync(absolutePath);
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${absolutePath}`);
  }
  return { absolutePath, sizeBytes: stat.size };
}

async function executeLocalPDF(
  url: string,
  localPdf: LocalPDFInfo,
  parsed: Record<string, unknown>,
  signal?: AbortSignal,
) {
  if (parsed.mode === "raw") {
    return {
      content: [{ type: "text" as const, text: "Error: Unsupported content type in raw mode: application/pdf" }],
      details: { error: "Unsupported content type in raw mode: application/pdf" },
    };
  }

  const pdfConfig = loadPDFConfig();
  if (!pdfConfig.enabled) {
    return {
      content: [{ type: "text" as const, text: "Error: PDF extraction is disabled by pdf.enabled" }],
      details: { error: "PDF extraction is disabled by pdf.enabled" },
    };
  }

  const maxBytes = pdfConfig.maxSizeMB * 1024 * 1024;
  if (localPdf.sizeBytes > maxBytes) {
    const errorMsg = `PDF exceeds configured pdf.maxSizeMB limit (${pdfConfig.maxSizeMB} MB)`;
    return {
      content: [{ type: "text" as const, text: `Error: ${errorMsg}` }],
      details: { error: errorMsg },
    };
  }

  if (signal?.aborted) {
    return {
      content: [{ type: "text" as const, text: "Error: Request was aborted." }],
      details: { error: "Request was aborted" },
    };
  }

  const fileBuffer = readFileSync(localPdf.absolutePath);
  const buffer = fileBuffer.buffer.slice(
    fileBuffer.byteOffset,
    fileBuffer.byteOffset + fileBuffer.byteLength,
  );

  try {
    const result = await extractPDFToMarkdown(buffer, localPdf.absolutePath, { signal });
    return {
      content: [{
        type: "text" as const,
        text: `PDF extracted and saved to: ${result.outputPath}\n\nPages: ${result.pages}\nCharacters: ${result.chars}`,
      }],
      details: {
        urls: [url],
        urlCount: 1,
        successful: 1,
        totalChars: result.chars,
        title: result.title,
        pages: result.pages,
        outputPath: result.outputPath,
        mode: (parsed.mode as string) ?? "readable",
        mimeType: "application/pdf",
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: `Error: PDF extraction failed: ${message}` }],
      details: { error: `PDF extraction failed: ${message}` },
    };
  }
}

export function createWebAccessFacade(
  upstream: UpstreamExtension = webAccess,
): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI): void => {
    const tools = new Map<string, CapturedTool>();
    upstream(capturePi(pi, tools));
    const facadeTool: ToolDefinition<typeof FACADE_PARAMETERS, unknown, unknown> = {
      name: "web_access",
      label: "Web Access",
      description: "Search, verify, fetch web or local PDF content, or continue results through one router. Use help for advanced parameters.",
      promptGuidelines: [
        "web_access: input is the query, claim, URL, local PDF path, or responseId for search, check, fetch, or get. Pass a JSON object string for batch or advanced parameters; use help only when fields are unclear.",
      ],
      parameters: FACADE_PARAMETERS,
      async execute(callId, params, signal, onUpdate, ctx) {
        if (params.op === "help") {
          return helpResult((params.input ?? "").trim(), tools);
        }

        const route = ROUTES[params.op];
        if (!route) {
          throw new Error(`web_access operation is not implemented: ${params.op}`);
        }
        const parsed = parseInput(params.input ?? "", route.inputName);
        if (params.op === "fetch" && typeof parsed.url === "string") {
          const localPdf = resolveLocalPDF(parsed.url);
          if (localPdf) {
            return executeLocalPDF(parsed.url, localPdf, parsed, signal);
          }
        }
        const tool = tools.get(route.toolName);
        if (!tool) {
          throw new Error(`web_access could not find upstream tool: ${route.toolName}`);
        }
        const args = tool.prepareArguments ? tool.prepareArguments(parsed) : parsed;
        return withFacadeHints(await tool.execute(
          callId,
          args,
          signal,
          onUpdate,
          ctx,
        ));
      },
    };
    pi.registerTool(decorateWithCollapsedDisplay(facadeTool));
  };
}

export default createWebAccessFacade();
