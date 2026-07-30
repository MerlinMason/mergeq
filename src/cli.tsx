export {};

// Chalk reads the environment when it is first imported, and ignores NO_COLOR
// under Bun. Static imports are hoisted, so the translation below has to happen
// in a module that imports nothing — hence the dynamic import of the real entry
// point. Collapsing this file into main.tsx silently breaks NO_COLOR.
if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
  process.env.FORCE_COLOR = "0";
}

await import("./main.js");
