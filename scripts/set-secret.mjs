// Writes a secret into .env without it appearing on screen, in your shell
// history, or anywhere it could be copied by accident.
//
//   npm run set-secret GROQ_API_KEY
//
// Prompts for the value with echo suppressed, then updates or appends that one
// line in .env. Existing values are replaced in place, so re-running it is how
// you rotate a key.

import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const name = process.argv[2];
if (!name || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
  console.error("Usage: npm run set-secret GROQ_API_KEY");
  process.exit(1);
}

const value = await new Promise((resolve) => {
  const prompt = `Paste the value for ${name} (it will not be shown): `;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const hide = () => {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(prompt);
  };
  process.stdin.on("data", hide);
  rl.question(prompt, (answer) => {
    process.stdin.off("data", hide);
    rl.close();
    process.stdout.write("\n");
    resolve(answer.trim());
  });
});

if (!value) {
  console.error("Nothing entered — .env unchanged.");
  process.exit(1);
}

const path = new URL("../.env", import.meta.url);
const current = await readFile(path, "utf8").catch(() => "");
const line = `${name}=${value}`;
const pattern = new RegExp(`^${name}=.*$`, "m");

const next = pattern.test(current)
  ? current.replace(pattern, line)
  : `${current.replace(/\n*$/, "\n")}${line}\n`;

await writeFile(path, next);
// Confirm without revealing: enough to spot a paste that picked up whitespace.
console.log(`Saved ${name} to .env (${value.length} characters, starts "${value.slice(0, 4)}…").`);
