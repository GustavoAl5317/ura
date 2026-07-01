const fs = require("fs");
let code = fs.readFileSync("src/tools/handlers.ts", "utf8");
code = code.replace(
  "return orientacao + ' ATENÇÃO: Consulta financeira concluída. AGORA VOCÊ DEVE FALAR com o cliente (gere a sua resposta em texto para voz). Pergunte como pode ajudar, OU se ele já relatou problema de internet, chame verificar_massiva.';",
  "return orientacao + ' ATENÇÃO: Consulta financeira concluída. AGORA VOCÊ DEVE FALAR com o cliente (gere a sua resposta em texto). Se ele já relatou problema de internet, DÊ o aviso financeiro e adicione: \\\"Vou dar uma olhada na rede para ver se tem algum alerta na sua região\\\". EM SEGUIDA (ou ao mesmo tempo) CHAME verificar_massiva.';"
);
fs.writeFileSync("src/tools/handlers.ts", code);
console.log("Done");
