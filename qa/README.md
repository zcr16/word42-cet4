# 写作点读专项回归

主项目的 `npm test` 无第三方依赖，覆盖内容、学习计划与语音状态机。

本目录的可选专项检查需要 TypeScript 和 Playwright：

```sh
npm install --no-save --package-lock=false typescript playwright
npx playwright install chromium
node --test qa/native-speech.test.cjs
node qa/audio-ui.cjs
```

也可用 `WORD42_TYPESCRIPT_PATH`、`WORD42_PLAYWRIGHT_PATH` 指向已有工具模块，用 `WORD42_BROWSER_PATH` 指向本机浏览器可执行文件。

原生检查转译实际语音服务和桥接代码，仅模拟系统 SDK、时钟与 WebView；不能替代 DevEco 的 ArkTS 编译和真机试听。UI 检查仅使用隔离浏览器与模拟声音，拦截所有外网请求，不连接手机、不读取实际学习记录。截图和 UI 检查报告写入本目录。

v1.1.2 验证：主测试 37 项、原生专项 39 项、UI 9 组通过。真机下载及声音、用户原进度保留的证据与边界见根目录的《验证记录.md》。
