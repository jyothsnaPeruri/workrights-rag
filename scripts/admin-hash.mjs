// Generates the admin credentials for your environment settings. Run it on
// your own machine:  npm run admin:hash
//
// The password is read without echoing and is never written anywhere — only the
// derived hash is printed, and that is what goes into the environment. Nobody
// helping you set this up ever needs to see the password itself.

import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { hashPassword } from "../server/auth.mjs";

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Overwrite the line on every keypress so the typed characters never show.
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
}

const password = await askHidden("Choose an admin password: ");
if (password.length < 12) {
  console.error("\nToo short — use at least 12 characters. This guards a public endpoint.");
  process.exit(1);
}
if ((await askHidden("Type it again: ")) !== password) {
  console.error("\nThose don't match.");
  process.exit(1);
}

console.log("\nAdd these to .env locally, and to App Service > Environment variables:\n");
console.log("ADMIN_USERNAME=jo");
console.log(`ADMIN_PASSWORD_HASH=${await hashPassword(password)}`);
console.log(`JWT_SECRET=${randomBytes(48).toString("base64url")}`);
console.log("\nThe password itself is not stored anywhere — keep it in your password manager.");
