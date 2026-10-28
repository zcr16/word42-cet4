import { webview } from '@kit.ArkWeb';
import { SpeechBridge } from '../speech/SpeechBridge';
import { BusinessError } from '@kit.BasicServicesKit';
import { speechDiagnostic, speechErrorCode } from '../speech/EnglishSpeechService';

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private speech: SpeechBridge = new SpeechBridge(this.controller);

  aboutToAppear(): void {
    speechDiagnostic('page.appear');
    this.speech.attach();
  }

  onPageShow(): void {
    speechDiagnostic('page.show');
    this.speech.setVisible(true);
  }

  onPageHide(): void {
    speechDiagnostic('page.hide');
    this.speech.setVisible(false);
  }

  aboutToDisappear(): void {
    speechDiagnostic('page.disappear');
    this.speech.detach();
    try { this.controller.deleteJavaScriptRegister('Word42Speech'); } catch (error) {
      speechDiagnostic('bridge.unregister.exception', { code: speechErrorCode(error as BusinessError) });
    }
  }

  onBackPress(): boolean {
    this.speech.stop();
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
        .geolocationAccess(false)
        .mixedMode(MixedMode.None)
        .onControllerAttached(() => {
          speechDiagnostic('bridge.register.begin');
          try {
            this.controller.registerJavaScriptProxy(this.speech, 'Word42Speech', ['speak', 'stop'], [],
              '{"javascriptProxyPermission":{"urlPermissionList":[{"scheme":"resource","host":"rawfile","port":"","path":""}]}}');
            speechDiagnostic('bridge.register.done', { resourceRawfileOnly: true });
          } catch (error) {
            speechDiagnostic('bridge.register.exception', { code: speechErrorCode(error as BusinessError) });
          }
        })
        .onLoadIntercept((event) => {
          const url = event.data.getRequestUrl();
          const allowed = SpeechBridge.isLocalUrl(url);
          speechDiagnostic('bridge.navigation', { url: SpeechBridge.diagnosticUrl(url), allowed: allowed });
          return !allowed;
        })
        .onPageBegin((event) => this.speech.pageLoading(event.url))
        .onPageEnd((event) => this.speech.pageReady(event.url))
        .onConsole((event) => this.speech.forwardConsole(event.message.getMessage()))
        .width('100%')
        .height('100%')
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#f6f7f2')
  }
}
