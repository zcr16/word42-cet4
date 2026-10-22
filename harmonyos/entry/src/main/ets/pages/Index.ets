import { webview } from '@kit.ArkWeb';

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();

  onBackPress(): boolean {
    try {
      if (this.controller.accessBackward()) {
        this.controller.backward();
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  build() {
    Column() {
      Web({ src: $rawfile('index.html'), controller: this.controller })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .fileAccess(false)
        .onlineImageAccess(false)
        .width('100%')
        .height('100%')
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#f6f7f2')
  }
}
