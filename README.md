# macOS WebKit 登录兼容性巡检

这个项目通过 GitHub Actions 的 macOS runner 运行 Playwright WebKit，采集登录过程中的录像、截图、页面异常、控制台错误、请求失败和关键接口状态。

注意：Playwright WebKit 不是 macOS Safari 应用，也不等于精确 Safari 15.6。它适合做 macOS/WebKit 兼容性预检；最终确认仍需要真实 Safari 15.6 环境。

## GitHub Secrets

在仓库 `Settings -> Secrets and variables -> Actions` 中配置：

- `BRM_TEST_PHONE`
- `BRM_TEST_PASSWORD`
- `BRM_PROD_PHONE`
- `BRM_PROD_PASSWORD`

不要把账号密码写入代码、Issue、日志或截图。建议使用权限受限的专用测试账号。

## 运行

进入 `Actions -> macOS WebKit 登录兼容性巡检 -> Run workflow`，默认选择 `test`。

只有测试环境通过后，再选择 `prod`。运行结束后，在 workflow 的 Artifacts 下载 `test-results`，其中包含录像、截图和诊断 JSON。
