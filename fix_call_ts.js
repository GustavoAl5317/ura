const fs = require("fs");
let code = fs.readFileSync("src/session/call.ts", "utf8");

code = code.replace(
  /if \(name === 'consultar_financeiro' && result && typeof result === 'object'\) \{[\s\S]*?this\.scheduleFinanceiroTts\(callId, speech\);\n        \}\n      \}/,
  "if (name === 'consultar_financeiro') {\n        this.ctx.consultaFinanceiraFeita = true;\n      }"
);

// Also remove `scheduleFinanceiroTts` and `speakFinanceiroDirect` entirely to clean up
code = code.replace(
  /private scheduleFinanceiroTts[\s\S]*?this\.waitingAnaAfterTool = false;\n      this\.stopTypingSound\(\);\n      this\.enqueueToolResultSpeech\(callId, speech\);\n    \}/,
  ""
);

fs.writeFileSync("src/session/call.ts", code);
console.log("Done");
