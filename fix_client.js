const fs = require("fs");
let code = fs.readFileSync("src/realtime/client.ts", "utf8");

// Fix runServerTool
code = code.replace(
  "async runServerTool(name: string, args: any): Promise<void> {",
  "async runServerTool(name: string, args: any, options?: { silentResponse?: boolean }): Promise<void> {"
);

code = code.replace(
  "this.createResponse(true);\n      this.emit('toolDone', name, result, { serverSide: true });",
  "if (!options?.silentResponse) { this.createResponse(true); }\n      this.emit('toolDone', name, result, { serverSide: true });"
);

// Also apply the toolsInFlight race condition fix
code = code.replace(
  "this.emit('toolDone', name, result, { serverSide: true });\n      this.toolsInFlight--;",
  "this.toolsInFlight--;\n      this.emit('toolDone', name, result, { serverSide: true });"
);

fs.writeFileSync("src/realtime/client.ts", code);
console.log("Done");
