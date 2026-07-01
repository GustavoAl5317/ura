const fs = require("fs");
let code = fs.readFileSync("src/tools/handlers.ts", "utf8");
code = code.replace(
  "  return orientacao;\n}",
  "  orientacao += \" ATENÇÃO: Após informar sobre a situação financeira, diga \\\"Vou verificar se há algum problema na rede na sua região\\\" e CHAME A FERRAMENTA verificar_massiva EM SILÊNCIO (sem gerar texto).\";\n  return orientacao;\n}"
);
fs.writeFileSync("src/tools/handlers.ts", code);
console.log("Done");
