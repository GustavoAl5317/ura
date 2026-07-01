const fs = require("fs");
let code = fs.readFileSync("src/session/call.ts", "utf8");

// Fix multiplos_contratos
code = code.replace(
  "const r = result as { sucesso?: boolean; confirmado?: boolean } | undefined;\n          if (r?.sucesso && r?.confirmado) {",
  "const r = result as { sucesso?: boolean; confirmado?: boolean; multiplos_contratos?: boolean } | undefined;\n          if (r?.sucesso && r?.confirmado && !r?.multiplos_contratos) {"
);

// Fix silentResponse in armAutoFinanceiro
code = code.replace(
  "void this.rt.runServerTool('consultar_financeiro', {\n        cliente_id: this.ctx.cliente?.contratoId,\n      });",
  "void this.rt.runServerTool('consultar_financeiro', {\n        cliente_id: this.ctx.cliente?.contratoId,\n      }, { silentResponse: true });"
);

// Fix silentResponse in armAutoMassiva
code = code.replace(
  "void this.rt.runServerTool('verificar_massiva', {});",
  "void this.rt.runServerTool('verificar_massiva', {}, { silentResponse: true });"
);

// Fix watchdog clearing before delays
code = code.replace(
  "this.scheduleFinanceiroTts(callId, speech);",
  "this.clearPostToolSpeechWatchdog();\n        this.scheduleFinanceiroTts(callId, speech);"
);

code = code.replace(
  "this.scheduleMassivaTts(callId, speech);",
  "this.clearPostToolSpeechWatchdog();\n        this.scheduleMassivaTts(callId, speech);"
);

// Also fix fallback watchdog (just in case)
code = code.replace(
  "if (this.pendingFalaObrigatoria || this.pendingDirectSpeech || this.financeiroTtsTimer || this.massivaTtsTimer) {\n            return;\n          }",
  "if (this.pendingFalaObrigatoria || this.pendingDirectSpeech || this.financeiroTtsTimer || this.massivaTtsTimer) {\n            this.clearPostToolSpeechWatchdog();\n            return;\n          }"
);

fs.writeFileSync("src/session/call.ts", code);
console.log("Done");
