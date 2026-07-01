const fs = require("fs");
let code = fs.readFileSync("src/session/call.ts", "utf8");

// Add autoMassivaTimer
code = code.replace(
  "private autoFinanceiroTimer: ReturnType<typeof setTimeout> | null = null;",
  "private autoFinanceiroTimer: ReturnType<typeof setTimeout> | null = null;\n  private autoMassivaTimer: ReturnType<typeof setTimeout> | null = null;"
);

// Add detectProblemaTecnico to userSpeech
code = code.replace(
  "logger.info(`[${callId}] 👤 Cliente (transcrição): ${text}`);",
  "logger.info(`[${callId}] 👤 Cliente (transcrição): ${text}`);\n      if (/internet|conex[aã]o|wi-?fi|wi fi|lent[ao]|caiu|cai|sem sinal|offline|n[aã]o conect|travou|inst[aá]vel|queda|sem internet|parou de funcionar|n[aã]o funciona|sem rede/i.test(text)) {\n        this.ctx.relatouProblemaTecnico = true;\n      }"
);

// Add clearAutoMassiva in tearDown
code = code.replace(
  "if (this.autoFinanceiroTimer) clearTimeout(this.autoFinanceiroTimer);",
  "if (this.autoFinanceiroTimer) clearTimeout(this.autoFinanceiroTimer);\n    if (this.autoMassivaTimer) clearTimeout(this.autoMassivaTimer);"
);

// Add armAutoMassiva method
const massivaMethod = `
  /** Após o financeiro e se houve queixa de internet, aciona massiva automaticamente para forçar o sequenciamento */
  private armAutoMassiva(callId: string): void {
    this.clearAutoMassiva();
    this.autoMassivaTimer = setTimeout(() => {
      this.autoMassivaTimer = null;
      if (this.tearing || this.socket.destroyed || this.ctx.consultaMassivaFeita) return;
      if (this.toolsInFlight > 0 || this.rt.isResponseActive() || this.rt.isResponsePending()) {
        this.armAutoMassiva(callId);
        return;
      }
      logger.info(\`[\${callId}] Auto: verificar_massiva após financeiro (via speech sequencial)\`);
      void this.rt.runServerTool("verificar_massiva", {});
    }, 500);
  }

  private clearAutoMassiva(): void {
    if (this.autoMassivaTimer) {
      clearTimeout(this.autoMassivaTimer);
      this.autoMassivaTimer = null;
    }
  }
`;

code = code.replace(
  "private clearAutoFinanceiro(): void {",
  massivaMethod + "\n  private clearAutoFinanceiro(): void {"
);

// Add to responseDone
code = code.replace(
  "this.rt.on('responseDone', () => {",
  "this.rt.on('responseDone', () => {\n        if (this.ctx.relatouProblemaTecnico && this.ctx.consultaFinanceiraFeita && !this.ctx.consultaMassivaFeita) {\n          this.armAutoMassiva(callId);\n        }"
);

fs.writeFileSync("src/session/call.ts", code);
console.log("Done");
