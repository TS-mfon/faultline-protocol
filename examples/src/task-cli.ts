import { executeTask } from './tasks';
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 65_536) throw new Error('Task input exceeds the evidence limit');
}
console.log(JSON.stringify(executeTask(JSON.parse(input))));
