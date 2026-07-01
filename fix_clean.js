const fs = require("fs");
let code = fs.readFileSync("src/session/call.ts", "utf8");

code = code.replace(/private scheduleFinanceiroTts[\s\S]*?private clearFinanceiroTts/, "private clearFinanceiroTts");

fs.writeFileSync("src/session/call.ts", code);
console.log("Done");
