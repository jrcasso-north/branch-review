#!/usr/bin/env node
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const repo = process.argv[2] ? path.resolve(process.argv[2]) : undefined

const child = spawn(
  process.execPath,
  [path.join(root, 'node_modules/tsx/dist/cli.mjs'), path.join(root, 'mcp/index.ts')],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      BRANCH_REVIEW_REPO: repo ?? process.env.BRANCH_REVIEW_REPO ?? process.cwd(),
      NODE_ENV: process.env.NODE_ENV ?? 'production',
    },
  },
)

child.on('exit', (code) => process.exit(code ?? 0))
