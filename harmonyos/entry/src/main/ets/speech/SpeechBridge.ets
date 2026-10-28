import { webview } from '@kit.ArkWeb';
import { BusinessError } from '@kit.BasicServicesKit';
import { EnglishSpeechService, SpeechEventHandler, speechDiagnostic, speechErrorCode } from './EnglishSpeechService';

interface SpeechPageProbe {
  proxy: string;
  speak: string;
  stop: string;
  native: boolean;
  callback: boolean;
  readyState: string;
}

export class SpeechBridge {
  private controller: webview.WebviewController;
  private attached: boolean = false;
  private ready: boolean = false;
  private readonly eventHandler: SpeechEventHandler = (requestId: string, status: string, message: string): void => {
    const trusted = this.isTrustedPage();
    speechDiagnostic('bridge.event', { attached: this.attached, ready: this.ready, trusted: trusted, status: status });
    if (!this.attached || !trusted) { return; }
    const args = JSON.stringify([requestId, status, message])
      .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    const script = `if(typeof window.__word42SpeechEvent==='function'){window.__word42SpeechEvent.apply(window,${args});}`;
    try {
      this.controller.runJavaScript(script).then(() => {
        speechDiagnostic('bridge.event.dispatched', { status: status });
      }).catch((error: BusinessError) => {
        speechDiagnostic('bridge.event.rejected', { code: speechErrorCode(error) });
      });
    } catch (error) {
      speechDiagnostic('bridge.event.exception', { code: speechErrorCode(error as BusinessError) });
    }
  };

  constructor(controller: webview.WebviewController) {
    this.controller = controller;
  }

  static isLocalUrl(url: string): boolean {
    return /^resource:\/\/rawfile\/index\.html(?:[?#].*)?$/.test(url);
  }

  static diagnosticUrl(url: string): string {
    // Restrict diagnostic output as well as bridge access. Hash/query may contain user state.
    return /^resource:\/\/rawfile(?:\/|$)/i.test(url) ? url.split(/[?#]/)[0].slice(0, 180) : '[non-rawfile]';
  }

  attach(): void {
    speechDiagnostic('bridge.attach');
    this.attached = true;
    EnglishSpeechService.shared.attach(this.eventHandler);
  }

  detach(): void {
    speechDiagnostic('bridge.detach');
    EnglishSpeechService.shared.detach(this.eventHandler);
    this.attached = false;
    this.ready = false;
  }

  setVisible(visible: boolean): void {
    EnglishSpeechService.shared.setPageVisible(this.eventHandler, visible);
  }

  pageLoading(url: string = ''): void {
    speechDiagnostic('bridge.page_begin', { url: SpeechBridge.diagnosticUrl(url), local: SpeechBridge.isLocalUrl(url) });
    EnglishSpeechService.shared.setDocumentReady(this.eventHandler, false);
    this.ready = false;
  }

  pageReady(url: string): void {
    this.ready = SpeechBridge.isLocalUrl(url) && this.isTrustedPage();
    speechDiagnostic('bridge.page_end', { url: SpeechBridge.diagnosticUrl(url), ready: this.ready });
    EnglishSpeechService.shared.setDocumentReady(this.eventHandler, this.ready);
    this.probePage();
    if (this.ready) { EnglishSpeechService.shared.probeEnglishVoices(); }
  }

  speak(requestId: string, text: string, rate: number): void {
    const trusted = this.isTrustedPage();
    speechDiagnostic('bridge.speak', { attached: this.attached, ready: this.ready, trusted: trusted });
    if (!this.attached || !trusted) {
      speechDiagnostic('bridge.speak.rejected', { reason: 'untrusted_or_detached' });
      return;
    }
    if (!this.ready) {
      if (typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(requestId)) {
        this.eventHandler(requestId, 'error', '手机朗读页面尚未准备好，请退出后重新进入。');
      }
      return;
    }
    EnglishSpeechService.shared.speak(this.eventHandler, requestId, text, rate);
  }

  stop(): void {
    speechDiagnostic('bridge.stop', { attached: this.attached });
    if (this.attached && this.isTrustedPage()) { EnglishSpeechService.shared.stop(this.eventHandler); }
  }

  forwardConsole(message: string): boolean {
    const match = message.match(/^\[Word42Speech\] (?:mode=(native|browser)|signal=(start|end|error|preparing)|error=(speech_error|completion_timeout|native_error|browser_error|browser_unavailable|voice_list_failed|browser_speak_failed|english_voice_missing|start_timeout|native_bridge_failed|preparation_timeout))$/);
    if (match === null || !this.attached || !this.isTrustedPage()) { return false; }
    if (match[1]) { speechDiagnostic('web.adapter', { mode: match[1] }); }
    else if (match[2]) { speechDiagnostic('web.adapter', { status: match[2] }); }
    else { speechDiagnostic('web.adapter', { error: match[3] }); }
    return true;
  }

  private isTrustedPage(): boolean {
    try {
      const url = this.controller.getUrl();
      const trusted = SpeechBridge.isLocalUrl(url);
      speechDiagnostic('bridge.current_page', { url: SpeechBridge.diagnosticUrl(url), trusted: trusted });
      return trusted;
    } catch (error) {
      speechDiagnostic('bridge.current_page.exception', { code: speechErrorCode(error as BusinessError) });
      return false;
    }
  }

  private probePage(): void {
    if (!this.attached || !this.isTrustedPage()) { return; }
    const script = "JSON.stringify({proxy:typeof window.Word42Speech,speak:typeof(window.Word42Speech&&window.Word42Speech.speak),stop:typeof(window.Word42Speech&&window.Word42Speech.stop),native:window.WORD42_NATIVE===true,callback:typeof window.__word42SpeechEvent==='function',readyState:document.readyState})";
    try {
      this.controller.runJavaScript(script).then((result: string) => {
        let decoded = JSON.parse(result) as SpeechPageProbe | string;
        if (typeof decoded === 'string') { decoded = JSON.parse(decoded) as SpeechPageProbe; }
        const probe = decoded as SpeechPageProbe;
        speechDiagnostic('bridge.probe', { proxyObject: probe.proxy === 'object', speakFunction: probe.speak === 'function',
          stopFunction: probe.stop === 'function', native: probe.native === true, callback: probe.callback === true,
          documentComplete: probe.readyState === 'complete', documentInteractive: probe.readyState === 'interactive' });
      }).catch((error: BusinessError) => {
        speechDiagnostic('bridge.probe.rejected', { code: speechErrorCode(error) });
      });
    } catch (error) {
      speechDiagnostic('bridge.probe.exception', { code: speechErrorCode(error as BusinessError) });
    }
  }
}
