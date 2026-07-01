const fs = require("fs");
let code = fs.readFileSync("src/session/call.ts", "utf8");

// Fix consultaFinanceiraFeita
code = code.replace(
  "if (name === 'consultar_financeiro') {\n        this.clearAutoFinanceiro();",
  "if (name === 'consultar_financeiro') {\n        this.ctx.consultaFinanceiraFeita = true;\n        this.clearAutoFinanceiro();"
);

fs.writeFileSync("src/session/call.ts", code);

let hCode = fs.readFileSync("src/tools/handlers.ts", "utf8");
hCode = hCode.replace(
  "return orientacao + ' ATENÇÃO: Consulta financeira concluída. AGORA VOCÊ DEVE FALAR com o cliente (gere a sua resposta em texto para voz). Se ele já relatou problema de internet, DÊ o aviso financeiro e adicione APENAS a frase \"Vou dar uma olhada na rede para ver se tem algum alerta na sua região\". NÃO chame ferramentas. O sistema acionará a massiva automaticamente após você falar.';",
  "return orientacao + ' ATENÇÃO: Consulta financeira concluída. AGORA VOCÊ DEVE FALAR com o cliente (gere a sua resposta em texto para voz). Se ele já relatou problema de internet, DÊ o aviso financeiro e adicione a frase: \"Vou dar uma olhada na rede para ver se tem algum alerta na sua região\". Em seguida conclua sua fala normalmente.';"
);
fs.writeFileSync("src/tools/handlers.ts", hCode);

console.log("Done");
