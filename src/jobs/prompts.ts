import fs from "node:fs";
import path from "node:path";

// System prompts are authored as markdown under prompts/ at the repo root and
// loaded into a ProcessStep at job-definition time, so the process map carries
// its own instructions. Resolved from process.cwd() like the rest of the app.
const PROMPTS_DIR = path.resolve(process.cwd(), "prompts");

// Reads prompts/<name>.md. Throws on a missing or empty file so a job that
// references a prompt fails loudly at definition time, not mid-run.
export function loadPrompt(name: string): string {
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("[prompts.loadPrompt] name must be a non-empty string");
  }
  const file = path.join(PROMPTS_DIR, `${name}.md`);
  const text = readFile(file);
  if (text.trim() === "") throw new Error(`[prompts.loadPrompt] prompt file is empty: ${file}`);
  return text.trim();
}

// Every model-facing guidance string lives in ONE file, prompts/guidance.json:
// a section per step (named after the step's .md prompt), each a flat map of
// non-empty strings keyed by output field.
const GUIDANCE_FILE = path.join(PROMPTS_DIR, "guidance.json");

// Reads one section out of prompts/guidance.json. Same fail-loudly contract as
// loadPrompt — a missing file, bad JSON, a malformed section, or an unknown
// section name throws at job-definition time.
export function loadGuidance(section: string): Record<string, string> {
  if (typeof section !== "string" || section.trim() === "") {
    throw new Error("[prompts.loadGuidance] section must be a non-empty string");
  }
  const record = parseGuidance(readFile(GUIDANCE_FILE), GUIDANCE_FILE)[section];
  if (record === undefined) {
    throw new Error(`[prompts.loadGuidance] prompts/guidance.json is missing section "${section}"`);
  }
  return record;
}

// Reads one guidance string out of prompts/guidance.json. Throws when the key
// is absent, so a job that references missing guidance fails at definition time.
export function loadGuidanceKey(section: string, key: string): string {
  if (typeof key !== "string" || key.trim() === "") {
    throw new Error("[prompts.loadGuidanceKey] key must be a non-empty string");
  }
  const text = loadGuidance(section)[key];
  if (text === undefined) {
    throw new Error(`[prompts.loadGuidanceKey] prompts/guidance.json is missing "${section}.${key}"`);
  }
  return text;
}

function parseGuidance(text: string, file: string): Record<string, Record<string, string>> {
  const data: unknown = parseJson(text, file);
  if (!isObject(data)) throw new Error(`[prompts.parseGuidance] expected a JSON object: ${file}`);
  for (const [section, record] of Object.entries(data)) {
    validateSection(section, record, file);
  }
  return data as Record<string, Record<string, string>>;
}

function validateSection(section: string, record: unknown, file: string): void {
  if (!isObject(record)) {
    throw new Error(`[prompts.parseGuidance] section "${section}" must be a JSON object: ${file}`);
  }
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`[prompts.parseGuidance] "${section}.${key}" must be a non-empty string: ${file}`);
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`[prompts.parseGuidance] invalid JSON in ${file} (${message(error)})`);
  }
}

function readFile(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`[prompts.readFile] cannot read prompt file: ${file} (${message(error)})`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
