const fs = require("fs");
let code = fs.readFileSync("src/tools/handlers.ts", "utf8");
code = code.replace(
  "return orientacao;",
  "orientacao += \" ATENÇÃO: Após falar a situação financeira, diga \\\"Vou dar uma olhada na rede\\\" e CHAME A FERRAMENTA verificar_massiva EM SILÊNCIO (sem gerar texto).\";\\n    return orientacao;"
);
fs.writeFileSync("src/tools/handlers.ts", code);
console.log("Fixed handlers.ts");
