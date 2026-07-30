export {};

if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
  process.env.FORCE_COLOR = "0";
}

await import("./main.js");
