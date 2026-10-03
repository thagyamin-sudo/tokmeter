import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync('llm-monitor.html', 'utf8');
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) { console.log('no script'); process.exit(1); }
writeFileSync(process.env.TEMP + '/bundle-check.js', m[1]);
console.log('script bytes', m[1].length);
