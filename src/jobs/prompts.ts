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

function readFile(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`[prompts.loadPrompt] cannot read prompt file: ${file} (${message(error)})`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
