import fs from 'node:fs';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

const version = process.argv[2];
const executable = await downloadAndUnzipVSCode(version);
fs.writeFileSync(process.argv[3], JSON.stringify({ executable }));