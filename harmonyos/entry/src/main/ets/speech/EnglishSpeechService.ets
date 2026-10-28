import { textToSpeech } from '@kit.CoreSpeechKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError } from '@kit.BasicServicesKit';

export type SpeechEventHandler = (requestId: string, status: string, message: string) => void;

export interface SpeechDiagnosticState {
  englishAvailable?: boolean;
  englishInstalled?: boolean;
  language?: string;
  style?: string;
  person?: number;
  status?: string;
  code?: number;
  replacing?: boolean;
  owner?: boolean;
  visible?: boolean;
  ready?: boolean;
  foreground?: boolean;
  engineReady?: boolean;
  reason?: string;
  phase?: string;
  current?: boolean;
  offline?: boolean;
  started?: boolean;
  type?: number;
  english?: boolean;
  stage?: string;
  hasHandler?: boolean;
  release?: boolean;
  active?: boolean;
  attached?: boolean;
  trusted?: boolean;
  url?: string;
  local?: boolean;
  mode?: string;
  error?: string;
  proxyObject?: boolean;
  speakFunction?: boolean;
  stopFunction?: boolean;
  native?: boolean;
  callback?: boolean;
  documentComplete?: boolean;
  documentInteractive?: boolean;
  resourceRawfileOnly?: boolean;
  allowed?: boolean;
}

// Only pass fixed state labels, booleans, SDK codes or voice metadata here.
// Never log request IDs, learning text, notes, SDK messages or remote URLs.
export function speechDiagnostic(event: string, state: SpeechDiagnosticState = {}): void {
  hilog.info(0x0000, 'Word42Speech', 'event=%{public}s state=%{public}s', event, JSON.stringify(state));
}

export function speechErrorCode(error: BusinessError): number {
  return error && typeof error.code === 'number' && Number.isFinite(error.code) ? error.code : 0;
}

class SpeechPreparationError extends Error implements BusinessError {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

class VoiceDownloadTask {
  promise: Promise<void>;
  resolve: () => void = (): void => {};
  reject: (error: SpeechPreparationError) => void = (_error: SpeechPreparationError): void => {};
  response: textToSpeech.DownloadResponse | undefined = undefined;
  timer: number = -1;
  finished: boolean = false;
  onComplete: (voice: textToSpeech.VoiceInfo) => void = (_voice: textToSpeech.VoiceInfo): void => {};
  onCancel: (message: string) => void = (_message: string): void => {};
  onError: (error: BusinessError) => void = (_error: BusinessError): void => {};

  constructor() {
    this.promise = new Promise<void>((resolve, reject) => {
      this.resolve = (): void => resolve();
      this.reject = (error: SpeechPreparationError): void => reject(error);
    });
  }
}

// One foreground speaker for both writing sentences and vocabulary cards.
export class EnglishSpeechService {
  static readonly shared: EnglishSpeechService = new EnglishSpeechService();
  private engine: textToSpeech.TextToSpeechEngine | undefined = undefined;
  private handler: SpeechEventHandler | undefined = undefined;
  private foreground: boolean = true;
  private pageVisible: boolean = false;
  private documentReady: boolean = false;
  private generation: number = 0;
  private sequence: number = 0;
  private clientId: string = '';
  private nativeId: string = '';
  private started: boolean = false;
  private timer: number = -1;
  private voiceProbeStarted: boolean = false;
  private downloadTask: VoiceDownloadTask | undefined = undefined;

  // Read-only startup diagnosis: never creates an engine, downloads or speaks.
  probeEnglishVoices(): void {
    if (this.voiceProbeStarted) { return; }
    this.voiceProbeStarted = true;
    let finished: boolean = false;
    speechDiagnostic('probe.list_voices.begin');
    const timeout = setTimeout(() => {
      if (!finished) { speechDiagnostic('probe.list_voices.timeout'); }
    }, 8000);
    try {
      textToSpeech.listVoices({ requestId: `Word42Probe${Date.now()}`, online: 1,
        extraParams: { language: 'en-US' } }).then((voices: textToSpeech.VoiceInfo[]) => {
        finished = true;
        clearTimeout(timeout);
        const english = voices.filter((item: textToSpeech.VoiceInfo) =>
          item.language === 'en-US' || item.language === 'en_US');
        speechDiagnostic('probe.list_voices.done', { englishAvailable: english.length > 0,
          englishInstalled: english.some((item: textToSpeech.VoiceInfo) => item.status === 'INSTALLED') });
        english.slice(0, 20).forEach((item: textToSpeech.VoiceInfo) => {
          speechDiagnostic('probe.voice', { language: item.language, person: item.person,
            style: typeof item.style === 'string' ? item.style : 'UNSPECIFIED',
            status: item.status === undefined ? 'UNSPECIFIED' : item.status });
        });
      }).catch((error: BusinessError) => {
        finished = true;
        clearTimeout(timeout);
        speechDiagnostic('probe.list_voices.error', { code: speechErrorCode(error) });
      });
    } catch (error) {
      finished = true;
      clearTimeout(timeout);
      speechDiagnostic('probe.list_voices.exception', { code: speechErrorCode(error as BusinessError) });
    }
  }

  attach(handler: SpeechEventHandler): void {
    speechDiagnostic('service.attach', { replacing: this.handler !== handler });
    if (this.handler !== handler) {
      this.cancel(true);
      this.documentReady = false;
    }
    this.handler = handler;
    this.pageVisible = true;
  }

  detach(handler: SpeechEventHandler): void {
    speechDiagnostic('service.detach', { owner: this.handler === handler });
    if (this.handler !== handler) { return; }
    this.cancel(true);
    this.handler = undefined;
    this.pageVisible = false;
    this.documentReady = false;
  }

  setPageVisible(handler: SpeechEventHandler, visible: boolean): void {
    speechDiagnostic('service.page_visible', { owner: this.handler === handler, visible: visible });
    if (this.handler !== handler) { return; }
    this.pageVisible = visible;
    if (!visible) { this.cancel(true); }
  }

  setDocumentReady(handler: SpeechEventHandler, ready: boolean): void {
    speechDiagnostic('service.document_ready', { owner: this.handler === handler, ready: ready });
    if (this.handler !== handler) { return; }
    if (!ready) { this.cancel(true); }
    this.documentReady = ready;
  }

  setForeground(foreground: boolean): void {
    speechDiagnostic('service.foreground', { foreground: foreground });
    this.foreground = foreground;
    if (!foreground) { this.cancel(true); }
  }

  shutdown(): void {
    speechDiagnostic('service.shutdown');
    this.foreground = false;
    this.cancel(true);
    if (this.downloadTask !== undefined) {
      this.finishDownload(this.downloadTask, new SpeechPreparationError(0, '英语语音准备已停止。'));
    }
    this.handler = undefined;
    this.documentReady = false;
    this.pageVisible = false;
  }

  stop(handler: SpeechEventHandler): void {
    speechDiagnostic('service.stop', { owner: this.handler === handler });
    if (this.handler === handler) { this.cancel(true); }
  }

  speak(handler: SpeechEventHandler, requestId: string, text: string, rate: number): void {
    speechDiagnostic('service.speak', { owner: this.handler === handler, ready: this.documentReady,
      foreground: this.foreground, visible: this.pageVisible, engineReady: this.engine !== undefined });
    if (this.handler !== handler) { return; }
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(requestId)) {
      speechDiagnostic('service.rejected', { reason: 'request_id' });
      return;
    }
    if (!this.documentReady) {
      speechDiagnostic('service.rejected', { reason: 'document_not_ready' });
      this.emit(requestId, 'error', '手机朗读页面尚未准备好，请退出后重新进入。');
      return;
    }
    this.cancel(false);
    if (!this.foreground || !this.pageVisible) {
      this.emit(requestId, 'end', 'stopped');
      return;
    }
    if (typeof text !== 'string' || text.trim().length === 0 || text.length > 2000) {
      speechDiagnostic('service.rejected', { reason: 'text' });
      this.emit(requestId, 'error', '朗读内容须为 1–2000 个字符。');
      return;
    }
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0.6 || rate > 1.2) {
      speechDiagnostic('service.rejected', { reason: 'rate' });
      this.emit(requestId, 'error', '朗读速度须在 0.6–1.2 倍之间。');
      return;
    }
    this.clientId = requestId;
    this.nativeId = `Word42${Date.now()}N${++this.sequence}`;
    const generation = this.generation;
    this.armStartTimer(generation);
    this.prepareAndSpeak(generation, text.trim(), rate);
  }

  private armStartTimer(generation: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      if (this.isCurrent(generation)) {
        speechDiagnostic('service.timeout', { phase: 'start' });
        this.fail('英语语音启动超时，请稍后重试或检查系统英语语音包。');
      }
    }, 8000);
  }

  private async prepareAndSpeak(generation: number, text: string, rate: number): Promise<void> {
    let stage: string = 'voice_query';
    try {
      if (this.engine === undefined) {
        speechDiagnostic('sdk.list_voices.begin');
        const voices = await textToSpeech.listVoices({
          requestId: `Word42Voices${Date.now()}N${++this.sequence}`,
          online: 1,
          extraParams: { language: 'en-US' }
        });
        speechDiagnostic('sdk.list_voices.done', { current: this.isCurrent(generation) });
        if (!this.isCurrent(generation)) { return; }
        voices.slice(0, 20).forEach((item: textToSpeech.VoiceInfo) => {
          speechDiagnostic('sdk.voice', { language: item.language, person: item.person,
            status: item.status === undefined ? 'UNSPECIFIED' : item.status });
        });
        let voice = voices.find((item: textToSpeech.VoiceInfo) =>
          (item.language === 'en-US' || item.language === 'en_US') && item.status === 'INSTALLED');
        if (voice === undefined) {
          const downloadable = voices.find((item: textToSpeech.VoiceInfo) =>
            (item.language === 'en-US' || item.language === 'en_US') && item.status === 'GA');
          if (downloadable !== undefined) {
            stage = 'voice_download';
            this.clearTimer();
            this.emit(this.clientId, 'preparing', '首次使用正在准备英语语音，完成后开始朗读。');
            if (!this.isCurrent(generation)) { return; }
            await this.ensureVoiceDownloaded(downloadable);
            if (!this.isCurrent(generation)) { return; }
            this.armStartTimer(generation);
            stage = 'voice_recheck';
            const installed = await textToSpeech.listVoices({
              requestId: `Word42Verify${Date.now()}N${++this.sequence}`, online: 1,
              extraParams: { language: 'en-US' }
            });
            if (!this.isCurrent(generation)) { return; }
            voice = installed.find((item: textToSpeech.VoiceInfo) =>
              (item.language === 'en-US' || item.language === 'en_US') && item.status === 'INSTALLED');
            if (voice === undefined) {
              throw new SpeechPreparationError(0, '英语语音尚未准备完成，请稍后再点句子重试。');
            }
          }
        }
        if (voice === undefined) {
          speechDiagnostic('sdk.voice_unavailable');
          this.fail('系统没有可用的英语语音资源，请检查系统语音服务后重试。');
          return;
        }
        stage = 'engine_create';
        speechDiagnostic('sdk.create_engine.begin', { language: 'en-US', person: voice.person, offline: true });
        const created = await textToSpeech.createEngine({
          language: 'en-US', person: voice.person, online: 1,
          extraParams: { name: 'Word42English', isBackStage: false }
        });
        // Initialization cannot be cancelled by the SDK. Dispose late engines immediately.
        if (!this.isCurrent(generation)) {
          speechDiagnostic('sdk.create_engine.late');
          this.release(created);
          return;
        }
        this.engine = created;
        speechDiagnostic('sdk.create_engine.done');
      }
      const engine = this.engine;
      if (engine === undefined || !this.isCurrent(generation)) { return; }
      const requestId = this.nativeId;
      stage = 'listener_register';
      engine.setListener({
        onStart: (id: string, _response: textToSpeech.StartResponse): void => {
          speechDiagnostic('sdk.on_start', { current: this.matches(generation, id), started: this.started });
          if (!this.matches(generation, id) || this.started) { return; }
          this.started = true;
          this.clearTimer();
          this.emit(this.clientId, 'start', '');
          // Guard a missing terminal callback without pretending the sentence finished.
          const limit = Math.min(360000, Math.max(15000, text.length * 140 / rate + 15000));
          this.timer = setTimeout(() => {
            if (this.matches(generation, id)) {
              speechDiagnostic('service.timeout', { phase: 'playback' });
              this.fail('英语朗读未能正常结束，请重试。');
            }
          }, limit);
        },
        onComplete: (id: string, response: textToSpeech.CompleteResponse): void => {
          speechDiagnostic('sdk.on_complete', { current: this.matches(generation, id), type: response.type });
          // type 0 only means synthesis completed, not that the user heard the sentence.
          if (this.matches(generation, id) && response.type === 1) { this.finish(''); }
        },
        onStop: (id: string, _response: textToSpeech.StopResponse): void => {
          speechDiagnostic('sdk.on_stop', { current: this.matches(generation, id) });
          if (this.matches(generation, id)) { this.finish('stopped'); }
        },
        onError: (id: string, code: number, _message: string): void => {
          speechDiagnostic('sdk.on_error', { current: this.matches(generation, id), code: code });
          if (this.matches(generation, id)) {
            this.fail(`系统英语朗读失败（${code}），请检查英语语音包后重试。`);
          }
        }
      });
      stage = 'speak';
      speechDiagnostic('sdk.speak.begin', { offline: true, english: true });
      engine.speak(text, {
        requestId: requestId,
        extraParams: {
          queueMode: 0, speed: rate, volume: 1, pitch: 1,
          languageContext: 'en-US', audioType: 'pcm', soundChannel: 3, playType: 1
        }
      });
      speechDiagnostic('sdk.speak.submitted');
    } catch (error) {
      const code = speechErrorCode(error as BusinessError);
      speechDiagnostic('sdk.exception', { stage: stage, code: code, current: this.isCurrent(generation) });
      if (this.isCurrent(generation)) {
        const detail = code === 0 ? '' : `（错误码 ${code}）`;
        this.fail(error instanceof SpeechPreparationError ? error.message :
          `暂时无法使用系统英语朗读${detail}，请检查英语语音包后重试。`);
      }
    }
  }

  private ensureVoiceDownloaded(voice: textToSpeech.VoiceInfo): Promise<void> {
    const existing = this.downloadTask;
    if (existing !== undefined && !existing.finished) {
      speechDiagnostic('sdk.download.reuse');
      return existing.promise;
    }
    // These three fields are supplied by the system; never guess a style or voice.
    if ((voice.language !== 'en-US' && voice.language !== 'en_US') ||
      typeof voice.person !== 'number' || !Number.isInteger(voice.person) || voice.person < 0 ||
      typeof voice.style !== 'string' || voice.style.trim().length === 0) {
      speechDiagnostic('sdk.download.invalid_voice', { code: 401 });
      return Promise.reject(new SpeechPreparationError(401, '系统英语语音资源信息不完整（错误码 401），请更新系统语音服务后重试。'));
    }
    const task = new VoiceDownloadTask();
    this.downloadTask = task;
    task.onComplete = (_voice: textToSpeech.VoiceInfo): void => {
      speechDiagnostic('sdk.download.complete');
      this.finishDownload(task);
    };
    task.onCancel = (_message: string): void => {
      speechDiagnostic('sdk.download.cancel');
      this.finishDownload(task, new SpeechPreparationError(0, '已取消英语语音准备，再点句子可重试。'));
    };
    task.onError = (error: BusinessError): void => {
      this.downloadFailed(task, speechErrorCode(error));
    };
    task.timer = setTimeout(() => {
      speechDiagnostic('sdk.download.timeout');
      this.finishDownload(task, new SpeechPreparationError(0, '英语语音准备超时，请检查网络后再点句子重试。'));
    }, 180000);
    speechDiagnostic('sdk.download.begin', { language: voice.language, person: voice.person, style: voice.style });
    try {
      textToSpeech.downloadVoice({ requestId: `Word42Download${Date.now()}N${++this.sequence}`,
        language: voice.language, person: voice.person, style: voice.style },
        (error: BusinessError, response: textToSpeech.DownloadResponse): void => {
          if (task.finished) { return; }
          if (error) { this.downloadFailed(task, speechErrorCode(error)); return; }
          task.response = response;
          try {
            response.on('error', task.onError);
            if (!task.finished) { response.on('cancel', task.onCancel); }
            if (!task.finished) { response.on('complete', task.onComplete); }
            speechDiagnostic('sdk.download.listening');
          } catch (failure) {
            this.downloadFailed(task, speechErrorCode(failure as BusinessError));
          }
        });
    } catch (error) {
      this.downloadFailed(task, speechErrorCode(error as BusinessError));
    }
    return task.promise;
  }

  private downloadFailed(task: VoiceDownloadTask, code: number): void {
    speechDiagnostic('sdk.download.error', { code: code });
    if (code === 1002300010) {
      // The system says it is already downloaded; the caller still rechecks INSTALLED.
      this.finishDownload(task);
      return;
    }
    const detail = code === 0 ? '' : `（错误码 ${code}）`;
    this.finishDownload(task, new SpeechPreparationError(code, `英语语音准备失败${detail}，请检查网络后重试。`));
  }

  private finishDownload(task: VoiceDownloadTask, error: SpeechPreparationError | undefined = undefined): void {
    if (task.finished) { return; }
    task.finished = true;
    if (task.timer !== -1) { clearTimeout(task.timer); task.timer = -1; }
    const response = task.response;
    task.response = undefined;
    if (response !== undefined) {
      try { response.off('error', task.onError); } catch { /* Resource may be released by the system. */ }
      try { response.off('cancel', task.onCancel); } catch { /* Resource may be released by the system. */ }
      try { response.off('complete', task.onComplete); } catch { /* Resource may be released by the system. */ }
    }
    if (this.downloadTask === task) { this.downloadTask = undefined; }
    if (error === undefined) { task.resolve(); } else { task.reject(error); }
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation && this.clientId.length > 0 && this.foreground &&
      this.pageVisible && this.documentReady && this.handler !== undefined;
  }

  private matches(generation: number, requestId: string): boolean {
    return this.isCurrent(generation) && requestId === this.nativeId;
  }

  private emit(requestId: string, status: string, message: string): void {
    speechDiagnostic('service.event', { status: status, hasHandler: this.handler !== undefined });
    const callback = this.handler;
    if (callback !== undefined) { callback(requestId, status, message); }
  }

  private clearTimer(): void {
    if (this.timer !== -1) { clearTimeout(this.timer); this.timer = -1; }
  }

  private finish(message: string): void {
    const requestId = this.clientId;
    this.clearTimer();
    this.clientId = '';
    this.nativeId = '';
    this.started = false;
    this.generation++;
    if (requestId.length > 0) { this.emit(requestId, 'end', message); }
  }

  private fail(message: string): void {
    const requestId = this.clientId;
    this.cancel(true, false);
    if (requestId.length > 0) { this.emit(requestId, 'error', message); }
  }

  private cancel(releaseEngine: boolean, notify: boolean = true): void {
    speechDiagnostic('service.cancel', { release: releaseEngine, active: this.clientId.length > 0,
      engineReady: this.engine !== undefined });
    const requestId = this.clientId;
    this.clearTimer();
    this.clientId = '';
    this.nativeId = '';
    this.started = false;
    this.generation++;
    const engine = this.engine;
    if (releaseEngine) { this.engine = undefined; }
    if (engine !== undefined) {
      try { engine.stop(); } catch (error) {
        speechDiagnostic('sdk.stop.exception', { code: speechErrorCode(error as BusinessError) });
      }
      if (releaseEngine) { this.release(engine); }
    }
    if (notify && requestId.length > 0) { this.emit(requestId, 'end', 'stopped'); }
  }

  private release(engine: textToSpeech.TextToSpeechEngine): void {
    try {
      engine.shutdown();
      speechDiagnostic('sdk.shutdown.done');
    } catch (error) {
      speechDiagnostic('sdk.shutdown.exception', { code: speechErrorCode(error as BusinessError) });
    }
  }
}
