import { UIAbility } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { EnglishSpeechService, speechDiagnostic } from '../speech/EnglishSpeechService';

export default class EntryAbility extends UIAbility {
  onForeground(): void {
    speechDiagnostic('ability.foreground');
    EnglishSpeechService.shared.setForeground(true);
  }

  onBackground(): void {
    speechDiagnostic('ability.background');
    EnglishSpeechService.shared.setForeground(false);
  }

  onWindowStageDestroy(): void {
    speechDiagnostic('ability.window_destroy');
    EnglishSpeechService.shared.shutdown();
  }

  onDestroy(): void {
    speechDiagnostic('ability.destroy');
    EnglishSpeechService.shared.shutdown();
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    speechDiagnostic('ability.window_create');
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        speechDiagnostic('ability.load_content.error', { code: err.code });
      } else {
        speechDiagnostic('ability.load_content.done');
      }
    });
  }
}
