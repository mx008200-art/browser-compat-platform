const { defineConfig } = require('@playwright/test')

module.exports = defineConfig({
  testDir: './tests',
  outputDir: 'test-results',
  timeout: 45_000,
  expect: {
    timeout: 15_000,
  },
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    browserName: 'webkit',
    headless: true,
    video: 'on',
    screenshot: 'on',
    trace: 'on',
  },
})
