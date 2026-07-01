const fs = require("fs");
let code = fs.readFileSync("src/realtime/client.ts", "utf8");

code = code.replace(
  "async runServerTool(name: string, args: Record<string, unknown> = {}): Promise<unknown | null> {",
  "async runServerTool(name: string, args: Record<string, unknown> = {}, options?: { silentResponse?: boolean }): Promise<unknown | null> {"
);

code = code.replace(
  "this.createResponse(true);\n      this.emit('toolDone', name, result, { serverSide: true });",
  "if (!options?.silentResponse) { this.createResponse(true); }\n      this.emit('toolDone', name, result, { serverSide: true });"
);

// Check if toolsInFlight was changed
if (code.includes("this.emit('toolDone', name, result, { serverSide: true });\n      this.toolsInFlight--;")) {
  code = code.replace(
    "this.emit('toolDone', name, result, { serverSide: true });\n      this.toolsInFlight--;",
    "this.toolsInFlight--;\n      this.emit('toolDone', name, result, { serverSide: true });"
  );
}

fs.writeFileSync("src/realtime/client.ts", code);
console.log("Done");
