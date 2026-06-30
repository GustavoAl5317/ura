import * as fs from 'fs';
const file = 'src/config.ts';
let content = fs.readFileSync(file, 'utf8');

content = content.replace('export const config = {', 'export const config = {\n  defaultUf: process.env.DEFAULT_UF || \"CE\",');
fs.writeFileSync(file, content);
console.log('config.ts updated');
