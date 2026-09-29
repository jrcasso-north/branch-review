import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { writeConfig } from '../server/review-store.js'
import { createFixtureRepo, git, startMcpSession, textOf } from './helpers.js'

test('review all changes, send feedback, and preserve it when the branch advances', async ({
  page,
}, testInfo) => {
  const fixture = await createFixtureRepo()
  const repo = fixture.repoPath
  const port = 18787
  const baseUrl = `http://localhost:${port}`
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await writeFile(path.join(repo, 'version.js'), 'export const VERSION = "2"\n')
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '--quiet', '-m', 'Bump version'])
  await writeConfig(repo, { baseBranch: 'main', reviewBranch: 'feat/sum' })
  const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts', repo], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'production' },
    stdio: 'pipe',
  })
  try {
    await expect
      .poll(async () => {
        try {
          return (await fetch(`${baseUrl}/api/repos`)).status
        } catch {
          return 0
        }
      })
      .toBe(200)
    await page.goto(baseUrl)
    await expect(page.getByRole('heading', { name: 'All changes', exact: true })).toBeVisible()
    await expect(
      page.locator('.line-body').filter({ hasText: 'sum = sum + item.value' }),
    ).toBeVisible()
    await expect(page.locator('.line-body').filter({ hasText: 'VERSION = "2"' })).toBeVisible()
    expect(new URL(page.url()).pathname).not.toMatch(/\/[a-f0-9]{40}$/)

    await page.locator('.line-body').filter({ hasText: 'sum = sum + item.value' }).click()
    await page.locator('textarea').fill('Use reduce for the branch calculation.')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(
      page.getByText('Use reduce for the branch calculation.', { exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Send to agent', exact: true }).click()

    const reviewResponse = await page.request.get(`${baseUrl}/api/comments`, {
      headers: { 'X-Repo-Path': repo },
    })
    expect(reviewResponse.ok()).toBe(true)
    const review = await reviewResponse.json()
    const comment = review.comments[0]
    expect(comment.diffBaseSha).toMatch(/^[a-f0-9]{40}$/)
    expect(comment.dispatched).toBe(true)
    const session = await startMcpSession(repo)
    try {
      const result = textOf(
        await session.client.callTool({
          name: 'get_comment',
          arguments: { commentId: comment.id },
        }),
      )
      expect(result).toContain('branch diff base:')
      expect(result).toContain('sum = sum + item.value')
    } finally {
      await session.close()
    }

    await page.getByRole('button', { name: 'Comment on this branch', exact: true }).click()
    await page.locator('textarea').fill('Check the complete branch.')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Check the complete branch.', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: /Bump version/ }).click()
    await expect(
      page.getByRole('button', { name: 'Comment on this commit', exact: true }),
    ).toBeVisible()
    await expect(page.getByText('Check the complete branch.', { exact: true })).toHaveCount(0)
    await expect(
      page.locator('.line-body').filter({ hasText: 'sum = sum + item.value' }),
    ).toHaveCount(0)
    await page.getByRole('button', { name: 'All changes', exact: true }).click()
    await expect(page.getByText('Check the complete branch.', { exact: true })).toBeVisible()

    await writeFile(path.join(repo, 'calc.js'), 'export const total = () => 0\n')
    await git(repo, ['add', '-A'])
    await git(repo, ['commit', '--quiet', '-m', 'Replace calculation'])
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(page.locator('.line-body').filter({ hasText: 'total = () => 0' })).toBeVisible()
    await expect(
      page
        .locator('.diff-files')
        .getByText('Use reduce for the branch calculation.', { exact: true }),
    ).toHaveCount(0)
    await page.getByText('Comments on earlier versions (2)', { exact: true }).click()
    await expect(
      page.getByText('Use reduce for the branch calculation.', { exact: true }),
    ).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('all-changes.png') })

    const repoName = path.basename(repo)
    await page.goto(`${baseUrl}/${repoName}/feat%2Fsum...main/${fixture.reviewSha}`)
    await expect(
      page.getByRole('button', { name: 'Comment on this commit', exact: true }),
    ).toBeVisible()
    await expect(page.locator('.line-body').filter({ hasText: 'VERSION = "1"' })).toBeVisible()
    expect(errors).toEqual([])
  } finally {
    const stopped = once(server, 'exit')
    server.kill('SIGTERM')
    await stopped
    await fixture.cleanup()
  }
})
