// The claude.ai artifact host wraps the page in its own <!doctype>/<html>/<head>/<body>, so emit only the inner content.
import { readFileSync, writeFileSync } from 'node:fs';
const f = process.argv[2];
let s = readFileSync(f, 'utf8');
s = s.replace(/<!doctype html>/i, '').replace(/<\/?html[^>]*>/gi, '').replace(/<\/?head>/gi, '').replace(/<\/?body>/gi, '');
s = s.replace(/<meta charset="UTF-8" \/>\s*/i, '').replace(/<meta name="viewport"[^>]*>\s*/i, '');
const title = s.match(/<title>[\s\S]*?<\/title>/i)[0];
s = title + '\n' + s.replace(title, '');
writeFileSync(f, s.trim() + '\n');
console.log('stripped skeleton:', f);
