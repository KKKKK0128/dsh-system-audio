import { spawn } from 'node:child_process'
import { open, readFile } from 'node:fs/promises'

const exe = process.argv[2]
const out = process.argv[3]

const handle = await open(out, 'w')
const child = spawn(exe, ['--list-devices'], { stdio: ['ignore', handle.fd, handle.fd] })
const code = await new Promise((resolve) => {
  child.on('error', (error) => resolve('error:' + error.code))
  child.on('close', (value) => resolve(value))
})
await handle.close()
console.log('exit=' + code)
console.log('bytes=' + (await readFile(out, 'utf8')).trim())
