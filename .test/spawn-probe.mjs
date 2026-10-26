import { spawn } from 'node:child_process'

const exe = process.argv[2]
try {
  const child = spawn(exe, ['--list-devices'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  console.log('spawn returned, pid=' + child.pid)
  child.on('error', (error) => console.log('error event: code=' + error.code + ' errno=' + error.errno + ' pid=' + child.pid + ' msg=' + error.message))
  child.stdout.on('data', (chunk) => console.log('stdout: ' + chunk.length + 'B'))
  child.on('close', (code) => console.log('close code=' + code))
} catch (error) {
  console.log('spawn threw: code=' + error.code + ' errno=' + error.errno + ' msg=' + error.message)
}
setTimeout(() => console.log('done waiting'), 3000)
